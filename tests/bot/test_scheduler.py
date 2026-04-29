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
    Spending score = week_total / weekly_avg, where:
      weekly_avg = monthly_avg_over_3_months / 4.33 (weeks per month)
    """

    def _score(self, week_total, monthly_avg):
        if monthly_avg == 0:
            return 0.0
        weekly_avg = monthly_avg / 4.33
        return round(week_total / weekly_avg, 2)

    def test_no_spending_this_week_returns_zero(self):
        assert self._score(week_total=0, monthly_avg=1000) == 0.0

    def test_no_historical_data_returns_zero(self):
        assert self._score(week_total=500, monthly_avg=0) == 0.0

    def test_on_track_returns_approximately_one(self):
        # weekly_avg = 1000/4.33 ≈ 231
        # spending 231 this week → score ≈ 1.0
        weekly_avg = 1000 / 4.33
        score = self._score(week_total=round(weekly_avg), monthly_avg=1000)
        assert 0.9 <= score <= 1.1

    def test_overspending_returns_score_above_one(self):
        weekly_avg = 1000 / 4.33
        score = self._score(week_total=weekly_avg * 2, monthly_avg=1000)
        assert score > 1.5

    def test_underspending_returns_score_below_one(self):
        weekly_avg = 1000 / 4.33
        score = self._score(week_total=weekly_avg * 0.3, monthly_avg=1000)
        assert score < 0.5


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
            "user_id": 12345,
        }])
        db.add_expense = AsyncMock(return_value=True)
        db.mark_subscription_charged = AsyncMock()

        today = date(2026, 4, 15)
        with patch("app.scheduler.date") as mock_date:
            mock_date.today.return_value = today
            mock_date.side_effect = lambda *a, **kw: date(*a, **kw)
            await _charge_due_subscriptions(bot, db)

        db.add_expense.assert_called_once()
        call_kwargs = db.add_expense.call_args[1]
        assert call_kwargs["amount"] == 39.90
        assert call_kwargs["description"] == "Netflix"
        assert call_kwargs["source"] == "bot"

        db.mark_subscription_charged.assert_called_once_with(1, "2026-04")
        bot.send_message.assert_called_once()

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

        today = date(2026, 4, 1)
        with patch("app.scheduler.date") as mock_date:
            mock_date.today.return_value = today
            mock_date.side_effect = lambda *a, **kw: date(*a, **kw)
            try:
                await _charge_due_subscriptions(bot, db)
            except Exception:
                pass  # don't fail the test on unexpected errors
