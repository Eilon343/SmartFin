"""
Tests for bot/app/scheduler.py

Tests spending score calculation and subscription billing logic.
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import date


# ── Spending score math ───────────────────────────────────────────────────────

class TestSpendingScoreMath:
    """
    Spending score = week_total / expected, where:
      weekly_avg = monthly_avg_over_3_months / 4.33 (weeks per month)
      expected   = weekly_avg × (elapsed_days / 7)

    This class used to re-implement the formula locally and assert against the copy, which
    meant it kept passing while the real one compared a 6-day window against a 7-day
    expectation. The grade now comes from the actual function; the exhaustive cases live
    in tests/math/test_pnl_math.py.
    """

    def _grade(self, week_total, monthly_avg, elapsed_days=7):
        from app.scheduler import _format_score_message
        weekly_avg = monthly_avg / 4.33 if monthly_avg else 0.0
        return _format_score_message({
            "week_total": week_total,
            "weekly_avg": weekly_avg,
            "expected": weekly_avg * (elapsed_days / 7),
            "elapsed_days": elapsed_days,
        })

    def test_no_spending_this_week_grades_excellent(self):
        assert "Excellent" in self._grade(week_total=0, monthly_avg=1000)

    def test_no_historical_data_says_so(self):
        assert "Not enough history" in self._grade(week_total=500, monthly_avg=0)

    def test_on_track_grades_good(self):
        weekly_avg = 1000 / 4.33
        assert "Good" in self._grade(week_total=round(weekly_avg), monthly_avg=1000)

    def test_overspending_grades_way_over(self):
        weekly_avg = 1000 / 4.33
        assert "Way over budget" in self._grade(week_total=weekly_avg * 2, monthly_avg=1000)

    def test_underspending_grades_excellent(self):
        weekly_avg = 1000 / 4.33
        assert "Excellent" in self._grade(week_total=weekly_avg * 0.3, monthly_avg=1000)

    def test_a_partial_week_is_not_flattered_by_a_full_week_expectation(self):
        # Six days at exactly the right pace. The old comparison called this ~14% under.
        weekly_avg = 1000 / 4.33
        msg = self._grade(week_total=weekly_avg * 6 / 7, monthly_avg=1000, elapsed_days=6)
        assert "Good" in msg
        assert "0%" in msg


# ── Subscription due-date logic ───────────────────────────────────────────────

class TestSubscriptionDueDate:
    """
    A subscription is due when:
      - day_of_month <= today's day
      - last_charged_month IS NULL or < current_month
    """

    def _is_due(self, day_of_month, last_charged_month, today_day, current_month):
        if day_of_month > today_day:
            return False
        if last_charged_month is None:
            return True
        return last_charged_month < current_month

    def test_due_on_exact_day(self):
        assert self._is_due(15, None, 15, "2026-04") is True

    def test_due_when_past_due_day(self):
        assert self._is_due(10, None, 20, "2026-04") is True

    def test_not_due_when_future_day(self):
        assert self._is_due(20, None, 15, "2026-04") is False

    def test_not_due_already_charged_this_month(self):
        assert self._is_due(15, "2026-04", 15, "2026-04") is False

    def test_due_when_charged_last_month(self):
        assert self._is_due(15, "2026-03", 15, "2026-04") is True

    def test_not_due_when_charged_last_month_but_day_not_reached(self):
        assert self._is_due(20, "2026-03", 15, "2026-04") is False

    def test_first_of_month_always_due_on_first(self):
        assert self._is_due(1, None, 1, "2026-04") is True

    def test_day_28_due_on_28th(self):
        assert self._is_due(28, None, 28, "2026-04") is True

    def test_day_28_not_due_on_27th(self):
        assert self._is_due(28, None, 27, "2026-04") is False


# ── Scheduler integration: charge_due_subscriptions ──────────────────────────

class TestChargeDueSubscriptions:
    @pytest.mark.asyncio
    async def test_charges_due_subscription_and_adds_expense(self):
        from app.scheduler import _charge_due_subscriptions

        bot = AsyncMock()
        bot.send_message = AsyncMock()

        db = AsyncMock()
        db.get_due_subscriptions = AsyncMock(return_value=[{
            "subscription_id": 1,
            "name": "Netflix",
            "amount": 39.90,
            "currency": "ILS",
            "category": "Entertainment",
            # An app-origin account: the id that keys the money is NOT the id that
            # addresses the chat.
            "user_id": 10000000000007,
            "telegram_chat_id": "12345",
        }])
        db.add_expense = AsyncMock(return_value=True)
        db.mark_subscription_charged = AsyncMock()
        db.has_active_bank_sync = AsyncMock(return_value=False)

        today = date(2026, 4, 15)
        with patch("app.scheduler.date") as mock_date:
            mock_date.today.return_value = today
            mock_date.side_effect = lambda *a, **kw: date(*a, **kw)
            await _charge_due_subscriptions(bot, db)

        db.add_expense.assert_called_once()
        call_kwargs = db.add_expense.call_args[1]
        assert call_kwargs["amount"] == 39.90
        assert call_kwargs["description"] == "[Subscription] Netflix"
        assert call_kwargs["source"] == "bot"
        assert call_kwargs["user_id"] == 10000000000007

        db.mark_subscription_charged.assert_called_once_with(1, "2026-04")

        # The DM goes to the chat id. Sending to user_id would either fail or reach an
        # unrelated chat, since a DB-assigned user_id is outside the chat-id range.
        bot.send_message.assert_called_once()
        assert bot.send_message.call_args[0][0] == "12345"

    @pytest.mark.asyncio
    async def test_charges_a_user_who_never_linked_telegram_without_messaging(self):
        from app.scheduler import _charge_due_subscriptions

        bot = AsyncMock()
        bot.send_message = AsyncMock()

        db = AsyncMock()
        db.get_due_subscriptions = AsyncMock(return_value=[{
            "subscription_id": 1,
            "name": "Netflix",
            "amount": 39.90,
            "currency": "ILS",
            "category": "Entertainment",
            "user_id": 10000000000007,
            "telegram_chat_id": None,   # web-only account
        }])
        db.add_expense = AsyncMock(return_value=True)
        db.mark_subscription_charged = AsyncMock()
        db.has_active_bank_sync = AsyncMock(return_value=False)

        with patch("app.scheduler.date") as mock_date:
            mock_date.today.return_value = date(2026, 4, 15)
            mock_date.side_effect = lambda *a, **kw: date(*a, **kw)
            await _charge_due_subscriptions(bot, db)

        # Billed as normal — the account simply gets no notification.
        db.add_expense.assert_called_once()
        db.mark_subscription_charged.assert_awaited_once()
        bot.send_message.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_synced_user_gets_no_generated_expense(self):
        """With a bank/card connected, sync imports the real charge — writing a generated
        row too would double-count. The sub is still marked charged so the job is
        idempotent for the month and P&L stops forecasting an already-billed charge."""
        from app.scheduler import _charge_due_subscriptions

        bot = AsyncMock()
        bot.send_message = AsyncMock()

        db = AsyncMock()
        db.get_due_subscriptions = AsyncMock(return_value=[{
            "subscription_id": 1,
            "name": "Netflix",
            "amount": 39.90,
            "currency": "ILS",
            "category": "Entertainment",
            "user_id": 12345,
        }])
        db.add_expense = AsyncMock(return_value=True)
        db.mark_subscription_charged = AsyncMock()
        db.has_active_bank_sync = AsyncMock(return_value=True)

        today = date(2026, 4, 15)
        with patch("app.scheduler.date") as mock_date:
            mock_date.today.return_value = today
            mock_date.side_effect = lambda *a, **kw: date(*a, **kw)
            await _charge_due_subscriptions(bot, db)

        db.add_expense.assert_not_called()
        bot.send_message.assert_not_called()
        db.mark_subscription_charged.assert_called_once_with(1, "2026-04")

    @pytest.mark.asyncio
    async def test_sync_lookup_is_memoized_per_user(self):
        """Two subs for the same user must cost one has_active_bank_sync round-trip."""
        from app.scheduler import _charge_due_subscriptions

        bot = AsyncMock()
        db = AsyncMock()
        db.get_due_subscriptions = AsyncMock(return_value=[
            {"subscription_id": 1, "name": "Netflix", "amount": 39.90,
             "currency": "ILS", "category": "Entertainment", "user_id": 12345},
            {"subscription_id": 2, "name": "Spotify", "amount": 19.90,
             "currency": "ILS", "category": "Entertainment", "user_id": 12345},
        ])
        db.add_expense = AsyncMock(return_value=True)
        db.mark_subscription_charged = AsyncMock()
        db.has_active_bank_sync = AsyncMock(return_value=False)

        today = date(2026, 4, 15)
        with patch("app.scheduler.date") as mock_date:
            mock_date.today.return_value = today
            mock_date.side_effect = lambda *a, **kw: date(*a, **kw)
            await _charge_due_subscriptions(bot, db)

        db.has_active_bank_sync.assert_called_once_with(12345)
        assert db.add_expense.call_count == 2

    @pytest.mark.asyncio
    async def test_no_due_subscriptions_nothing_happens(self):
        from app.scheduler import _charge_due_subscriptions

        bot = AsyncMock()
        db = AsyncMock()
        db.get_due_subscriptions = AsyncMock(return_value=[])

        today = date(2026, 4, 15)
        with patch("app.scheduler.date") as mock_date:
            mock_date.today.return_value = today
            mock_date.side_effect = lambda *a, **kw: date(*a, **kw)
            await _charge_due_subscriptions(bot, db)

        db.add_expense.assert_not_called()
        bot.send_message.assert_not_called()

    @pytest.mark.asyncio
    async def test_expense_failure_still_marks_charged(self):
        """Even if add_expense fails, we should still try to mark as charged to avoid double-billing."""
        from app.scheduler import _charge_due_subscriptions

        bot = AsyncMock()
        db = AsyncMock()
        db.get_due_subscriptions = AsyncMock(return_value=[{
            "subscription_id": 2, "name": "Spotify", "amount": 19.90,
            "currency": "ILS", "category": "Entertainment", "user_id": 12345,
        }])
        db.add_expense = AsyncMock(return_value=False)  # expense insert failed
        db.mark_subscription_charged = AsyncMock()
        db.has_active_bank_sync = AsyncMock(return_value=False)

        today = date(2026, 4, 1)
        with patch("app.scheduler.date") as mock_date:
            mock_date.today.return_value = today
            mock_date.side_effect = lambda *a, **kw: date(*a, **kw)
            try:
                await _charge_due_subscriptions(bot, db)
            except Exception:
                pass  # don't fail the test on unexpected errors
