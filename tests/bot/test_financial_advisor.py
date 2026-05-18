"""
Tests for the Conversational Financial Advisor feature.

Covers:
  - ai_engine.py  : _build_prompt includes financial_advice intent;
                    generate_financial_advice calls Gemini with Hebrew system prompt
  - DatabaseManager.py : get_dynamic_financial_context — date resolution, SQL logic, return shape
  - handlers.py   : financial_advice intent routing, happy path, error recovery,
                    regression that unrelated prompts stay in ERROR_UNSUPPORTED
"""
import json
import pytest
from datetime import date
from unittest.mock import AsyncMock, MagicMock, patch, call


# ── Helpers shared by multiple test classes ────────────────────────────────────

def _make_message(text: str, user_id: int = 938418219) -> MagicMock:
    msg = MagicMock()
    msg.text = text
    msg.from_user = MagicMock()
    msg.from_user.id = user_id
    msg.from_user.username = "testuser"
    msg.reply = AsyncMock()
    return msg


def _make_state() -> MagicMock:
    state = AsyncMock()
    state.set_state = AsyncMock()
    state.update_data = AsyncMock()
    state.get_data = AsyncMock()
    state.clear = AsyncMock()
    return state


def _make_db(
    *,
    user_exists: bool = True,
    categories=None,
    budget=None,
    spending=0.0,
    dynamic_context: dict | None = None,
) -> MagicMock:
    db = AsyncMock()
    db.user_exists = AsyncMock(return_value=user_exists)
    db.ensure_user = AsyncMock()
    db.get_user_categories = AsyncMock(return_value=categories or ["Food", "Transport", "Shopping", "Entertainment", "Other"])
    db.get_category_budget = AsyncMock(return_value=budget)
    db.get_category_spending = AsyncMock(return_value=spending)
    db.add_expense = AsyncMock(return_value=True)
    db.get_dynamic_financial_context = AsyncMock(return_value=dynamic_context or {})
    return db


def _gemini_text_response(text: str) -> MagicMock:
    r = MagicMock()
    r.text = text
    return r


CATEGORIES = ["Food", "Transport", "Shopping", "Entertainment", "Housing", "Other"]


# ── 1. Prompt builder ──────────────────────────────────────────────────────────

class TestBuildPromptFinancialAdvice:
    """Verify _build_prompt includes the financial_advice intent and its fields."""

    def test_financial_advice_intent_present(self):
        from app.ai.ai_engine import _build_prompt
        prompt = _build_prompt("test", CATEGORIES)
        assert "financial_advice" in prompt

    def test_timeframe_options_documented_in_prompt(self):
        """All five timeframe values must appear so the model knows its choices."""
        from app.ai.ai_engine import _build_prompt
        prompt = _build_prompt("test", CATEGORIES)
        for tf in ("current_month", "last_month", "last_3_months", "this_year", "all_time"):
            assert tf in prompt, f"timeframe '{tf}' missing from prompt"

    def test_financial_advice_example_shape_in_prompt(self):
        """Prompt must show the expected JSON shape including question + timeframe + category."""
        from app.ai.ai_engine import _build_prompt
        prompt = _build_prompt("test", CATEGORIES)
        assert '"question"' in prompt
        assert '"timeframe"' in prompt
        assert '"category"' in prompt

    def test_financial_advice_listed_before_error_unsupported(self):
        """financial_advice must be routed before ERROR_UNSUPPORTED so questions
        aren't mis-classified as unsupported."""
        from app.ai.ai_engine import _build_prompt
        prompt = _build_prompt("test", CATEGORIES)
        assert prompt.index("financial_advice") < prompt.index("ERROR_UNSUPPORTED")

    def test_original_intents_still_present(self):
        """Adding the new intent must not break existing ones."""
        from app.ai.ai_engine import _build_prompt
        prompt = _build_prompt("test", CATEGORIES)
        for intent in ("log_expense", "log_income", "log_subscription", "ERROR_UNSUPPORTED"):
            assert intent in prompt


# ── 2. generate_financial_advice ──────────────────────────────────────────────

