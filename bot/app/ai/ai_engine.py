import json
import os
import asyncio
import logging
import socket

import httpx
import requests
from google import genai
from google.genai import types, errors as genai_errors
from google.api_core import exceptions as google_exceptions

logger = logging.getLogger(__name__)

_client = None

# How long a single Gemini call may take before we abort it.
_REQUEST_TIMEOUT_SEC = 30
_MAX_ATTEMPTS = 3
_MODEL_NAME = "gemini-2.5-flash"


# ---------------------------------------------------------------------------
# Structured error type
# ---------------------------------------------------------------------------

class AIEngineError(Exception):
    """Rich error raised by the AI engine.

    `category` is a short machine code so callers can branch on it; `title`
    and `detail` are human-readable strings safe to show to the end user.
    """

    USER_TITLES = {
        "network":     "🌐 Network problem reaching Gemini",
        "timeout":     "⏱️ Gemini took too long to respond",
        "auth":        "🔑 Gemini rejected the API key",
        "quota":       "📉 Gemini quota exhausted on this key",
        "rate_limit":  "🚦 Gemini is rate-limiting us",
        "server":      "🛠️ Gemini server error",
        "model":       "🤖 Gemini model is unavailable",
        "safety":      "🛡️ Gemini blocked the response (safety filter)",
        "empty":       "📭 Gemini returned an empty response",
        "parse":       "🧩 Gemini returned malformed JSON",
        "bad_request": "❗ Gemini rejected the request",
        "unknown":     "❌ Unexpected AI engine error",
    }

    def __init__(self, category: str, detail: str, *, http_code: int | None = None,
                 attempts: int | None = None, original: BaseException | None = None):
        self.category = category
        self.detail = detail
        self.http_code = http_code
        self.attempts = attempts
        self.original = original
        super().__init__(f"[{category}] {detail}")

    @property
    def title(self) -> str:
        return self.USER_TITLES.get(self.category, self.USER_TITLES["unknown"])

    def telegram_message(self) -> str:
        """Plain-text (no Markdown) so Telegram never rejects the message on
        unescaped underscores or asterisks coming from Gemini's error detail
        (e.g. RESOURCE_EXHAUSTED, models/gemini-2.5-flash, GEMINI_API_KEY)."""
        lines = [self.title, "━━━━━━━━━━━━━━"]
        if self.http_code is not None:
            lines.append(f"• HTTP code: {self.http_code}")
        lines.append(f"• Cause: {self.detail}")
        if self.attempts:
            lines.append(f"• Retries: {self.attempts}/{_MAX_ATTEMPTS}")
        lines.append("━━━━━━━━━━━━━━")
        hint = _hint_for(self.category)
        if hint:
            lines.append(hint)
        return "\n".join(lines)


def _hint_for(category: str) -> str:
    return {
        "network":     "Hint: check the bot host's internet connection / DNS / outbound HTTPS to generativelanguage.googleapis.com.",
        "timeout":     "Hint: the model didn't reply in 30s. Try again — if it persists, Gemini is under heavy load.",
        "auth":        "Hint: verify GEMINI_API_KEY in the bot env and that the key is still active in Google AI Studio.",
        "quota":       "Hint: daily/free-tier quota used up. Try tomorrow or upgrade the API key billing.",
        "rate_limit":  "Hint: too many requests in a short window. Wait a minute and try again.",
        "server":      "Hint: Gemini is having an outage. Already retried — try again in a few minutes.",
        "model":       f"Hint: model {_MODEL_NAME} returned 404. Check the model name is still served on the v1beta endpoint.",
        "safety":      "Hint: the model refused to answer due to its safety filter. Rephrase your message.",
        "empty":       "Hint: the model returned no text. Usually transient — try again.",
        "parse":       "Hint: the model returned text that isn't valid JSON. Try rephrasing more simply.",
        "bad_request": "Hint: the request payload was rejected. This is likely a bug — check the logs.",
        "unknown":     "Hint: see the bot logs for the full traceback.",
    }.get(category, "")


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------

