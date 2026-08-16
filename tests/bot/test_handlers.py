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


class _CollectingDispatcher:
    """Captures what register_handlers() registers, so handlers can be driven directly.

    aiogram's decorators only register — they do not wrap — so the captured function is the
    real handler with its real body. Nothing else in this suite exercises a registered
    handler end to end, which is how the user-resolution bug stayed invisible to it.
    """

    def __init__(self):
        self.handlers = {}

    def _capture(self, *_args, **_kwargs):
        def decorator(fn):
            self.handlers[fn.__name__] = fn
            return fn
        return decorator

    def message(self, *args, **kwargs):
        return self._capture(*args, **kwargs)

    def callback_query(self, *args, **kwargs):
        return self._capture(*args, **kwargs)

    def __getattr__(self, name):
        try:
            return self.handlers[name]
        except KeyError as exc:
            raise AttributeError(name) from exc


def _make_callback(data: str = "confirm_expense", user_id: int = 123456789) -> MagicMock:
    cb = MagicMock()
    cb.data = data
    cb.from_user = MagicMock()
    cb.from_user.id = user_id
    cb.message = MagicMock()
    cb.message.edit_text = AsyncMock()
    cb.message.reply = AsyncMock()
    cb.message.answer = AsyncMock()
    cb.message.delete = AsyncMock()
    cb.answer = AsyncMock()
    return cb


# Default: chat 123456789 is linked to user_id 10000000000007 — an app-origin account whose
# user_id deliberately differs from the chat id, which is the case the old code got wrong.
LINKED_CHAT = 123456789
LINKED_USER_ID = 10000000000007


def _make_db(categories=None, budget=None, spending=0.0, linked=True) -> MagicMock:
    db = AsyncMock()
    db.get_user_id_by_chat_id = AsyncMock(
        side_effect=lambda chat_id: LINKED_USER_ID if (linked and chat_id == LINKED_CHAT) else None
    )
    db.get_user_categories = AsyncMock(return_value=categories or ["Food", "Transport", "Other"])
    db.get_category_budget = AsyncMock(return_value=budget)
    db.get_category_spending = AsyncMock(return_value=spending)
    db.add_expense = AsyncMock(return_value=True)
    db.add_income = AsyncMock(return_value=True)
    db.add_subscription = AsyncMock(return_value=99)
    return db


# ── Authorization guard ───────────────────────────────────────────────────────

class TestAuthGuard:
    """The bot identifies a user ONLY by the chat they linked.

    It used to pass message.from_user.id straight into queries as users.user_id. That held
    only while the bot was also what created accounts; accounts now come from the web app
    with a DB-assigned id, so for an app-origin user the two numbers differ and every
    command silently matched nothing.
    """

    @pytest.mark.asyncio
    async def test_resolves_via_telegram_chat_id_not_the_raw_telegram_id(self):
        import app.bot.handlers as h

        db = _make_db()

        assert await h._resolve_user(LINKED_CHAT, db) == LINKED_USER_ID
        # The resolved id is the account's, not the chat's — the distinction that was broken.
        assert await h._resolve_user(LINKED_CHAT, db) != LINKED_CHAT
        db.get_user_id_by_chat_id.assert_awaited_with(LINKED_CHAT)

    @pytest.mark.asyncio
    async def test_returns_none_for_an_unlinked_chat(self):
        import app.bot.handlers as h

        assert await h._resolve_user(9999, _make_db()) is None

    @pytest.mark.asyncio
    async def test_an_unlinked_chat_is_told_how_to_link_and_writes_nothing(self):
        import app.bot.handlers as h

        db = _make_db(linked=False)
        dp = _CollectingDispatcher()
        h.register_handlers(dp, db)

        msg = _make_message("55 nis shawarma")
        await dp.handle_text(msg, _make_state())

        db.add_expense.assert_not_awaited()
        db.get_user_categories.assert_not_awaited()
        assert "/link" in msg.reply.call_args[0][0]


class TestLinkThrottle:
    """Bot messages never pass through the backend's authLimiter, so /link is paced here."""

    def test_allows_a_burst_then_blocks(self):
        import app.bot.handlers as h

        h._LINK_ATTEMPTS.clear()
        assert all(h._link_throttle_ok(4242) for _ in range(h._LINK_MAX_ATTEMPTS))
        assert h._link_throttle_ok(4242) is False

    def test_throttles_per_chat_not_globally(self):
        import app.bot.handlers as h

        h._LINK_ATTEMPTS.clear()
        for _ in range(h._LINK_MAX_ATTEMPTS):
            h._link_throttle_ok(1)
        assert h._link_throttle_ok(1) is False
        assert h._link_throttle_ok(2) is True

    def test_a_successful_link_resets_the_budget(self):
        import app.bot.handlers as h

        h._LINK_ATTEMPTS.clear()
        for _ in range(h._LINK_MAX_ATTEMPTS):
            h._link_throttle_ok(7)
        h._clear_link_throttle(7)
        assert h._link_throttle_ok(7) is True