class TestGenerateFinancialAdvice:
    """Unit-tests for ai_engine.generate_financial_advice.
    Gemini is mocked — no real API calls, zero token cost."""

    CONTEXT = {
        "timeframe": "current_month",
        "period": "2026-05-01 to 2026-05-18",
        "spending_by_category": {"Food": 1141.0},
        "total_spending": 7654.0,
        "all_active_budgets": {"Food": 2000.0, "Entertainment": 800.0},
    }

    @pytest.mark.asyncio
    async def test_happy_path_returns_gemini_text(self):
        """Normal call: function returns exactly what Gemini responds."""
        from app.ai.ai_engine import generate_financial_advice
        advice_text = "הוצאת ₪1,141 מתוך תקציב ₪2,000 על אוכל — נשארו לך ₪859. בסדר גמור!"

        with patch("app.ai.ai_engine._get_client") as mock_client:
            mock_client.return_value.models.generate_content.return_value = (
                _gemini_text_response(advice_text)
            )
            result = await generate_financial_advice(
                "כמה הוצאתי החודש על אוכל ונשאר לי משהו?",
                self.CONTEXT,
            )

        assert result == advice_text

    @pytest.mark.asyncio
    async def test_system_prompt_is_hebrew_only(self):
        """The system_instruction passed to Gemini must instruct Hebrew-only replies."""
        from app.ai.ai_engine import generate_financial_advice

        captured_config = {}

        def capture(*args, **kwargs):
            captured_config.update(kwargs)
            return _gemini_text_response("בסדר")

        with patch("app.ai.ai_engine._get_client") as mock_client:
            mock_client.return_value.models.generate_content.side_effect = capture
            await generate_financial_advice("שאלה", self.CONTEXT)

        config = captured_config.get("config")
        assert config is not None
        system_instruction = config.system_instruction
        assert "עברית" in system_instruction or "Hebrew" in system_instruction.lower() or "בעברית" in system_instruction

    @pytest.mark.asyncio
    async def test_context_json_embedded_in_user_message(self):
        """The context dict must appear serialised inside the message sent to Gemini."""
        from app.ai.ai_engine import generate_financial_advice

        captured_contents = {}

        def capture(*args, **kwargs):
            captured_contents["contents"] = kwargs.get("contents", args[1] if len(args) > 1 else None)
            return _gemini_text_response("ok")

        with patch("app.ai.ai_engine._get_client") as mock_client:
            mock_client.return_value.models.generate_content.side_effect = capture
            await generate_financial_advice("כמה יש לי?", self.CONTEXT)

        contents = captured_contents.get("contents")
        assert contents is not None
        # The context values must be serialised somewhere in the message parts
        raw_text = str(contents)
        assert "7654" in raw_text or "total_spending" in raw_text

    @pytest.mark.asyncio
    async def test_no_json_mime_type_plain_text(self):
        """generate_financial_advice must NOT set response_mime_type=application/json
        so the model can reply in free-form Hebrew prose."""
        from app.ai.ai_engine import generate_financial_advice

        captured_config = {}

        def capture(*args, **kwargs):
            captured_config.update(kwargs)
            return _gemini_text_response("טקסט חופשי")

        with patch("app.ai.ai_engine._get_client") as mock_client:
            mock_client.return_value.models.generate_content.side_effect = capture
            await generate_financial_advice("שאלה", self.CONTEXT)

        config = captured_config.get("config")
        mime = getattr(config, "response_mime_type", None)
        assert mime != "application/json"

    @pytest.mark.asyncio
    async def test_retries_on_503_and_succeeds(self):
        """Same retry policy as parse_input: up to 3 attempts, 2s sleep between."""
        from app.ai.ai_engine import generate_financial_advice
        from google.api_core import exceptions as google_exceptions
        call_count = 0

        def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise google_exceptions.ServiceUnavailable("503 UNAVAILABLE")
            return _gemini_text_response("ניסיון שלישי הצליח")

        with patch("app.ai.ai_engine._get_client") as mock_client, \
             patch("asyncio.sleep", new_callable=AsyncMock):
            mock_client.return_value.models.generate_content.side_effect = side_effect
            result = await generate_financial_advice("שאלה", self.CONTEXT)

        assert call_count == 3
        assert "שלישי" in result

    @pytest.mark.asyncio
    async def test_raises_after_3_failures(self):
        """Exhausting all retries must propagate the exception."""
        from app.ai.ai_engine import generate_financial_advice
        from google.api_core import exceptions as google_exceptions

        with patch("app.ai.ai_engine._get_client") as mock_client, \
             patch("asyncio.sleep", new_callable=AsyncMock):
            mock_client.return_value.models.generate_content.side_effect = (
                google_exceptions.ServiceUnavailable("503")
            )
            with pytest.raises(Exception):
                await generate_financial_advice("שאלה", self.CONTEXT)


