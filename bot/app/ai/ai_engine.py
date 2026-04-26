import json
import os
import asyncio
from google import genai
from google.genai import types

_client = None

def _get_client():
    global _client
    if _client is None:
        _client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    return _client

def _build_prompt(user_input: str, categories: list[str]) -> str:
    category_list = ", ".join(categories)
    return (
        f"Extract expense details from the following message and return ONLY valid JSON.\n"
        f"Message: \"{user_input}\"\n"
        f"Valid categories: [{category_list}]\n"
        f"Return JSON with exactly these fields:\n"
        f"  amount   - numeric value (no currency symbol)\n"
        f"  currency - currency code, default \"ILS\" if not specified\n"
        f"  item     - short description of what was purchased\n"
        f"  category - one value from the valid categories list above\n"
        f"If a field cannot be determined, use null."
    )

async def parse_input(user_input: str, categories: list[str]) -> dict:
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

    response = await loop.run_in_executor(None, _call)
    return json.loads(response.text)
