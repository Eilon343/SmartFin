"""
Tests for bot/app/ai/ai_engine.py

Mocks the Gemini client entirely — no real API calls.
"""
import json
import pytest
from unittest.mock import MagicMock, patch, AsyncMock

from app.ai.ai_engine import parse_input, _build_prompt

CATEGORIES = ["Food", "Transport", "Housing", "Entertainment", "Shopping", "Utilities", "Health", "Other"]


def _mock_response(payload: dict) -> MagicMock:
    r = MagicMock()
    r.text = json.dumps(payload)
    return r


# ── Prompt content ────────────────────────────────────────────────────────────

class TestBuildPrompt:
    def test_contains_all_intents(self):
        prompt = _build_prompt("test", CATEGORIES)
        assert "log_expense" in prompt
        assert "log_income" in prompt
        assert "log_subscription" in prompt
        assert "ERROR_UNSUPPORTED" in prompt

    def test_contains_income_type_guidance(self):
        prompt = _build_prompt("test", CATEGORIES)
        assert "fixed" in prompt
        assert "variable" in prompt

    def test_contains_user_categories(self):
        prompt = _build_prompt("test", ["Food", "Gym"])
        assert "Food" in prompt
        assert "Gym" in prompt

    def test_message_is_embedded(self):
        prompt = _build_prompt("55 shawarma", CATEGORIES)
        assert "55 shawarma" in prompt

    def test_day_range_mentioned_for_subscriptions(self):
        prompt = _build_prompt("test", CATEGORIES)
        assert "1–28" in prompt or "1-28" in prompt


# ── Intent routing ────────────────────────────────────────────────────────────

class TestParseInputIntents:
    @pytest.mark.asyncio
    async def test_expense_english(self):
        payload = {"intent": "log_expense", "amount": 55.0, "currency": "ILS", "item": "shawarma", "category": "Food", "source": "bot"}
        with patch("app.ai.ai_engine._get_client") as mock:
            mock.return_value.models.generate_content.return_value = _mock_response(payload)
            result = await parse_input("55 shekel shawarma", CATEGORIES)
        assert result["intent"] == "log_expense"
        assert result["amount"] == 55.0
        assert result["category"] == "Food"

    @pytest.mark.asyncio
    async def test_expense_hebrew(self):
        payload = {"intent": "log_expense", "amount": 30.0, "currency": "ILS", "item": "coffee", "category": "Food", "source": "bot"}
        with patch("app.ai.ai_engine._get_client") as mock:
            mock.return_value.models.generate_content.return_value = _mock_response(payload)
            result = await parse_input("30 שקל קפה", CATEGORIES)
        assert result["intent"] == "log_expense"
        assert result["amount"] == 30.0

    @pytest.mark.asyncio
    async def test_variable_income_table_sale(self):
        """Core use case: 'הכנסתי 800 שקל במכירת שולחן' → variable income"""
        payload = {"intent": "log_income", "amount": 800.0, "currency": "ILS", "source": "Table sale", "income_type": "variable"}
        with patch("app.ai.ai_engine._get_client") as mock:
            mock.return_value.models.generate_content.return_value = _mock_response(payload)
            result = await parse_input("הכנסתי 800 שקל במכירת שולחן", CATEGORIES)
        assert result["intent"] == "log_income"
        assert result["amount"] == 800.0
        assert result["income_type"] == "variable"

    @pytest.mark.asyncio
    async def test_fixed_income_salary(self):
        payload = {"intent": "log_income", "amount": 15000.0, "currency": "ILS", "source": "Salary", "income_type": "fixed"}
        with patch("app.ai.ai_engine._get_client") as mock:
            mock.return_value.models.generate_content.return_value = _mock_response(payload)
            result = await parse_input("got salary 15000", CATEGORIES)
        assert result["intent"] == "log_income"
        assert result["income_type"] == "fixed"

    @pytest.mark.asyncio
    async def test_subscription(self):
        payload = {"intent": "log_subscription", "amount": 39.90, "currency": "ILS", "name": "Netflix", "category": "Entertainment", "day": 15}
        with patch("app.ai.ai_engine._get_client") as mock:
            mock.return_value.models.generate_content.return_value = _mock_response(payload)
            result = await parse_input("add Netflix 39.90 monthly on the 15th", CATEGORIES)
        assert result["intent"] == "log_subscription"
        assert result["day"] == 15

    @pytest.mark.asyncio
    async def test_unsupported_returns_error_intent(self):
        payload = {"intent": "ERROR_UNSUPPORTED"}
        with patch("app.ai.ai_engine._get_client") as mock:
            mock.return_value.models.generate_content.return_value = _mock_response(payload)
            result = await parse_input("what is the weather today?", CATEGORIES)
        assert result["intent"] == "ERROR_UNSUPPORTED"

    @pytest.mark.asyncio
    async def test_apple_pay_source_detected(self):
        payload = {"intent": "log_expense", "amount": 120.0, "currency": "ILS", "item": "Supermarket", "category": "Shopping", "source": "apple_pay"}
        with patch("app.ai.ai_engine._get_client") as mock:
            mock.return_value.models.generate_content.return_value = _mock_response(payload)
            result = await parse_input("Apple Pay transaction: 120 ILS at Supermarket", CATEGORIES)
        assert result["source"] == "apple_pay"


