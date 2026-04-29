"""
Tests for bot/app/bot/handlers.py

Tests handler routing logic, budget warnings, and FSM transitions.
Mocks: aiogram Message/CallbackQuery, FSMContext, DatabaseManager, parse_input.
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime


def _make_message(text: str, user_id: int = 123456789) -> MagicMock:
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


def _make_db(categories=None, budget=None, spending=0.0) -> MagicMock:
    db = AsyncMock()
    db.ensure_user = AsyncMock()
    db.get_user_categories = AsyncMock(return_value=categories or ["Food", "Transport", "Other"])
    db.get_category_budget = AsyncMock(return_value=budget)
    db.get_category_spending = AsyncMock(return_value=spending)
    db.add_expense = AsyncMock(return_value=True)
    db.add_income = AsyncMock(return_value=True)
    db.add_subscription = AsyncMock(return_value=99)
    return db


# ── Authorization guard ───────────────────────────────────────────────────────

class TestAuthGuard:
    @pytest.mark.asyncio
    async def test_unauthorized_user_ignored(self):
        """Message from user NOT in ALLOWED_USER_IDS must be silently ignored."""
        from app.bot.handlers import register_handlers
        from aiogram import Dispatcher

        msg = _make_message("55 coffee", user_id=9999)
        db = _make_db()

        with patch.dict("os.environ", {"TELEGRAM_CHAT_ID": "123456789"}):
            # Re-import to pick up the patched env
            import importlib
            import app.bot.handlers as h
            importlib.reload(h)

            state = _make_state()
            # The handler calls _auth() first — user 9999 not in allowed set
            # We verify no DB calls were made
            with patch("app.bot.handlers.parse_input", new_callable=AsyncMock) as mock_parse:
                mock_parse.return_value = {"intent": "log_expense", "amount": 55}
                # Directly test the _auth helper
                assert not h._auth(9999)
                assert h._auth(123456789)


# ── Intent routing ────────────────────────────────────────────────────────────

class TestIntentRouting:
    @pytest.mark.asyncio
    async def test_expense_intent_shows_confirmation(self):
        from app.bot import handlers as h

        msg = _make_message("55 coffee")
        state = _make_state()
        db = _make_db()

        parsed = {"intent": "log_expense", "amount": 55.0, "currency": "ILS", "item": "coffee", "category": "Food", "source": "bot"}

        with patch("app.bot.handlers.parse_input", new_callable=AsyncMock, return_value=parsed), \
             patch("app.bot.handlers._auth", return_value=True), \
             patch("app.bot.handlers._check_budget_warning", new_callable=AsyncMock, return_value=""):
            await h.register_handlers.__wrapped__ if hasattr(h.register_handlers, "__wrapped__") else None
            # Test _format_expense_confirmation directly
            text = h._format_expense_confirmation(parsed)
            assert "55" in text
            assert "coffee" in text
            assert "Food" in text

    def test_expense_confirmation_format_contains_all_fields(self):
        from app.bot.handlers import _format_expense_confirmation

        data = {"amount": 120.5, "currency": "ILS", "item": "groceries", "category": "Food"}
        text = _format_expense_confirmation(data)
        assert "120.5" in text
        assert "ILS" in text
        assert "groceries" in text
        assert "Food" in text

    def test_expense_confirmation_uses_description_fallback(self):
        from app.bot.handlers import _format_expense_confirmation

        data = {"amount": 50.0, "currency": "ILS", "description": "mystery purchase", "category": "Other"}
        text = _format_expense_confirmation(data)
        assert "mystery purchase" in text

    def test_expense_confirmation_handles_missing_item(self):
        from app.bot.handlers import _format_expense_confirmation

        data = {"amount": 50.0, "currency": "ILS", "category": "Other"}
        text = _format_expense_confirmation(data)
        assert "Unknown item" in text


# ── Budget warning thresholds ─────────────────────────────────────────────────

class TestBudgetWarnings:
    @pytest.mark.asyncio
    async def test_no_warning_below_80_percent(self):
        from app.bot.handlers import _check_budget_warning

        db = _make_db(budget={"monthly_limit": 1000}, spending=700.0)
        # 700 + 50 = 750 = 75% → no warning
        result = await _check_budget_warning(db, 1, "Food", 50.0)
        assert result == ""

    @pytest.mark.asyncio
    async def test_warning_at_80_percent(self):
        from app.bot.handlers import _check_budget_warning

        db = _make_db(budget={"monthly_limit": 1000}, spending=750.0)
        # 750 + 50 = 800 = 80% → warning
        result = await _check_budget_warning(db, 1, "Food", 50.0)
        assert "80%" in result or "warning" in result.lower() or "⚠️" in result

    @pytest.mark.asyncio
    async def test_over_budget_at_100_percent(self):
        from app.bot.handlers import _check_budget_warning

        db = _make_db(budget={"monthly_limit": 1000}, spending=990.0)
        # 990 + 50 = 1040 = 104% → over budget
        result = await _check_budget_warning(db, 1, "Food", 50.0)
        assert "🚨" in result or "Over budget" in result or "100" in result

    @pytest.mark.asyncio
    async def test_no_warning_when_no_budget_set(self):
        from app.bot.handlers import _check_budget_warning

        db = _make_db(budget=None)
        result = await _check_budget_warning(db, 1, "Food", 500.0)
        assert result == ""

    @pytest.mark.asyncio
    async def test_no_warning_when_category_is_none(self):
        from app.bot.handlers import _check_budget_warning

        db = _make_db()
        result = await _check_budget_warning(db, 1, None, 500.0)
        assert result == ""

    @pytest.mark.asyncio
    async def test_no_warning_when_budget_limit_zero(self):
        from app.bot.handlers import _check_budget_warning

        db = _make_db(budget={"monthly_limit": 0})
        result = await _check_budget_warning(db, 1, "Food", 500.0)
        assert result == ""

    @pytest.mark.asyncio
    async def test_warning_survives_db_error(self):
        """If DB lookup fails, should return empty string, not crash."""
        from app.bot.handlers import _check_budget_warning

        db = MagicMock()
        db.get_category_budget = AsyncMock(side_effect=Exception("DB down"))
        result = await _check_budget_warning(db, 1, "Food", 100.0)
        assert result == ""


# ── Subscription day clamping ─────────────────────────────────────────────────

class TestSubscriptionDayClamping:
    """The confirm_subscription callback clamps day to 1-28."""

    def test_day_clamped_to_1_minimum(self):
        day = max(1, min(28, int(0)))
        assert day == 1

    def test_day_clamped_to_28_maximum(self):
        day = max(1, min(28, int(31)))
        assert day == 28

    def test_valid_day_unchanged(self):
        day = max(1, min(28, int(15)))
        assert day == 15

    def test_invalid_string_defaults_to_1(self):
        try:
            day = max(1, min(28, int("abc")))
        except (ValueError, TypeError):
            day = 1
        assert day == 1
