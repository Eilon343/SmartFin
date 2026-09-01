const cy = require('../../backend/src/services/cycle');

/**
 * The financial cycle resolver — the single definition of a period in the app.
 *
 * The load-bearing test in this file is the LAST describe block: with the default settings
 * (anchor 1, salary day 1) every derivation must reduce exactly to the calendar month the
 * app used before cycles existed. That identity is what makes the migration a no-op for
 * every user who has not configured anything.
 */

const ISRAELI = { cycle_anchor_day: 10, salary_day: 15 }; // card settles on the 10th, paid on the 15th
const DEFAULT = { cycle_anchor_day: 1, salary_day: 1 };

// ── boundaries ────────────────────────────────────────────────────────────────

describe('resolveCycle - boundaries', () => {
    it('runs from the anchor day to the day before the next anchor day', () => {
        const c = cy.resolveCycle('2026-09', ISRAELI);
        expect(c.start).toBe('2026-09-10');
        expect(c.end).toBe('2026-10-10');      // exclusive, straight into `created_at < ?`
        expect(c.last_day).toBe('2026-10-09'); // inclusive, what the UI labels
        expect(c.days).toBe(30);
    });

    it('inherits its length from the calendar underneath it, so nothing may assume 30', () => {
        // Feb 10 - Mar 9 is 28 days; Dec 10 - Jan 9 is 31. A cycle is not a fixed window.
        expect(cy.resolveCycle('2026-02', ISRAELI).days).toBe(28);
        expect(cy.resolveCycle('2024-02', ISRAELI).days).toBe(29); // leap year
        expect(cy.resolveCycle('2026-12', ISRAELI).days).toBe(31);
        expect(cy.resolveCycle('2026-03', ISRAELI).days).toBe(31);
    });

    it('rolls over the year end', () => {
        const c = cy.resolveCycle('2026-12', ISRAELI);
        expect(c.start).toBe('2026-12-10');
        expect(c.end).toBe('2027-01-10');
    });

    it('is contiguous — one cycle ends exactly where the next begins', () => {
        // No expense may fall between two cycles, and none may fall in both.
        for (const m of ['2026-01', '2026-02', '2026-11', '2026-12']) {
            const cur = cy.resolveCycle(m, ISRAELI);
            const next = cy.resolveCycle(cy.addMonths(m, 1), ISRAELI);
            expect(cur.end).toBe(next.start);
        }
    });
});

// ── which cycle a date belongs to ─────────────────────────────────────────────

describe('cycleKeyOfDate / currentCycleKey', () => {
    it('puts the anchor day itself in the cycle it opens', () => {
        expect(cy.cycleKeyOfDate(new Date(2026, 8, 10), ISRAELI)).toBe('2026-09');
    });

    it('puts the day before the anchor in the PREVIOUS cycle', () => {
        // This is the whole point of the feature: spending on Sep 9 was already settled by
        // the Sep 10 charge, so it belongs to August's money, not September's.
        expect(cy.cycleKeyOfDate(new Date(2026, 8, 9), ISRAELI)).toBe('2026-08');
        expect(cy.cycleKeyOfDate(new Date(2026, 8, 1), ISRAELI)).toBe('2026-08');
    });

    it('walks back across a year boundary', () => {
        expect(cy.cycleKeyOfDate(new Date(2026, 0, 3), ISRAELI)).toBe('2025-12');
    });

    it('round-trips against resolveCycle for every day of a cycle', () => {
        const c = cy.resolveCycle('2026-09', ISRAELI);
        for (let d = 1; d <= c.days; d++) {
            const date = new Date(2026, 8, 9 + d); // Sep 10 .. Oct 9
            expect(cy.cycleKeyOfDate(date, ISRAELI)).toBe('2026-09');
            expect(cy.dayIndexIn(c, date)).toBe(d);
        }
    });

    it('reports 0 for a date before the cycle opens and clamps after it closes', () => {
        const c = cy.resolveCycle('2026-09', ISRAELI);
        expect(cy.dayIndexIn(c, new Date(2026, 8, 9))).toBe(0);
        expect(cy.dayIndexIn(c, new Date(2026, 11, 25))).toBe(c.days);
    });
});

// ── income mapping ────────────────────────────────────────────────────────────

describe('incomeMonthOf - the missing day on income.month', () => {
    it('takes the cycle\'s own start month when payday is on or after the anchor', () => {
        // Paid Sep 15, cycle is Sep 10 - Oct 9: the salary lands inside its own month.
        expect(cy.incomeMonthOf('2026-09', ISRAELI)).toBe('2026-09');
        expect(cy.incomeMonthOf('2026-09', { cycle_anchor_day: 10, salary_day: 10 })).toBe('2026-09');
    });

    it('takes the NEXT month when payday falls before the anchor', () => {
        // Paid on the 5th with a cycle opening on the 10th: the salary that lands inside
        // Sep 10 - Oct 9 is the one tagged October, paid Oct 5.
        expect(cy.incomeMonthOf('2026-09', { cycle_anchor_day: 10, salary_day: 5 })).toBe('2026-10');
    });

    it('inverts cleanly, so history can be aged by cycle rather than by income month', () => {
        for (const s of [ISRAELI, { cycle_anchor_day: 10, salary_day: 5 }, DEFAULT]) {
            for (const key of ['2025-12', '2026-01', '2026-09']) {
                expect(cy.cycleKeyOfIncomeMonth(cy.incomeMonthOf(key, s), s)).toBe(key);
            }
        }
    });
});

// ── subscription billing days ─────────────────────────────────────────────────

