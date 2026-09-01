"""Parity tests for the bot's financial-cycle resolver.

``bot/app/services/cycle.py`` is a hand-written mirror of
``backend/src/services/cycle.js``. Both read the same rows and quote the same figures back
to the same person, so a drift between them is not a cosmetic inconsistency — it is the
bot telling the user they are at 82% of a budget the dashboard reports as 61%.

The vectors below are deliberately the same ones ``tests/backend/cycle.test.js`` pins the
JS implementation to. Change one, change both.
"""

from datetime import date, timedelta

import pytest

from app.services import cycle as cy

ISRAELI = {"cycle_anchor_day": 10, "salary_day": 15}  # card settles on the 10th, paid on the 15th
DEFAULT = {"cycle_anchor_day": 1, "salary_day": 1}


class TestBoundaries:
    def test_runs_from_anchor_to_day_before_next_anchor(self):
        c = cy.resolve_cycle("2026-09", ISRAELI)
        assert c.start == date(2026, 9, 10)
        assert c.end == date(2026, 10, 10)      # exclusive
        assert c.last_day == date(2026, 10, 9)  # inclusive, for labels
        assert c.days == 30

    @pytest.mark.parametrize("key,days", [
        ("2026-02", 28),
        ("2024-02", 29),  # leap year
        ("2026-12", 31),
        ("2026-03", 31),
    ])
    def test_length_comes_from_the_calendar_underneath(self, key, days):
        assert cy.resolve_cycle(key, ISRAELI).days == days

    def test_rolls_over_the_year_end(self):
        c = cy.resolve_cycle("2026-12", ISRAELI)
        assert c.start == date(2026, 12, 10)
        assert c.end == date(2027, 1, 10)

    @pytest.mark.parametrize("key", ["2026-01", "2026-02", "2026-11", "2026-12"])
    def test_cycles_are_contiguous(self, key):
        """No expense may fall between two cycles, and none may fall in both."""
        assert cy.resolve_cycle(key, ISRAELI).end == \
            cy.resolve_cycle(cy.add_months(key, 1), ISRAELI).start


class TestWhichCycleADateBelongsTo:
    def test_anchor_day_opens_its_own_cycle(self):
        assert cy.cycle_key_of_date(date(2026, 9, 10), ISRAELI) == "2026-09"

    def test_day_before_the_anchor_belongs_to_the_previous_cycle(self):
        # The whole point of the feature: Sep 9's spending was already settled by the
        # Sep 10 charge, so it is August's money.
        assert cy.cycle_key_of_date(date(2026, 9, 9), ISRAELI) == "2026-08"
        assert cy.cycle_key_of_date(date(2026, 9, 1), ISRAELI) == "2026-08"

    def test_walks_back_across_a_year_boundary(self):
        assert cy.cycle_key_of_date(date(2026, 1, 3), ISRAELI) == "2025-12"

    def test_round_trips_for_every_day_of_a_cycle(self):
        c = cy.resolve_cycle("2026-09", ISRAELI)
        for d in range(1, c.days + 1):
            at = date(2026, 9, 9) + timedelta(days=d)
            assert cy.cycle_key_of_date(at, ISRAELI) == "2026-09"
            assert cy.day_index_in(c, at) == d

    def test_day_index_is_zero_before_and_clamped_after(self):
        c = cy.resolve_cycle("2026-09", ISRAELI)
        assert cy.day_index_in(c, date(2026, 9, 9)) == 0
        assert cy.day_index_in(c, date(2026, 12, 25)) == c.days


class TestIncomeMapping:
    def test_own_month_when_payday_is_on_or_after_the_anchor(self):
        assert cy.income_month_of("2026-09", ISRAELI) == "2026-09"
        assert cy.income_month_of("2026-09", {"cycle_anchor_day": 10, "salary_day": 10}) == "2026-09"

    def test_next_month_when_payday_falls_before_the_anchor(self):
        # Paid on the 5th with a cycle opening on the 10th: the salary inside
        # Sep 10 - Oct 9 is the one tagged October, paid Oct 5.
        assert cy.income_month_of("2026-09", {"cycle_anchor_day": 10, "salary_day": 5}) == "2026-10"


class TestValidationAndCoercion:
    @pytest.mark.parametrize("settings", [
        None, {}, {"cycle_anchor_day": 0}, {"cycle_anchor_day": 99},
        {"cycle_anchor_day": "nonsense"},
    ])
    def test_unusable_settings_fall_back_to_the_calendar_month(self, settings):
        # A period that silently becomes undefined is far worse than one that is merely
        # not customised.
        anchor, _ = cy.normalize_settings(settings)
        assert anchor == 1


class TestDefaultsAreTheOldBehaviour:
    """With anchor 1 every derivation must reduce to the calendar month, exactly."""

    KEYS = ["2025-12", "2026-01", "2026-02", "2024-02", "2026-04", "2026-09"]

    @pytest.mark.parametrize("key", KEYS)
    def test_starts_on_the_first(self, key):
        y, m = cy.parse_key(key)
        c = cy.resolve_cycle(key, DEFAULT)
        assert c.start == date(y, m, 1)
        assert c.start.day == 1

    @pytest.mark.parametrize("key", KEYS)
    def test_income_month_is_the_key_itself(self, key):
        assert cy.income_month_of(key, DEFAULT) == key

    def test_no_date_shift_is_needed(self):
        assert cy.anchor_shift_days(DEFAULT) == 0


class TestParityWithTheJsImplementation:
    """The exact vectors tests/backend/cycle.test.js asserts on the JS side."""

    VECTORS = [
        # (anchor, salary_day, key, start, end, days, income_month)
        (10, 15, "2026-09", "2026-09-10", "2026-10-10", 30, "2026-09"),
        (10, 15, "2026-02", "2026-02-10", "2026-03-10", 28, "2026-02"),
        (10, 15, "2026-12", "2026-12-10", "2027-01-10", 31, "2026-12"),
        (10, 5, "2026-09", "2026-09-10", "2026-10-10", 30, "2026-10"),
        (1, 1, "2026-02", "2026-02-01", "2026-03-01", 28, "2026-02"),
        (28, 28, "2026-01", "2026-01-28", "2026-02-28", 31, "2026-01"),
    ]

    @pytest.mark.parametrize("anchor,salary,key,start,end,days,income", VECTORS)
    def test_matches(self, anchor, salary, key, start, end, days, income):
        c = cy.resolve_cycle(key, {"cycle_anchor_day": anchor, "salary_day": salary})
        assert c.start.isoformat() == start
        assert c.end.isoformat() == end
        assert c.days == days
        assert c.income_month == income
