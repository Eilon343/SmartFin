"""The bot's copy of the financial-cycle resolver.

A deliberate mirror of ``backend/src/services/cycle.js``. The bot talks to the same
database and quotes the same figures back to the user, so it has to agree with the web
app about where a period starts — a budget warning that says "82% of your food budget"
must be measuring the same window the dashboard is.

A cycle runs from the user's ``cycle_anchor_day`` to the day before the next anchor day,
and is keyed by the 'YYYY-MM' of the month it STARTS in. ``salary_day`` reconstructs the
missing day on ``income.month``.

The anchor is restricted to 1..28 for the same reason as on the JS side: recovering a
cycle key from a date is a shift by (anchor - 1) days, and that is only exact for a day
that exists in every month.

Keep the two implementations in step. ``tests/bot/test_cycle.py`` runs this module over
the same vectors ``tests/backend/cycle.test.js`` pins the JS one to.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

DEFAULT_ANCHOR = 1
DEFAULT_SALARY_DAY = 1
MIN_DAY = 1
MAX_DAY = 28


@dataclass(frozen=True)
class Cycle:
    key: str          # 'YYYY-MM' — the month the cycle starts in
    anchor: int
    salary_day: int
    start: date       # inclusive
    end: date         # exclusive
    last_day: date    # inclusive, for labels
    days: int
    income_month: str


def _clamp_day(value, fallback: int) -> int:
    """A settings value coerced to a usable day, or the calendar-month default.

    Anything unusable normalises to the fallback rather than raising: a period that
    silently becomes undefined is far worse than one that is merely not customised.
    """
    try:
        n = int(value)
    except (TypeError, ValueError):
        return fallback
    return n if MIN_DAY <= n <= MAX_DAY else fallback


def normalize_settings(settings: dict | None) -> tuple[int, int]:
    """(anchor, salary_day) from a `users` row, however incomplete."""
    settings = settings or {}
    return (
        _clamp_day(settings.get("cycle_anchor_day"), DEFAULT_ANCHOR),
        _clamp_day(settings.get("salary_day"), DEFAULT_SALARY_DAY),
    )


def parse_key(key: str) -> tuple[int, int]:
    y, m = key.split("-")
    return int(y), int(m)


def add_months(key: str, n: int) -> str:
    y, m = parse_key(key)
    total = y * 12 + (m - 1) + n
    return f"{total // 12}-{total % 12 + 1:02d}"


def income_month_of(key: str, settings: dict | None) -> str:
    """Which ``income.month`` row funds this cycle.

    With a payday on or after the anchor the salary lands inside the cycle's own start
    month. Below the anchor it has not arrived when the cycle opens, so the row that falls
    inside is the NEXT month's — anchor 10 / salary 5 means the cycle '2026-09'
    (Sep 10 - Oct 9) is funded by income month '2026-10', paid Oct 5.
    """
    anchor, salary_day = normalize_settings(settings)
    return key if salary_day >= anchor else add_months(key, 1)


def resolve_cycle(key: str, settings: dict | None) -> Cycle:
    anchor, salary_day = normalize_settings(settings)
    y, m = parse_key(key)
    ny, nm = parse_key(add_months(key, 1))
    start = date(y, m, anchor)
    end = date(ny, nm, anchor)
    return Cycle(
        key=key,
        anchor=anchor,
        salary_day=salary_day,
        start=start,
        end=end,
        last_day=end - timedelta(days=1),
        days=(end - start).days,
        income_month=income_month_of(key, settings),
    )


def cycle_key_of_date(at: date, settings: dict | None) -> str:
    """Which cycle contains ``at``. A date before the anchor belongs to the previous one."""
    anchor, _ = normalize_settings(settings)
    key = f"{at.year}-{at.month:02d}"
    return key if at.day >= anchor else add_months(key, -1)


def current_cycle_key(settings: dict | None, now: date | None = None) -> str:
    """The cycle we are living in right now — the bot's only source of "this period"."""
    return cycle_key_of_date(now or date.today(), settings)


def anchor_shift_days(settings: dict | None) -> int:
    """The constant for ``DATE_FORMAT(DATE_SUB(created_at, INTERVAL %s DAY), '%Y-%m')``.

    Shifting a date back by (anchor - 1) days moves the anchor onto the 1st, so the
    ordinary month truncation then yields the cycle key.
    """
    anchor, _ = normalize_settings(settings)
    return anchor - 1


def day_index_in(cycle: Cycle, at: date) -> int:
    """Position of ``at`` within a cycle, 1..days. 0 before it opens, clamped after."""
    idx = (at - cycle.start).days + 1
    if idx < 1:
        return 0
    return min(idx, cycle.days)