def _classify(exc: BaseException, attempts: int) -> "AIEngineError":
    """Translate an arbitrary exception coming out of the Gemini SDK into an
    AIEngineError with a category we can show to the user."""

    # SDK-level API errors
    if isinstance(exc, genai_errors.APIError):
        code = exc.code
        msg = (exc.message or str(getattr(exc, "details", "")) or "").strip()
        low = msg.lower()
        if code in (401, 403):
            return AIEngineError("auth", msg or "authentication failed",
                                 http_code=code, attempts=attempts, original=exc)
        if code == 404:
            return AIEngineError("model", msg or "model not found",
                                 http_code=code, attempts=attempts, original=exc)
        if code == 429:
            cat = "quota" if "quota" in low or "exhausted" in low else "rate_limit"
            return AIEngineError(cat, msg or "rate limited",
                                 http_code=code, attempts=attempts, original=exc)
        if 400 <= code < 500:
            return AIEngineError("bad_request", msg or "bad request",
                                 http_code=code, attempts=attempts, original=exc)
        if 500 <= code < 600:
            return AIEngineError("server", msg or "server error",
                                 http_code=code, attempts=attempts, original=exc)

    # google-api-core fallback (some paths still raise these)
    if isinstance(exc, google_exceptions.ResourceExhausted):
        return AIEngineError("quota", str(exc) or "resource exhausted",
                             http_code=429, attempts=attempts, original=exc)
    if isinstance(exc, google_exceptions.ServiceUnavailable):
        return AIEngineError("server", str(exc) or "service unavailable",
                             http_code=503, attempts=attempts, original=exc)
    if isinstance(exc, google_exceptions.DeadlineExceeded):
        return AIEngineError("timeout", "Gemini deadline exceeded",
                             attempts=attempts, original=exc)
    if isinstance(exc, google_exceptions.Unauthenticated):
        return AIEngineError("auth", str(exc) or "unauthenticated",
                             http_code=401, attempts=attempts, original=exc)

    # Network / transport errors
    if isinstance(exc, (asyncio.TimeoutError, httpx.TimeoutException,
                        requests.exceptions.Timeout)):
        return AIEngineError("timeout", f"request timed out after {_REQUEST_TIMEOUT_SEC}s",
                             attempts=attempts, original=exc)
    if isinstance(exc, (httpx.ConnectError, requests.exceptions.ConnectionError,
                        socket.gaierror)):
        return AIEngineError("network", f"connection failed: {exc!s}",
                             attempts=attempts, original=exc)
    if isinstance(exc, httpx.HTTPError):
        return AIEngineError("network", f"HTTP transport error: {exc!s}",
                             attempts=attempts, original=exc)

    # JSON parsing
    if isinstance(exc, json.JSONDecodeError):
        return AIEngineError("parse", f"invalid JSON at pos {exc.pos}: {exc.msg}",
                             attempts=attempts, original=exc)

    # Best-effort string fallback for generic exceptions whose message carries
    # a known Google status code.
    text = str(exc)
    low = text.lower()
    if "503" in text or "unavailable" in low or "overloaded" in low:
        return AIEngineError("server", text or "service unavailable",
                             http_code=503, attempts=attempts, original=exc)
    if "429" in text or "resource_exhausted" in low or "rate limit" in low:
        cat = "quota" if "quota" in low or "exhausted" in low else "rate_limit"
        return AIEngineError(cat, text or "rate limited",
                             http_code=429, attempts=attempts, original=exc)
    if "401" in text or "unauthenticated" in low or "api key" in low:
        return AIEngineError("auth", text or "authentication failed",
                             http_code=401, attempts=attempts, original=exc)
    if "404" in text and ("model" in low or "not found" in low):
        return AIEngineError("model", text, http_code=404,
                             attempts=attempts, original=exc)

    return AIEngineError("unknown", f"{type(exc).__name__}: {exc}",
                         attempts=attempts, original=exc)


def _is_retryable(err: "AIEngineError") -> bool:
    return err.category in {"server", "rate_limit", "timeout", "network", "empty"}


def _safety_error(response) -> "AIEngineError | None":
    """Detect Gemini safety blocks. Returns an AIEngineError or None."""
    try:
        pf = getattr(response, "prompt_feedback", None)
        block_reason = getattr(pf, "block_reason", None) if pf else None
        if block_reason:
            return AIEngineError("safety", f"prompt blocked: {block_reason}")
        candidates = getattr(response, "candidates", None) or []
        if candidates:
            fr = getattr(candidates[0], "finish_reason", None)
            if fr and str(fr).upper().endswith("SAFETY"):
                return AIEngineError("safety", "response blocked by safety filter")
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Client + low-level call
# ---------------------------------------------------------------------------

def _get_client():
    global _client
    if _client is None:
        key = os.getenv("GEMINI_API_KEY")
        if not key:
            raise AIEngineError("auth", "GEMINI_API_KEY environment variable is not set")
        _client = genai.Client(api_key=key)
    return _client