# ── 3. get_dynamic_financial_context ──────────────────────────────────────────

class TestGetDynamicFinancialContext:
    """Unit-tests for DatabaseManager.get_dynamic_financial_context.
    The aiomysql pool is mocked — zero DB hits."""

    def _make_db_manager_with_pool(self, cat_rows, total_value, budget_rows=None):
        """Return a DatabaseManager whose pool is fully mocked.

        budget_rows: list of (category_name, monthly_limit) tuples, e.g. [("Food", 2000.0)].
        Defaults to [] (no budgets set).
        """
        from app.database.DatabaseManager import DatabaseManager

        dm = DatabaseManager.__new__(DatabaseManager)
        dm.config = {}

        mock_cur = AsyncMock()
        mock_cur.__aenter__ = AsyncMock(return_value=mock_cur)
        mock_cur.__aexit__ = AsyncMock(return_value=False)
        # Query order: cat_query fetchall, total_query fetchone, budgets_query fetchall
        mock_cur.fetchall = AsyncMock(side_effect=[cat_rows, budget_rows or []])
        mock_cur.fetchone = AsyncMock(return_value=(total_value,))

        mock_conn = AsyncMock()
        mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_conn.__aexit__ = AsyncMock(return_value=False)
        mock_conn.cursor = MagicMock(return_value=mock_cur)

        mock_pool = MagicMock()
        mock_pool.acquire = MagicMock(return_value=mock_conn)

        dm.pool = mock_pool
        return dm

    @pytest.mark.asyncio
    async def test_current_month_with_food_category(self):
        """Happy path: current_month + Food returns correct shape with all_active_budgets."""
        dm = self._make_db_manager_with_pool(
            cat_rows=[("Food", 1141.0)],
            total_value=7654.0,
            budget_rows=[("Food", 2000.0)],
        )
        result = await dm.get_dynamic_financial_context(938418219, "current_month", "Food")

        assert result["timeframe"] == "current_month"
        assert result["total_spending"] == pytest.approx(7654.0, abs=0.01)
        assert result["spending_by_category"].get("Food") == pytest.approx(1141.0, abs=0.01)
        assert result["all_active_budgets"].get("Food") == pytest.approx(2000.0, abs=0.01)

    @pytest.mark.asyncio
    async def test_return_dict_has_all_required_keys(self):
        """Result must always contain these five keys regardless of timeframe."""
        dm = self._make_db_manager_with_pool(cat_rows=[], total_value=0.0)
        result = await dm.get_dynamic_financial_context(1, "all_time")
        for key in ("timeframe", "period", "spending_by_category", "total_spending", "all_active_budgets"):
            assert key in result, f"Missing key: {key}"

    @pytest.mark.asyncio
    async def test_zero_data_new_user(self):
        """Brand-new user with no expenses: all zeros, empty dicts, no crash."""
        dm = self._make_db_manager_with_pool(cat_rows=[], total_value=0.0)
        result = await dm.get_dynamic_financial_context(999, "current_month")

        assert result["total_spending"] == 0.0
        assert result["spending_by_category"] == {}
        assert result["all_active_budgets"] == {}

    @pytest.mark.asyncio
    async def test_no_budget_set_returns_empty_dict(self):
        """When no budgets exist, all_active_budgets must be {} — not None,
        so Gemini never receives a non-iterable and can't raise TypeError."""
        dm = self._make_db_manager_with_pool(
            cat_rows=[("Shopping", 800.0)],
            total_value=3000.0,
            budget_rows=[],
        )
        result = await dm.get_dynamic_financial_context(1, "current_month", "Shopping")
        assert result["all_active_budgets"] == {}

    @pytest.mark.asyncio
    async def test_period_string_for_all_time(self):
        """all_time timeframe must produce 'all time' period string, not a date range."""
        dm = self._make_db_manager_with_pool(cat_rows=[], total_value=0.0)
        result = await dm.get_dynamic_financial_context(1, "all_time")
        assert result["period"] == "all time"

    @pytest.mark.asyncio
    async def test_period_string_for_current_month_contains_dates(self):
        """current_month period must include today's date."""
        dm = self._make_db_manager_with_pool(cat_rows=[], total_value=0.0)
        result = await dm.get_dynamic_financial_context(1, "current_month")
        today_str = str(date.today())
        assert today_str in result["period"]

    @pytest.mark.asyncio
    async def test_last_month_period_does_not_include_today(self):
        """last_month end_date must be the last day of the previous month, not today."""
        dm = self._make_db_manager_with_pool(cat_rows=[], total_value=0.0)
        result = await dm.get_dynamic_financial_context(1, "last_month")
        today_str = str(date.today())
        assert today_str not in result["period"]

    @pytest.mark.asyncio
    async def test_spending_float_precision_near_limit(self):
        """Float arithmetic edge case: 1228.0 spent vs 2000 limit → 772 remaining.
        Values must be Python floats, not Decimals, to avoid JSON serialisation issues."""
        dm = self._make_db_manager_with_pool(
            cat_rows=[("Shopping", 1228.0)],
            total_value=3456.78,
            budget_rows=[("Shopping", 2000.0)],
        )
        result = await dm.get_dynamic_financial_context(1, "current_month", "Shopping")
        assert isinstance(result["total_spending"], float)
        assert isinstance(result["all_active_budgets"]["Shopping"], float)
        remaining = result["all_active_budgets"]["Shopping"] - result["spending_by_category"]["Shopping"]
        assert remaining == pytest.approx(772.0, abs=0.01)

    @pytest.mark.asyncio
    async def test_all_budgets_always_fetched_regardless_of_category_filter(self):
        """all_active_budgets must be populated even when no specific_category is given,
        so Gemini always has full budget context."""
        dm = self._make_db_manager_with_pool(
            cat_rows=[],
            total_value=0.0,
            budget_rows=[("Food", 2000.0), ("Entertainment", 800.0)],
        )
        result = await dm.get_dynamic_financial_context(1, "current_month")
        assert result["all_active_budgets"] == {"Food": 2000.0, "Entertainment": 800.0}


