import json
import os
import asyncio
from google import genai
from google.genai import types, errors as genai_errors
from google.api_core import exceptions as google_exceptions

_client = None

def _get_client():
    global _client
    if _client is None:
        _client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    return _client

def _build_prompt(user_input: str, categories: list[str]) -> str:
    category_list = ", ".join(categories)
    return (
        f"Analyze this message and extract ALL financial intents. Return ONLY a valid JSON ARRAY of objects.\n"
        f"Message: \"{user_input}\"\n"
        f"Valid expense categories: [{category_list}]\n\n"
        f"Possible intents:\n"
        f"1. log_expense  - user is logging a purchase or expense\n"
        f"2. log_income   - user is reporting received money (salary, freelance, bonus, etc.)\n"
        f"3. log_subscription - user wants to add a recurring monthly charge\n"
        f"4. ERROR_UNSUPPORTED - message is not related to personal finance\n\n"
        f"Return an array with one or more of these JSON shapes:\n\n"
        f"log_expense:\n"
        f"  {{\"intent\":\"log_expense\",\"amount\":55.0,\"currency\":\"ILS\",\"item\":\"shawarma\",\"category\":\"Food\",\"source\":\"bot\"}}\n"
        f"  If the message starts with 'Apple pay transaction:' or mentions Apple Pay, set source to \"apple_pay\", otherwise \"bot\".\n\n"
        f"log_income:\n"
        f"  {{\"intent\":\"log_income\",\"amount\":15000.0,\"currency\":\"ILS\",\"source\":\"Salary\",\"income_type\":\"fixed\"}}\n"
        f"  income_type is \"fixed\" for salary/rent; \"variable\" for freelance/bonus/overtime\n\n"
        f"log_subscription:\n"
        f"  {{\"intent\":\"log_subscription\",\"amount\":39.90,\"currency\":\"ILS\",\"name\":\"Netflix\",\"category\":\"Entertainment\",\"day\":15}}\n"
        f"  day = day of month to charge (default 1 if not specified, must be 1–28)\n\n"
        f"ERROR_UNSUPPORTED:\n"
        f"  {{\"intent\":\"ERROR_UNSUPPORTED\"}}\n\n"
        f"Use null for any field that cannot be determined. "
        f"You MUST return an array, even if there is only one intent. If there are multiple expenses in one message (e.g. '7 on cola, 5 on gum'), return an array of multiple log_expense objects."
    )

async def parse_input(user_input: str, categories: list[str]) -> list[dict]:
    loop = asyncio.get_event_loop()
    prompt = _build_prompt(user_input, categories)

    def _call():
        return _get_client().models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json"
            ),
        )

    for attempt in range(1, 4):
        try:
            response = await loop.run_in_executor(None, _call)
            parsed = json.loads(response.text)
            return [parsed] if isinstance(parsed, dict) else parsed
        except (
            google_exceptions.ResourceExhausted,
            google_exceptions.ServiceUnavailable,
            genai_errors.ServerError,
        ):
            if attempt < 3:
                await asyncio.sleep(2 * attempt)
                continue
            raise