async def _run_with_retries(call):
    """Run a blocking SDK call in a thread, with timeout + retry/backoff,
    converting every failure into an AIEngineError."""
    loop = asyncio.get_event_loop()
    last_err: AIEngineError | None = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = await asyncio.wait_for(
                loop.run_in_executor(None, call),
                timeout=_REQUEST_TIMEOUT_SEC,
            )
        except AIEngineError:
            raise
        except BaseException as e:
            last_err = _classify(e, attempts=attempt)
            logger.warning("Gemini call failed (attempt %d/%d, category=%s): %s",
                           attempt, _MAX_ATTEMPTS, last_err.category, last_err.detail)
            if attempt < _MAX_ATTEMPTS and _is_retryable(last_err):
                await asyncio.sleep(2 * attempt)
                continue
            raise last_err

        safety = _safety_error(response)
        if safety:
            raise safety
        return response

    raise last_err or AIEngineError("unknown", "no response after retries")


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
#
# Both prompts are split into a STATIC system_instruction (sent as a cache-
# friendly prefix on every call) and a small DYNAMIC user-role payload that
# carries the per-request data. Gemini 2.5 Flash applies implicit prompt
# caching automatically when the prefix is ≥1024 tokens and is repeated
# across calls within the cache window, which gives us ~75% discount on
# those prefix tokens with zero cache-management code on our side. The two
# system prompts below are deliberately substantial — every example earns
# its keep both as a quality lever and by pushing the prefix above the
# caching threshold.

_INTENT_SYSTEM_PROMPT = """\
You are SmartFin's intent classifier. Read the user's message and return
ONLY a valid JSON ARRAY of intent objects — no prose, no markdown fences,
no trailing commentary, no leading whitespace.

The user message and the user's personal category list are provided in the
user turn that follows this instruction. They are the ONLY per-call inputs.
Everything else (the schemas, rules, and examples below) is constant across
every request — do not restate it, just apply it.

INTENTS
  1. log_expense        — a purchase / spend the user made.
  2. log_income         — money received (salary, freelance, bonus, refund,
                          gift, sale).
  3. log_subscription   — a recurring monthly charge to remember.
  4. financial_advice   — a question about the user's own finances,
                          spending, budget, balance, or ability to afford.
  5. ERROR_UNSUPPORTED  — not personal-finance related at all (weather,
                          sports, jokes, general knowledge).

SCHEMAS (return one of these per array element)

  log_expense:
    {"intent":"log_expense","amount":55.0,"currency":"ILS",
     "item":"shawarma","category":"Food","source":"bot"}
    • source="apple_pay" iff the message starts with 'Apple pay transaction:'
      OR explicitly mentions Apple Pay; otherwise source="bot".
    • category MUST be picked from the user's category list. If nothing fits,
      use null — never invent a new category name.
    • Multiple expenses in one message ("7 on cola, 5 on gum") → one
      log_expense object per item.
    • Preserve the user's wording for `item` (Hebrew stays Hebrew).

  log_income:
    {"intent":"log_income","amount":15000.0,"currency":"ILS",
     "source":"Salary","income_type":"fixed"}
    • income_type="fixed" for salary, rent income, pension.
    • income_type="variable" for freelance, bonus, overtime, gifts, refunds,
      one-off sales.

  log_subscription:
    {"intent":"log_subscription","amount":39.90,"currency":"ILS",
     "name":"Netflix","category":"Entertainment","day":15}
    • day = day-of-month to charge, integer 1–28 only. Default 1.
    • name preserves the user's casing/language.

  financial_advice:
    {"intent":"financial_advice","question":"Can I spend more on food?",
     "timeframe":"current_month","category":"Food"}
    • timeframe ∈ {current_month, last_month, last_3_months, this_year,
      all_time}. Default current_month when not stated.
    • category = a name from the user's category list if a specific category
      is mentioned, else null.
    • ANY question about budget, balance, ability to afford, spending
      habits, or "where did my money go" → financial_advice. NEVER classify
      such questions as ERROR_UNSUPPORTED.

  ERROR_UNSUPPORTED:
    {"intent":"ERROR_UNSUPPORTED"}

GLOBAL RULES
  • Output MUST be a JSON array, even if there is exactly one element.
  • Unknown numeric fields → null (NOT 0, NOT empty string).
  • Currency defaults to "ILS" unless the user explicitly names another
    currency (USD, EUR, GBP, …).
  • Never invent amounts that the user did not state.
  • Hebrew, English, and mixed-language messages are all valid input.

LANGUAGE TRIGGERS — financial_advice (non-exhaustive)
  Hebrew: "מה נסגר עם הבזבוזים", "כמה הלך לי החודש", "איך אני עומד",
          "כמה בזבזתי", "יש לי תקציב ל…", "אני יכול להרשות לעצמי",
          "כמה יצא לי על…", "מה המצב", "כמה נשאר לי", "האם אני בחריגה".
  English: "how much did I spend", "can I afford", "am I over budget",
           "what's left for", "how am I doing this month".

WORKED EXAMPLES (do not echo these — they show the expected mapping)

  Input:  "55 shawarma"
  Output: [{"intent":"log_expense","amount":55.0,"currency":"ILS",
            "item":"shawarma","category":"Food","source":"bot"}]

  Input:  "7 on cola, 5 on gum"
  Output: [{"intent":"log_expense","amount":7.0,"currency":"ILS",
            "item":"cola","category":"Food","source":"bot"},
           {"intent":"log_expense","amount":5.0,"currency":"ILS",
            "item":"gum","category":"Food","source":"bot"}]

  Input:  "Apple pay transaction: 120 ILS at Supermarket"
  Output: [{"intent":"log_expense","amount":120.0,"currency":"ILS",
            "item":"Supermarket","category":"Food","source":"apple_pay"}]

  Input:  "got salary 15000"
  Output: [{"intent":"log_income","amount":15000.0,"currency":"ILS",
            "source":"Salary","income_type":"fixed"}]

  Input:  "freelance gig paid 2300"
  Output: [{"intent":"log_income","amount":2300.0,"currency":"ILS",
            "source":"Freelance","income_type":"variable"}]

  Input:  "add Netflix 39.90 monthly on the 15th"
  Output: [{"intent":"log_subscription","amount":39.90,"currency":"ILS",
            "name":"Netflix","category":"Entertainment","day":15}]

  Input:  "כמה בזבזתי החודש על אוכל"
  Output: [{"intent":"financial_advice",
            "question":"כמה בזבזתי החודש על אוכל",
            "timeframe":"current_month","category":"Food"}]

  Input:  "מה נסגר עם הבזבוזים שלי"
  Output: [{"intent":"financial_advice",
            "question":"מה נסגר עם הבזבוזים שלי",
            "timeframe":"current_month","category":null}]

  Input:  "can I afford a 500 ILS dinner tonight"
  Output: [{"intent":"financial_advice",
            "question":"can I afford a 500 ILS dinner tonight",
            "timeframe":"current_month","category":"Food"}]

  Input:  "compare my spending this year vs last year"
  Output: [{"intent":"financial_advice",
            "question":"compare my spending this year vs last year",
            "timeframe":"this_year","category":null}]

  Input:  "what's the weather today"
  Output: [{"intent":"ERROR_UNSUPPORTED"}]

  Input:  "tell me a joke"
  Output: [{"intent":"ERROR_UNSUPPORTED"}]
"""