# ── 4. Handler routing — happy path ───────────────────────────────────────────

class TestHandlerFinancialAdviceHappyPath:
    """Integration-style tests for the financial_advice branch in handlers.py."""

    @pytest.mark.asyncio
    async def test_sends_thinking_message_before_db_call(self):
        """UX requirement: user must see the '🤔 מנתח...' message immediately,
        not after the (potentially slow) DB + Gemini round-trip."""
        import app.bot.handlers as h

        message = _make_message("כמה הוצאתי החודש על אוכל?")
        state = _make_state()
        thinking_mock = AsyncMock()
        thinking_mock.edit_text = AsyncMock()
        message.reply = AsyncMock(return_value=thinking_mock)

        db = _make_db(
            dynamic_context={
                "timeframe": "current_month",
                "period": "2026-05-01 to 2026-05-18",
                "spending_by_category": {"Food": 1141.0},
                "total_spending": 7654.0,
                "all_active_budgets": {"Food": 2000.0},
            }
        )

        parsed = {
            "intent": "financial_advice",
            "question": "כמה הוצאתי החודש על אוכל?",
            "timeframe": "current_month",
            "category": "Food",
        }

        with patch("app.bot.handlers.parse_input", new=AsyncMock(return_value=[parsed])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock(return_value="הוצאת ₪1,141 על אוכל")):
            await _invoke_handle_text(h, message, state, db)

        # thinking message must be sent first (before edit_text is called)
        message.reply.assert_called_once()
        first_call_text = message.reply.call_args[0][0]
        assert "מנתח" in first_call_text

    @pytest.mark.asyncio
    async def test_edits_thinking_message_with_advice(self):
        """Final advice text from Gemini must replace the thinking message."""
        import app.bot.handlers as h

        thinking_mock = AsyncMock()
        thinking_mock.edit_text = AsyncMock()
        message = _make_message("האם אני יכול להוציא עוד 200 על בילויים?")
        message.reply = AsyncMock(return_value=thinking_mock)
        state = _make_state()
        advice = "יש לך עוד ₪372 בתקציב הבילויים — אפשר להוציא 200 בלי בעיה."
        db = _make_db(
            dynamic_context={
                "timeframe": "current_month",
                "period": "2026-05-01 to 2026-05-18",
                "spending_by_category": {"Entertainment": 628.0},
                "total_spending": 7654.0,
                "all_active_budgets": {"Entertainment": 1000.0},
            }
        )
        parsed = {
            "intent": "financial_advice",
            "question": "האם אני יכול להוציא עוד 200 על בילויים?",
            "timeframe": "current_month",
            "category": "Entertainment",
        }

        with patch("app.bot.handlers.parse_input", new=AsyncMock(return_value=[parsed])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock(return_value=advice)):
            await _invoke_handle_text(h, message, state, db)

        thinking_mock.edit_text.assert_called_once_with(advice)

    @pytest.mark.asyncio
    async def test_passes_correct_timeframe_and_category_to_db(self):
        """Handler must forward the timeframe and category extracted by parse_input
        to get_dynamic_financial_context unchanged."""
        import app.bot.handlers as h

        thinking_mock = AsyncMock()
        thinking_mock.edit_text = AsyncMock()
        message = _make_message("מה עם הוצאות Shopping ב-3 חודשים האחרונים?")
        message.reply = AsyncMock(return_value=thinking_mock)
        state = _make_state()
        db = _make_db(
            dynamic_context={
                "timeframe": "last_3_months",
                "period": "2026-02-01 to 2026-05-18",
                "spending_by_category": {"Shopping": 16639.0},
                "total_spending": 55000.0,
                "all_active_budgets": {},
            }
        )
        parsed = {
            "intent": "financial_advice",
            "question": "מה עם הוצאות Shopping?",
            "timeframe": "last_3_months",
            "category": "Shopping",
        }

        with patch("app.bot.handlers.parse_input", new=AsyncMock(return_value=[parsed])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock(return_value="הוצאות Shopping גבוהות")):
            await _invoke_handle_text(h, message, state, db)

        db.get_dynamic_financial_context.assert_called_once_with(
            message.from_user.id, "last_3_months", "Shopping"
        )

    @pytest.mark.asyncio
    async def test_defaults_timeframe_to_current_month_when_missing(self):
        """If parse_input returns financial_advice without a timeframe field,
        handler must default to 'current_month'."""
        import app.bot.handlers as h

        thinking_mock = AsyncMock()
        thinking_mock.edit_text = AsyncMock()
        message = _make_message("כמה הוצאתי?")
        message.reply = AsyncMock(return_value=thinking_mock)
        state = _make_state()
        db = _make_db(dynamic_context={"timeframe": "current_month", "period": "", "spending_by_category": {}, "total_spending": 0.0, "all_active_budgets": {}})
        parsed = {"intent": "financial_advice", "question": "כמה הוצאתי?"}  # no timeframe

        with patch("app.bot.handlers.parse_input", new=AsyncMock(return_value=[parsed])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock(return_value="אין נתונים")):
            await _invoke_handle_text(h, message, state, db)

        call_kwargs = db.get_dynamic_financial_context.call_args
        assert call_kwargs[0][1] == "current_month" or call_kwargs.args[1] == "current_month"

    @pytest.mark.asyncio
    async def test_category_none_when_not_specified(self):
        """General financial questions (no category) must pass category=None to DB."""
        import app.bot.handlers as h

        thinking_mock = AsyncMock()
        thinking_mock.edit_text = AsyncMock()
        message = _make_message("כמה הוצאתי סה''כ?")
        message.reply = AsyncMock(return_value=thinking_mock)
        state = _make_state()
        db = _make_db(dynamic_context={"timeframe": "current_month", "period": "", "spending_by_category": {}, "total_spending": 7654.0, "all_active_budgets": {}})
        parsed = {"intent": "financial_advice", "question": "כמה הוצאתי?", "timeframe": "current_month", "category": None}

        with patch("app.bot.handlers.parse_input", new=AsyncMock(return_value=[parsed])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock(return_value="הוצאת ₪7,654")):
            await _invoke_handle_text(h, message, state, db)

        db.get_dynamic_financial_context.assert_called_once_with(
            message.from_user.id, "current_month", None
        )