# ── Retry logic ───────────────────────────────────────────────────────────────

class TestRetryLogic:
    @pytest.mark.asyncio
    async def test_retries_on_503_and_succeeds_on_third_attempt(self):
        good_response = _mock_response({"intent": "log_expense", "amount": 55.0, "currency": "ILS", "item": "coffee", "category": "Food", "source": "bot"})
        call_count = 0

        def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise Exception("503 UNAVAILABLE - high demand")
            return good_response

        with patch("app.ai.ai_engine._get_client") as mock_client, \
             patch("asyncio.sleep", new_callable=AsyncMock):
            mock_client.return_value.models.generate_content.side_effect = side_effect
            result = await parse_input("coffee 55", CATEGORIES)

        assert call_count == 3
        assert result["intent"] == "log_expense"

    @pytest.mark.asyncio
    async def test_retries_on_429_rate_limit(self):
        good_response = _mock_response({"intent": "ERROR_UNSUPPORTED"})
        call_count = 0

        def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise Exception("429 RESOURCE_EXHAUSTED - quota exceeded")
            return good_response

        with patch("app.ai.ai_engine._get_client") as mock_client, \
             patch("asyncio.sleep", new_callable=AsyncMock):
            mock_client.return_value.models.generate_content.side_effect = side_effect
            result = await parse_input("hello", CATEGORIES)

        assert call_count == 2

    @pytest.mark.asyncio
    async def test_raises_after_3_failed_attempts(self):
        def side_effect(*args, **kwargs):
            raise Exception("503 UNAVAILABLE")

        with patch("app.ai.ai_engine._get_client") as mock_client, \
             patch("asyncio.sleep", new_callable=AsyncMock):
            mock_client.return_value.models.generate_content.side_effect = side_effect
            with pytest.raises(Exception, match="503"):
                await parse_input("coffee 55", CATEGORIES)

    @pytest.mark.asyncio
    async def test_non_retryable_error_raises_immediately(self):
        """JSON decode error should not retry — it's a prompt/logic bug not transient."""
        call_count = 0

        def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            raise ValueError("Some non-retryable error")

        with patch("app.ai.ai_engine._get_client") as mock_client:
            mock_client.return_value.models.generate_content.side_effect = side_effect
            with pytest.raises(ValueError):
                await parse_input("coffee", CATEGORIES)

        assert call_count == 1  # no retry for non-503/429 errors

    @pytest.mark.asyncio
    async def test_sleep_called_between_retries(self):
        good = _mock_response({"intent": "ERROR_UNSUPPORTED"})
        call_count = 0

        def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise Exception("503 UNAVAILABLE")
            return good

        with patch("app.ai.ai_engine._get_client") as mock_client, \
             patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            mock_client.return_value.models.generate_content.side_effect = side_effect
            await parse_input("test", CATEGORIES)

        mock_sleep.assert_called_once_with(2)  # 2 * attempt (attempt=1)


# ── JSON parsing edge cases ───────────────────────────────────────────────────

class TestJsonParsing:
    @pytest.mark.asyncio
    async def test_null_fields_allowed(self):
        payload = {"intent": "log_expense", "amount": 55.0, "currency": "ILS", "item": None, "category": None, "source": "bot"}
        with patch("app.ai.ai_engine._get_client") as mock:
            mock.return_value.models.generate_content.return_value = _mock_response(payload)
            result = await parse_input("55 something", CATEGORIES)
        assert result["item"] is None

    @pytest.mark.asyncio
    async def test_raises_on_invalid_json_response(self):
        bad = MagicMock()
        bad.text = "not json at all"
        with patch("app.ai.ai_engine._get_client") as mock:
            mock.return_value.models.generate_content.return_value = bad
            with pytest.raises(Exception):
                await parse_input("test", CATEGORIES)