_ADVICE_SYSTEM_PROMPT = """\
אתה SmartFin – יועץ פיננסי אישי, חד, ענייני וקצר. ענה תמיד בעברית.

מקור האמת היחיד שלך הוא ה־JSON שצורף בהודעת המשתמש. השדות שעשויים
להופיע: spending_by_category, total_spending, all_active_budgets,
monthly_history, period, timeframe, previous_months_avg,
previous_months_count, scoped_to_category.

חשוב לדעת:
  • spending_by_category לא כולל קטגוריות שבהן לא בוצעה הוצאה בתקופה –
    היעדר קטגוריה משמעו אפס הוצאות, לא נתון חסר.
  • all_active_budgets מצומצם לתקציב הרלוונטי בלבד אם scoped_to_category
    קיים – אל תסיק שאין למשתמש תקציבים אחרים.
  • monthly_history מוגבל ל־6 החודשים האחרונים. כל מה שקדם להם נדחס
    ל־previous_months_avg (ממוצע חודשי) ו־previous_months_count (כמה
    חודשים נדחסו). השתמש בשני אלו כשמשווים לטווח ארוך.

אל תמציא מספרים, תקציבים, קטגוריות, או תאריכים שאינם מופיעים. אם נתון
חסר, אמור זאת במשפט אחד והצע מה לבדוק, ואל תנחש.

סגנון:
  • בלי הקדמות מנומסות ("חבר!", "בוא נצלול", "בהצלחה!").
  • בלי חזרות על השאלה.
  • בלי אימוג'ים מיותרים – לכל היותר אחד כדי להדגיש כיוון (✅ / ⚠️).
  • שפה ישירה, גוף שני, זמן הווה.
  • אורך מקסימלי: 6 שורות. אם אפשר ב־3 – עדיף.

מבנה התשובה (חובה, בסדר הזה):
  1. שורת בוטום־ליין – תשובה ישירה אחת לשאלה (כן/לא, או הנתון המבוקש).
  2. עד שלושה בולטים קצרים עם הנתונים היבשים שעליהם נשענת התשובה
     (סכום שהוצא, תקציב, יתרה, אחוז ניצול). השתמש בסימן ₪ ובעיגול
     לשלם הקרוב או לשתי ספרות לכל היותר.
  3. משפט אחד על קצב או השפעה – האם הקצב חורג מהממוצע של החודשים
     הקודמים (monthly_history), האם הרכישה הצפויה משנה את התמונה,
     או כמה ימים נשארו בחודש ביחס לקצב הנוכחי.

חישובים מותרים (רק על בסיס ה־JSON):
  • יתרה = monthly_limit − spent_in_category.
  • אחוז ניצול = spent_in_category / monthly_limit * 100.
  • קצב יומי = total_spending / יום הבחודש (אם השדה period מכיל את התאריך).
  • ממוצע חודשי = ממוצע של monthly_history (אם קיים).

דוגמאות לסגנון תשובה:

  שאלה: "אני יכול להוציא עוד 200 על אוכל?"
  תשובה לדוגמה:
    כן, יש לך מקום.
    • אוכל החודש: ₪780 מתוך תקציב ₪1,200 (65%).
    • הוצאה נוספת של ₪200 → ₪980 (82%).
    אתה עדיין בתוך התקציב, אבל מתקרב לגבול – שים לב לשבועיים הקרובים.

  שאלה: "כמה בזבזתי החודש?"
  תשובה לדוגמה:
    סך ההוצאות החודש: ₪4,320.
    • שלוש הקטגוריות הגדולות: אוכל ₪1,150, דיור ₪2,000, פנאי ₪430.
    • ממוצע החודשים הקודמים: ₪4,050.
    אתה ב־+7% מעל הממוצע – לא חריגה משמעותית.

  שאלה: "איך אני עומד מול התקציב?"
  תשובה לדוגמה (כשאין תקציבים):
    אין לי נתוני תקציב לקטגוריות שלך.
    הגדר תקציב חודשי לכל קטגוריה כדי שאוכל לענות על השאלה הזו.

מה אסור:
  • אל תמליץ על מוצרים פיננסיים חיצוניים (קרנות, מניות, ביטוחים).
  • אל תוסיף "אזהרות משפטיות" או disclaimers.
  • אל תסביר את עצמך ("הסיבה שאני אומר ככה היא…") – פשוט תן את התשובה.
  • אל תחזור על תוכן ה־JSON כשאין בו רלוונטיות לשאלה.
"""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _build_prompt(user_input: str, categories: list[str]) -> str:
    """Back-compat shim: returns the full prompt (static instructions +
    dynamic user payload) as one string. Live code paths use the split
    system_instruction + user contents form; this exists for older tests
    and for ad-hoc debugging."""
    return _INTENT_SYSTEM_PROMPT + "\n\n" + _build_intent_user_message(user_input, categories)