# ── 5. Edge cases ──────────────────────────────────────────────────────────────

class TestHandlerFinancialAdviceEdgeCases:

    @pytest.mark.asyncio
    async def test_over_budget_clothing_purchase(self):
        """Boundary: user spent ₪1,228 out of ₪2,000 clothing budget (₪772 left).
        Asking about buying ₪800 of clothes must not crash; advice delivered normally."""
        import app.bot.handlers as h

        thinking_mock = AsyncMock()
        thinking_mock.edit_text = AsyncMock()
        message = _make_message("אני רוצה לקנות בגדים ב-800 שקל, יש לי?")
        message.reply = AsyncMock(return_value=thinking_mock)
        state = _make_state()
        db = _make_db(
            dynamic_context={
                "timeframe": "current_month",
                "period": "2026-05-01 to 2026-05-18",
                "spending_by_category": {"Shopping": 1228.0},
                "total_spending": 7654.0,
                "all_active_budgets": {"Shopping": 2000.0},
            }
        )
        parsed = {
            "intent": "financial_advice",
            "question": "אני רוצה לקנות בגדים ב-800 שקל, יש לי?",
            "timeframe": "current_month",
            "category": "Shopping",
        }
        advice = "נשארו לך רק ₪772 בתקציב Shopping — קנייה של ₪800 תחרוג ב-₪28."

        with patch("app.bot.handlers.parse_input", new=AsyncMock(return_value=[parsed])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock(return_value=advice)):
            await _invoke_handle_text(h, message, state, db)

        thinking_mock.edit_text.assert_called_once_with(advice)

    @pytest.mark.asyncio
    async def test_zero_data_new_user_no_crash(self):
        """Brand-new user: DB returns all zeros and empty dicts.
        The handler must still call generate_financial_advice and return advice
        (Gemini should say there's no data to analyse)."""
        import app.bot.handlers as h

        thinking_mock = AsyncMock()
        thinking_mock.edit_text = AsyncMock()
        message = _make_message("כמה הוצאתי?")
        message.reply = AsyncMock(return_value=thinking_mock)
        state = _make_state()
        db = _make_db(
            dynamic_context={
                "timeframe": "current_month",
                "period": "2026-05-01 to 2026-05-18",
                "spending_by_category": {},
                "total_spending": 0.0,
                "all_active_budgets": {},
            }
        )
        parsed = {"intent": "financial_advice", "question": "כמה הוצאתי?", "timeframe": "current_month", "category": None}
        advice = "אין לך עדיין הוצאות מתועדות החודש."

        with patch("app.bot.handlers.parse_input", new=AsyncMock(return_value=[parsed])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock(return_value=advice)):
            await _invoke_handle_text(h, message, state, db)

        thinking_mock.edit_text.assert_called_once_with(advice)

    @pytest.mark.asyncio
    async def test_missing_budget_no_type_error(self):
        """When all_active_budgets is empty, the handler must not raise TypeError
        and must still deliver advice (Gemini falls back to total_spending analysis)."""
        import app.bot.handlers as h

        thinking_mock = AsyncMock()
        thinking_mock.edit_text = AsyncMock()
        message = _make_message("האם יש לי תקציב לקניות?")
        message.reply = AsyncMock(return_value=thinking_mock)
        state = _make_state()
        db = _make_db(
            dynamic_context={
                "timeframe": "current_month",
                "period": "2026-05-01 to 2026-05-18",
                "spending_by_category": {"Shopping": 450.0},
                "total_spending": 3200.0,
                "all_active_budgets": {},
            }
        )
        parsed = {"intent": "financial_advice", "question": "האם יש לי תקציב לקניות?", "timeframe": "current_month", "category": "Shopping"}
        advice = "לא הגדרת תקציב לקניות. הוצאת עד כה ₪450 — ₪3,200 סה''כ החודש."

        with patch("app.bot.handlers.parse_input", new=AsyncMock(return_value=[parsed])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock(return_value=advice)):
            await _invoke_handle_text(h, message, state, db)

        thinking_mock.edit_text.assert_called_once_with(advice)
        # No TypeError must have been raised (test would fail if it did)