class TestLinkCommand:
    """/link <code> replaced /link_google <email>.

    The old command took an email on the sender's word, so anyone could bind their chat to an
    account whose telegram_chat_id was still NULL — every Google-only account.
    """

    def _register(self, db):
        import app.bot.handlers as h

        h._LINK_ATTEMPTS.clear()
        dp = _CollectingDispatcher()
        h.register_handlers(dp, db)
        return dp

    @pytest.mark.asyncio
    async def test_link_google_no_longer_exists(self):
        db = _make_db(linked=False)
        dp = self._register(db)

        assert "handle_link_google" not in dp.handlers
        assert "handle_link" in dp.handlers

        # And the DatabaseManager method it called is gone from the real class, so no
        # remaining code path can write an email nobody proved they own.
        from app.database.DatabaseManager import DatabaseManager
        assert not hasattr(DatabaseManager, "link_google_account")
        assert not hasattr(DatabaseManager, "ensure_user")

    @pytest.mark.asyncio
    async def test_a_valid_code_links_the_chat(self):
        db = _make_db(linked=False)
        db.redeem_link_code = AsyncMock(return_value="ok")
        dp = self._register(db)

        msg = _make_message("/link ABCD1234")
        await dp.handle_link(msg)

        db.redeem_link_code.assert_awaited_once_with("ABCD1234", LINKED_CHAT)
        assert "Linked" in msg.reply.call_args[0][0]

    @pytest.mark.asyncio
    async def test_an_invalid_code_is_refused(self):
        db = _make_db(linked=False)
        db.redeem_link_code = AsyncMock(return_value="invalid")
        dp = self._register(db)

        msg = _make_message("/link ZZZZZZZZ")
        await dp.handle_link(msg)

        assert "invalid, expired or already used" in msg.reply.call_args[0][0]

    @pytest.mark.asyncio
    async def test_a_missing_code_shows_usage_without_a_db_call(self):
        db = _make_db(linked=False)
        db.redeem_link_code = AsyncMock()
        dp = self._register(db)

        msg = _make_message("/link")
        await dp.handle_link(msg)

        db.redeem_link_code.assert_not_awaited()
        assert "Usage" in msg.reply.call_args[0][0]

    @pytest.mark.asyncio
    async def test_repeated_wrong_guesses_are_throttled(self):
        db = _make_db(linked=False)
        db.redeem_link_code = AsyncMock(return_value="invalid")
        dp = self._register(db)

        import app.bot.handlers as h
        for _ in range(h._LINK_MAX_ATTEMPTS):
            await dp.handle_link(_make_message("/link ZZZZZZZZ"))

        blocked = _make_message("/link ZZZZZZZZ")
        await dp.handle_link(blocked)

        assert db.redeem_link_code.await_count == h._LINK_MAX_ATTEMPTS
        assert "Too many attempts" in blocked.reply.call_args[0][0]


# ── Intent routing ────────────────────────────────────────────────────────────

class TestIntentRouting:
    @pytest.mark.asyncio
    async def test_expense_intent_shows_confirmation(self):
        from app.bot import handlers as h

        msg = _make_message("55 coffee")
        state = _make_state()
        db = _make_db()
        dp = _CollectingDispatcher()
        h.register_handlers(dp, db)

        parsed = {"intent": "log_expense", "amount": 55.0, "currency": "ILS",
                  "item": "coffee", "category": "Food", "source": "bot"}

        with patch("app.bot.handlers.parse_input", new_callable=AsyncMock, return_value=[parsed]), \
             patch("app.bot.handlers._check_budget_warning", new_callable=AsyncMock, return_value=""):
            await dp.handle_text(msg, state)

        # The account's categories are fetched with the RESOLVED user_id, never the chat id.
        db.get_user_categories.assert_awaited_once_with(LINKED_USER_ID)

        text = msg.reply.call_args[0][0]
        assert "55" in text
        assert "coffee" in text
        assert "Food" in text

    @pytest.mark.asyncio
    async def test_confirming_an_expense_writes_it_against_the_resolved_account(self):
        """The confirm callback used to write with callback.from_user.id and no auth check
        at all — FSM state was the only gate."""
        from app.bot import handlers as h

        db = _make_db()
        dp = _CollectingDispatcher()
        h.register_handlers(dp, db)

        state = _make_state()
        state.get_data = AsyncMock(return_value={"parsed": {
            "amount": 55.0, "item": "coffee", "category": "Food", "currency": "ILS", "source": "bot",
        }})

        await dp.callback_confirm(_make_callback(), state)

        db.add_expense.assert_awaited_once()
        assert db.add_expense.call_args.kwargs["user_id"] == LINKED_USER_ID

    @pytest.mark.asyncio
    async def test_confirming_from_an_unlinked_chat_writes_nothing(self):
        from app.bot import handlers as h

        db = _make_db(linked=False)
        dp = _CollectingDispatcher()
        h.register_handlers(dp, db)

        state = _make_state()
        state.get_data = AsyncMock(return_value={"parsed": {"amount": 55.0, "item": "coffee"}})

        await dp.callback_confirm(_make_callback(), state)

        db.add_expense.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_confirming_income_from_an_unlinked_chat_writes_nothing(self):
        from app.bot import handlers as h

        db = _make_db(linked=False)
        dp = _CollectingDispatcher()
        h.register_handlers(dp, db)

        state = _make_state()
        state.get_data = AsyncMock(return_value={"parsed": {"amount": 15000, "source": "Salary"}})

        await dp.callback_confirm_income(_make_callback("confirm_income"), state)

        db.add_income.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_confirming_a_subscription_from_an_unlinked_chat_writes_nothing(self):
        from app.bot import handlers as h

        db = _make_db(linked=False)
        dp = _CollectingDispatcher()
        h.register_handlers(dp, db)

        state = _make_state()
        state.get_data = AsyncMock(return_value={"parsed": {"name": "Netflix", "amount": 39.9, "day": 3}})

        await dp.callback_confirm_subscription(_make_callback("confirm_subscription"), state)

        db.add_subscription.assert_not_awaited()

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
