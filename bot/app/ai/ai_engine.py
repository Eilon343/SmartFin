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
        lines = [f"*{self.title}*", "━━━━━━━━━━━━━━"]
        if self.http_code is not None:
            lines.append(f"• HTTP code: `{self.http_code}`")
        lines.append(f"• Cause: {self.detail}")
        if self.attempts:
            lines.append(f"• Retries: {self.attempts}/{_MAX_ATTEMPTS}")
        lines.append("━━━━━━━━━━━━━━")
        lines.append(_hint_for(self.category))
        return "\n".join(lines)


def _hint_for(category: str) -> str:
    return {
        "network":     "_Check the bot host's internet connection / DNS / outbound HTTPS to `generativelanguage.googleapis.com`._",
        "timeout":     "_The model didn't reply in 30s. Try again — if it persists, Gemini is under heavy load._",
        "auth":        "_Verify `GEMINI_API_KEY` in the bot env and that the key is still active in Google AI Studio._",
        "quota":       "_Daily/free-tier quota used up. Try tomorrow or upgrade the API key billing._",
        "rate_limit":  "_Too many requests in a short window. Wait a minute and try again._",
        "server":      "_Gemini is having an outage. Already retried — try again in a few minutes._",
        "model":       f"_Model `{_MODEL_NAME}` returned 404. Check the model name is still served on the v1beta endpoint._",
        "safety":      "_The model refused to answer due to its safety filter. Rephrase your message._",
        "empty":       "_The model returned no text. Usually transient — try again._",
        "parse":       "_The model returned text that isn't valid JSON. Try rephrasing more simply._",
        "bad_request": "_The request payload was rejected. This is likely a bug — check the logs._",
        "unknown":     "_See the bot logs for the full traceback._",
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

def _build_prompt(user_input: str, categories: list[str]) -> str:
    category_list = ", ".join(categories)
    return (
        "You are SmartFin's intent classifier. Read the user's message and "
        "return ONLY a valid JSON ARRAY of intent objects — no prose, no "
        "markdown fences, no trailing commentary.\n\n"
        f"User message: \"{user_input}\"\n"
        f"Valid expense categories: [{category_list}]\n\n"
        "Possible intents:\n"
        "  1. log_expense        — a purchase / spend\n"
        "  2. log_income         — money received (salary, freelance, bonus, refund)\n"
        "  3. log_subscription   — a recurring monthly charge to remember\n"
        "  4. financial_advice   — a question about the user's own finances\n"
        "  5. ERROR_UNSUPPORTED  — not personal-finance related at all\n\n"
        "Schemas (return one of these per array element):\n"
        "  log_expense:\n"
        "    {\"intent\":\"log_expense\",\"amount\":55.0,\"currency\":\"ILS\","
        "\"item\":\"shawarma\",\"category\":\"Food\",\"source\":\"bot\"}\n"
        "    • source=\"apple_pay\" iff the message starts with 'Apple pay transaction:' "
        "or explicitly mentions Apple Pay; otherwise source=\"bot\".\n"
        "    • category MUST be picked from the list above. If nothing fits, use null.\n"
        "    • Multiple expenses in one message (e.g. '7 on cola, 5 on gum') → one "
        "log_expense object per item.\n\n"
        "  log_income:\n"
        "    {\"intent\":\"log_income\",\"amount\":15000.0,\"currency\":\"ILS\","
        "\"source\":\"Salary\",\"income_type\":\"fixed\"}\n"
        "    • income_type=\"fixed\" for salary/rent; \"variable\" for "
        "freelance/bonus/overtime/gifts.\n\n"
        "  log_subscription:\n"
        "    {\"intent\":\"log_subscription\",\"amount\":39.90,\"currency\":\"ILS\","
        "\"name\":\"Netflix\",\"category\":\"Entertainment\",\"day\":15}\n"
        "    • day = day-of-month to charge, integer 1–28. Default 1.\n\n"
        "  financial_advice:\n"
        "    {\"intent\":\"financial_advice\",\"question\":\"Can I spend more on food?\","
        "\"timeframe\":\"current_month\",\"category\":\"Food\"}\n"
        "    • timeframe ∈ {current_month, last_month, last_3_months, this_year, all_time}; "
        "default current_month.\n"
        "    • category = a name from the list above if mentioned, else null.\n"
        "    • ANY question about budget, balance, ability to afford, or spending habits "
        "→ financial_advice (NEVER ERROR_UNSUPPORTED).\n"
        "    • Hebrew triggers that MUST classify as financial_advice include but are not "
        "limited to: 'מה נסגר עם הבזבוזים', 'כמה הלך לי החודש', 'איך אני עומד', "
        "'כמה בזבזתי', 'יש לי תקציב ל', 'אני יכול להרשות לעצמי'.\n\n"
        "  ERROR_UNSUPPORTED:\n"
        "    {\"intent\":\"ERROR_UNSUPPORTED\"}\n\n"
        "Rules:\n"
        "  • Output MUST be a JSON array, even with a single element.\n"
        "  • Unknown numeric fields → null (NOT 0, NOT \"\").\n"
        "  • Currency defaults to \"ILS\" unless the user explicitly names another currency.\n"
        "  • Preserve the user's wording for `item` / `source` / `name` (Hebrew stays Hebrew).\n"
        "  • Never invent amounts that the user didn't state."
    )


_ADVICE_SYSTEM_PROMPT = (
    "אתה SmartFin – יועץ פיננסי אישי, חד, ענייני וקצר. "
    "ענה תמיד בעברית, ללא הקדמות מנומסות, ללא אימוג'ים מיותרים, וללא חזרות. "
    "ה־JSON שמצורף בהודעת המשתמש הוא המקור היחיד לאמת – אל תמציא מספרים, "
    "תקציבים או קטגוריות שלא מופיעים בו.\n\n"
    "אם אין מספיק נתונים כדי לענות, אמור זאת בפירוש במשפט אחד והצע איזה נתון חסר.\n\n"
    "מבנה התשובה (חובה, בסדר הזה):\n"
    "1. שורת בוטום־ליין אחת – תשובה ישירה לשאלה (כן/לא, או הנתון המבוקש).\n"
    "2. עד שלושה בולטים קצרים עם הנתונים היבשים שעליהם נשענת התשובה "
    "(סכום, תקציב, יתרה, אחוזים).\n"
    "3. משפט אחד על קצב/השפעה – האם הקצב חורג מהממוצע, האם הרכישה משנה את התמונה.\n\n"
    "אורך מקסימלי: 6 שורות. בלי 'בוא נצלול', 'חבר!', 'בהצלחה!', וכד'."
)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def parse_input(user_input: str, categories: list[str]) -> list[dict]:
    prompt = _build_prompt(user_input, categories)

    def _call():
        return _get_client().models.generate_content(
            model=_MODEL_NAME,
            contents=prompt,
            config=types.GenerateContentConfig(
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