# ── 6. Ambiguous / vague prompts ──────────────────────────────────────────────

class TestAmbiguousFinancialAdvicePrompts:

    @pytest.mark.asyncio
    async def test_vague_financial_question_routed_as_advice(self):
        """A garbled but finance-adjacent question must be classified as
        financial_advice (not ERROR_UNSUPPORTED) and advice must be returned."""
        import app.bot.handlers as h

        thinking_mock = AsyncMock()
        thinking_mock.edit_text = AsyncMock()
        message = _make_message("אני רוצה לקנות משהו כזה נו אתה יודע פיננסי כמה יש לי")
        message.reply = AsyncMock(return_value=thinking_mock)
        state = _make_state()
        db = _make_db(
            dynamic_context={
                "timeframe": "current_month",
                "period": "2026-05-01 to 2026-05-18",
                "spending_by_category": {"Food": 1141.0, "Shopping": 800.0},
                "total_spending": 7654.0,
                "all_active_budgets": {},
            }
        )
        parsed = {
            "intent": "financial_advice",
            "question": "אני רוצה לקנות משהו כזה נו אתה יודע פיננסי כמה יש לי",
            "timeframe": "current_month",
            "category": None,
        }
        advice = "הוצאת ₪7,654 עד כה החודש. בהתאם לקצב, ייתכן שיש מקום לרכישה קטנה."

        with patch("app.bot.handlers.parse_input", new=AsyncMock(return_value=[parsed])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock(return_value=advice)):
            await _invoke_handle_text(h, message, state, db)

        # Must reach advice, not WITTY_UNSUPPORTED
        thinking_mock.edit_text.assert_called_once_with(advice)
        db.get_dynamic_financial_context.assert_called_once()