describe('chargeDateInCycle', () => {
    const c = cy.resolveCycle('2026-09', ISRAELI); // Sep 10 - Oct 9

    it('places a billing day on whichever side of the anchor it belongs to', () => {
        expect(cy.chargeDateInCycle(c, 12)).toBe('2026-09-12'); // >= anchor → start month
        expect(cy.chargeDateInCycle(c, 3)).toBe('2026-10-03');  // <  anchor → end month
    });

    it('orders the two sides correctly — the numerically smaller day is the LATER one', () => {
        // The bug the old SQL `day_of_month > DAY(CURDATE())` had: a numeric comparison
        // ranks day 3 before day 12, when in this cycle it comes three weeks after.
        expect(cy.chargeDateInCycle(c, 3) > cy.chargeDateInCycle(c, 12)).toBe(true);
    });

    it('clamps a billing day past the end of its month, as a real direct debit does', () => {
        const feb = cy.resolveCycle('2026-01', ISRAELI); // Jan 10 - Feb 9
        expect(cy.chargeDateInCycle(feb, 31)).toBe('2026-01-31');
        const spanningFeb = cy.resolveCycle('2026-02', { cycle_anchor_day: 28, salary_day: 1 });
        expect(cy.chargeDateInCycle(spanningFeb, 31)).toBe('2026-02-28');
    });

    it('lands every billing day inside the cycle it was resolved against', () => {
        for (let dom = 1; dom <= 28; dom++) {
            const at = cy.chargeDateInCycle(c, dom);
            expect(at >= c.start).toBe(true);
            expect(at < c.end).toBe(true);
        }
    });
});

// ── validation and coercion ───────────────────────────────────────────────────

describe('settings validation', () => {
    it('accepts only whole days in 1..28', () => {
        expect(cy.isValidDay(1)).toBe(true);
        expect(cy.isValidDay(28)).toBe(true);
        expect(cy.isValidDay(0)).toBe(false);
        expect(cy.isValidDay(29)).toBe(false); // would not exist in February
        expect(cy.isValidDay(31)).toBe(false);
        expect(cy.isValidDay(10.5)).toBe(false);
        expect(cy.isValidDay('abc')).toBe(false);
        // A numeric string is accepted: the settings form posts its number input as one,
        // and rejecting it would fail a request that is plainly well formed.
        expect(cy.isValidDay('10')).toBe(true);
    });

    it('falls back to the calendar month rather than producing an undefined period', () => {
        // A period that silently becomes NaN is far worse than one that is merely not
        // customised, so anything unusable normalises to 1.
        for (const bad of [undefined, null, {}, { cycle_anchor_day: 0 }, { cycle_anchor_day: 99 }]) {
            expect(cy.normalizeSettings(bad).anchor).toBe(1);
        }
    });
});

// ── parity with the bot ───────────────────────────────────────────────────────

describe('parity with bot/app/services/cycle.py', () => {
    // The bot is a hand-written mirror of this module and reads the same rows, so a drift
    // between them means the bot quoting a budget percentage the dashboard contradicts.
    // tests/bot/test_cycle.py asserts this exact table. Change one, change both.
    const VECTORS = [
        // [anchor, salaryDay, key, start, end, days, incomeMonth]
        [10, 15, '2026-09', '2026-09-10', '2026-10-10', 30, '2026-09'],
        [10, 15, '2026-02', '2026-02-10', '2026-03-10', 28, '2026-02'],
        [10, 15, '2026-12', '2026-12-10', '2027-01-10', 31, '2026-12'],
        [10, 5, '2026-09', '2026-09-10', '2026-10-10', 30, '2026-10'],
        [1, 1, '2026-02', '2026-02-01', '2026-03-01', 28, '2026-02'],
        [28, 28, '2026-01', '2026-01-28', '2026-02-28', 31, '2026-01'],
    ];

    it.each(VECTORS)('anchor %i / salary %i, cycle %s', (anchor, salaryDay, key, start, end, days, income) => {
        const c = cy.resolveCycle(key, { cycle_anchor_day: anchor, salary_day: salaryDay });
        expect(c.start).toBe(start);
        expect(c.end).toBe(end);
        expect(c.days).toBe(days);
        expect(c.income_month).toBe(income);
    });
});

// ── the regression guarantee ──────────────────────────────────────────────────

describe('anchor = 1 is byte-identical to the old calendar-month behaviour', () => {
    const months = ['2025-12', '2026-01', '2026-02', '2024-02', '2026-04', '2026-09'];

    it('starts on the 1st and ends on the 1st of the next month', () => {
        for (const m of months) {
            const c = cy.resolveCycle(m, DEFAULT);
            expect(c.start).toBe(`${m}-01`);
            expect(c.end).toBe(`${cy.addMonths(m, 1)}-01`);
        }
    });

    it('has exactly as many days as the calendar month', () => {
        for (const m of months) {
            const [y, mm] = m.split('-').map(Number);
            expect(cy.resolveCycle(m, DEFAULT).days).toBe(new Date(y, mm, 0).getDate());
        }
    });

    it('maps each cycle to its own income month', () => {
        for (const m of months) expect(cy.incomeMonthOf(m, DEFAULT)).toBe(m);
    });

    it('needs no date shift, so every SQL bucket is a plain month truncation', () => {
        expect(cy.anchorShiftDays(DEFAULT)).toBe(0);
    });

    it('reports the day of the month as the day of the cycle', () => {
        const c = cy.resolveCycle('2026-09', DEFAULT);
        expect(cy.dayIndexIn(c, new Date(2026, 8, 1))).toBe(1);
        expect(cy.dayIndexIn(c, new Date(2026, 8, 20))).toBe(20);
    });
});