def _build_intent_user_message(user_input: str, categories: list[str]) -> str:
    """Per-request dynamic payload for the intent classifier. Kept tiny so
    the cache-friendly static prefix (system_instruction) dominates."""
    return (
        f"User's categories: [{', '.join(categories)}]\n"
        f"User message: \"{user_input}\""
    )


async def parse_input(user_input: str, categories: list[str]) -> list[dict]:
    user_message = _build_intent_user_message(user_input, categories)

    def _call():
        return _get_client().models.generate_content(
            model=_MODEL_NAME,
            contents=user_message,
            config=types.GenerateContentConfig(
                system_instruction=_INTENT_SYSTEM_PROMPT,
                response_mime_type="application/json",
            ),
        )

    response = await _run_with_retries(_call)
    text = (getattr(response, "text", None) or "").strip()
    if not text:
        raise AIEngineError("empty", "model returned no text")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        raise _classify(e, attempts=1) from e
    return [parsed] if isinstance(parsed, dict) else parsed


async def generate_financial_advice(question: str, context_data: dict) -> str:
    user_message = (
        f"Context (JSON): {json.dumps(context_data, ensure_ascii=False)}\n\n"
        f"Question: {question}"
    )

    def _call():
        return _get_client().models.generate_content(
            model=_MODEL_NAME,
            contents=[types.Content(role="user", parts=[types.Part(text=user_message)])],
            config=types.GenerateContentConfig(
                system_instruction=_ADVICE_SYSTEM_PROMPT,
            ),
        )

    response = await _run_with_retries(_call)
    text = (getattr(response, "text", None) or "").strip()
    if not text:
        raise AIEngineError("empty", "model returned no advice text")
    return text