# ── 7. Regression — unrelated prompts stay out of advisor ─────────────────────

class TestRegressionOutOfScope:

    @pytest.mark.asyncio
    async def test_weather_query_returns_witty_unsupported(self):
        """'מה המזג אוויר היום?' must be classified as ERROR_UNSUPPORTED
        and must NOT touch the database or advisor logic."""
        import app.bot.handlers as h

        message = _make_message("מה המזג אוויר היום?")
        state = _make_state()
        db = _make_db()

        with patch("app.bot.handlers.parse_input",
                   new=AsyncMock(return_value=[{"intent": "ERROR_UNSUPPORTED"}])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock()) as mock_advice:
            await _invoke_handle_text(h, message, state, db)

        db.get_dynamic_financial_context.assert_not_called()
        mock_advice.assert_not_called()
        message.reply.assert_called_once()
        reply_text = message.reply.call_args[0][0]
        assert "financial magic" in reply_text or "expenses" in reply_text

    @pytest.mark.asyncio
    async def test_hello_returns_witty_unsupported(self):
        """Simple 'hello' must not enter advisor flow."""
        import app.bot.handlers as h

        message = _make_message("hello")
        state = _make_state()
        db = _make_db()

        with patch("app.bot.handlers.parse_input",
                   new=AsyncMock(return_value=[{"intent": "ERROR_UNSUPPORTED"}])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock()) as mock_advice:
            await _invoke_handle_text(h, message, state, db)

        mock_advice.assert_not_called()

    @pytest.mark.asyncio
    async def test_expense_logging_not_affected_by_new_intent(self):
        """Classic '55 שקל שווארמה' must still route to ExpenseFlow,
        never touching the advisor."""
        import app.bot.handlers as h

        message = _make_message("55 שקל שווארמה")
        state = _make_state()
        db = _make_db()

        parsed = {"intent": "log_expense", "amount": 55.0, "currency": "ILS", "item": "שווארמה", "category": "Food", "source": "bot"}

        with patch("app.bot.handlers.parse_input", new=AsyncMock(return_value=[parsed])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock()) as mock_advice:
            await _invoke_handle_text(h, message, state, db)

        mock_advice.assert_not_called()
        state.set_state.assert_called_once()  # FSM transition for expense confirmation


