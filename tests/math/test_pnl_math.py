"""
Pure math tests for the BOT's weekly spending score, run against the real functions.

This file used to hold a Python transliteration of the backend's P&L formulas. Two
problems with that: it could not import the JavaScript it claimed to mirror, so it drifted
(its `current_net` subtracted subscriptions, which the controller deliberately does not),
and it duplicated coverage that `pnl_math.test.js` now provides against the actual module.

What is genuinely written in Python is the bot's Saturday spending score, so that is what
this file tests now — importing `bot/app/scheduler.py` rather than restating it.
"""
import os
import sys
from datetime import date, timedelta
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'bot'))

# apscheduler is only installed inside Docker — mock it for local runs, the same way
# tests/bot/conftest.py does. This file lives outside that conftest's directory.
for _mod in [
    'apscheduler',
    'apscheduler.schedulers',
    'apscheduler.schedulers.asyncio',
    'apscheduler.triggers',
    'apscheduler.triggers.cron',
]:
    sys.modules.setdefault(_mod, MagicMock())

from app.scheduler import _week_start, _format_score_message  # noqa: E402


# ── _week_start: the Israeli week begins on Sunday ────────────────────────────

class TestWeekStart:
    """
    The job runs on Saturday and used to anchor the window to Monday. That pushed Sunday —
    the first working day of the Israeli week — into the *previous* week's total, so every
    score was computed over a window that both dropped a real spending day and straddled
    two weeks as the user experiences them.
    """

    def test_every_day_of_the_week_anchors_to_a_sunday(self):
        for offset in range(14):
            d = date(2026, 8, 16) + timedelta(days=offset)
            assert _week_start(d).weekday() == 6, f"{d} anchored to a non-Sunday"

    def test_sunday_anchors_to_itself(self):
        sunday = date(2026, 8, 16)
        assert sunday.weekday() == 6
        assert _week_start(sunday) == sunday

    def test_monday_looks_back_one_day_not_forward_six(self):
        assert _week_start(date(2026, 8, 17)) == date(2026, 8, 16)

    def test_saturday_gives_a_full_seven_day_window(self):
        saturday = date(2026, 8, 22)
        assert saturday.weekday() == 5
        elapsed = (saturday - _week_start(saturday)).days + 1
        assert elapsed == 7

    def test_sunday_spend_lands_in_the_current_week_not_the_previous_one(self):
        # The concrete regression: on the Saturday job, the Sunday six days earlier must
        # be inside the window. Under the old Monday anchor it was not.
        saturday = date(2026, 8, 22)
        sunday = date(2026, 8, 16)
        assert _week_start(saturday) <= sunday

    def test_anchor_never_moves_into_the_future(self):
        for offset in range(30):
            d = date(2026, 1, 1) + timedelta(days=offset)
            assert _week_start(d) <= d

    def test_window_is_never_longer_than_a_week(self):
        for offset in range(30):
            d = date(2026, 1, 1) + timedelta(days=offset)
            assert 1 <= (d - _week_start(d)).days + 1 <= 7

    def test_crosses_a_month_boundary(self):
        # 1 Sep 2026 is a Tuesday; its week starts on 30 Aug.
        assert _week_start(date(2026, 9, 1)) == date(2026, 8, 30)

    def test_crosses_a_year_boundary(self):
        # 1 Jan 2027 is a Friday; its week starts on 27 Dec 2026.
        assert _week_start(date(2027, 1, 1)) == date(2026, 12, 27)


# ── _format_score_message: elapsed days compared to elapsed days ──────────────

def _data(week_total, weekly_avg, elapsed_days=7):
    """Shape `_compute_spending_score` returns, without touching a database."""
    return {
        "week_total": week_total,
        "weekly_avg": weekly_avg,
        "expected": weekly_avg * (elapsed_days / 7),
        "elapsed_days": elapsed_days,
    }


class TestScoreMessage:
    def test_no_history_says_so_instead_of_dividing_by_zero(self):
        msg = _format_score_message(_data(500, 0))
        assert "Not enough history" in msg

    def test_zero_expectation_is_also_guarded(self):
        msg = _format_score_message(_data(500, 1000, elapsed_days=0))
        assert "Not enough history" in msg

    def test_spending_nothing_grades_excellent(self):
        assert "Excellent" in _format_score_message(_data(0, 1000))

    def test_on_track_grades_good(self):
        # Exactly the expectation → ratio 1.0, the top of the "Good" band.
        assert "Good" in _format_score_message(_data(1000, 1000))

    def test_grade_boundaries_land_on_the_documented_side(self):
        assert "Excellent" in _format_score_message(_data(800, 1000))          # ratio 0.80
        assert "Good" in _format_score_message(_data(810, 1000))               # 0.81
        assert "Over budget" in _format_score_message(_data(1010, 1000))       # 1.01
        assert "Way over budget" in _format_score_message(_data(1210, 1000))   # 1.21

    def test_the_grade_agrees_with_the_percentage_it_prints(self):
        # The ratio is rounded to the precision the message reports, so a user cannot be
        # told they spent "0% more than usual" and graded "Over budget" in the same breath.
        msg = _format_score_message(_data(1000.2, 1000))
        assert "0%" in msg
        assert "Over budget" not in msg

    def test_double_the_expectation_is_way_over(self):
        assert "Way over budget" in _format_score_message(_data(2000, 1000))

    def test_partial_week_is_measured_against_a_partial_expectation(self):
        """
        The bug this fixes: a 6-elapsed-day window was compared against a full 7-day
        average, so a user spending exactly on pace was told they were ~14% under.
        """
        # Six days at exactly the daily pace of a ₪1,000 week.
        six_days_on_pace = 1000 * 6 / 7
        msg = _format_score_message(_data(six_days_on_pace, 1000, elapsed_days=6))
        assert "Good" in msg
        assert "0%" in msg  # not "14% less than usual"

    def test_a_partial_week_can_still_be_graded_over(self):
        # Half the week gone, but a full week's money already spent.
        msg = _format_score_message(_data(1000, 1000, elapsed_days=3))
        assert "Way over budget" in msg

    def test_reports_the_window_length_so_the_number_is_readable(self):
        msg = _format_score_message(_data(500, 1000, elapsed_days=4))
        assert "4d" in msg

    def test_direction_wording_follows_the_sign(self):
        assert "more" in _format_score_message(_data(1500, 1000))
        assert "less" in _format_score_message(_data(500, 1000))

    @pytest.mark.parametrize("week,avg,days", [
        (0, 0, 0), (0, 1000, 1), (99999, 1, 7), (0.01, 0.01, 7), (500, 1000, 7),
    ])
    def test_never_raises_on_any_plausible_input(self, week, avg, days):
        assert isinstance(_format_score_message(_data(week, avg, days)), str)