# ── 8. Error recovery in handler ──────────────────────────────────────────────

class TestHandlerFinancialAdviceErrorRecovery:

    @pytest.mark.asyncio
    async def test_db_error_edits_thinking_message_with_hebrew_error(self):
        """If get_dynamic_financial_context raises, the thinking message must be
        edited to a user-friendly Hebrew error string (not crash the handler)."""
        import app.bot.handlers as h

        thinking_mock = AsyncMock()
        thinking_mock.edit_text = AsyncMock()
        message = _make_message("כמה הוצאתי?")
        message.reply = AsyncMock(return_value=thinking_mock)
        state = _make_state()
        db = _make_db()
        db.get_dynamic_financial_context = AsyncMock(side_effect=Exception("DB connection lost"))

        parsed = {"intent": "financial_advice", "question": "כמה הוצאתי?", "timeframe": "current_month", "category": None}

        with patch("app.bot.handlers.parse_input", new=AsyncMock(return_value=[parsed])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock(return_value="לא יגיע לכאן")):
            await _invoke_handle_text(h, message, state, db)

        thinking_mock.edit_text.assert_called_once()
        error_text = thinking_mock.edit_text.call_args[0][0]
        assert "❌" in error_text

    @pytest.mark.asyncio
    async def test_gemini_error_edits_thinking_message_with_hebrew_error(self):
        """If generate_financial_advice raises (Gemini 503), thinking message
        must be edited to Hebrew error — handler must not propagate the exception."""
        import app.bot.handlers as h

        thinking_mock = AsyncMock()
        thinking_mock.edit_text = AsyncMock()
        message = _make_message("כמה הוצאתי?")
        message.reply = AsyncMock(return_value=thinking_mock)
        state = _make_state()
        db = _make_db(
            dynamic_context={"timeframe": "current_month", "period": "", "spending_by_category": {}, "total_spending": 0.0, "all_active_budgets": {}}
        )
        parsed = {"intent": "financial_advice", "question": "כמה הוצאתי?", "timeframe": "current_month", "category": None}

        with patch("app.bot.handlers.parse_input", new=AsyncMock(return_value=[parsed])), \
             patch("app.bot.handlers.generate_financial_advice",
                   new=AsyncMock(side_effect=Exception("503 Gemini down"))):
            await _invoke_handle_text(h, message, state, db)

        thinking_mock.edit_text.assert_called_once()
        error_text = thinking_mock.edit_text.call_args[0][0]
        assert "❌" in error_text


# ── Internal helper — drives handle_text without relying on aiogram Dispatcher ─

async def _invoke_handle_text(h, message, state, db):
    """Call the inner handle_text function directly, bypassing aiogram routing.
    Works with both decorator-based and plain async def patterns."""
    # handlers.py defines handle_text inside register_handlers as a closure.
    # We call register_handlers with a fake dispatcher to extract the coroutine.
    from aiogram import Dispatcher
    dp = MagicMock(spec=Dispatcher)
    dp.message = MagicMock(return_value=lambda f: f)
    dp.callback_query = MagicMock(return_value=lambda f: f)

    captured = {}

    original_message = dp.message

    def capture_decorator(*filter_args, **filter_kwargs):
        def decorator(func):
            if not captured:
                captured["fn"] = func
            return func
        return decorator

    dp.message = capture_decorator
    dp.callback_query = capture_decorator

    h.register_handlers(dp, db)

    fn = captured.get("fn")
    if fn is None:
        raise RuntimeError("Could not capture handle_text from register_handlers")

    # Check auth: user_exists must return True
    db.user_exists = AsyncMock(return_value=True)

    await fn(message, state)
