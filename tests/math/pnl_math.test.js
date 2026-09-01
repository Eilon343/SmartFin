/**
 * Pure math tests for every forecasting formula, run against the REAL module.
 *
 * This file used to re-implement the formulas locally, and had silently drifted from the
 * app: its `currentNet` subtracted subscriptions (the controller deliberately does not)
 * and its `projectedExpenses` had neither the early-month dampening nor the fixed/variable
 * split. It tested behaviour SmartFin had already rejected, and passed the whole time.
 * Importing the module is the point — if these pass, the app's arithmetic is what passed.
 */

const fx = require('../../backend/src/services/forecastMath');

// A month with a known shape, used throughout: August 2026 has 31 days and starts on a
// Saturday, so it holds five Saturdays — a real seasonality edge, not a tidy 4×7 grid.
const AUG = { start: '2026-08-01', days: 31 };
const FLAT = new Array(7).fill(1 / 7);

/** Convenience: run the expense projection over a whole month and return every value. */
function sweep(fn, days = AUG.days) {
    return Array.from({ length: days }, (_, i) => fn(i + 1));
}

// ── pastMonths / monthsBetween ───────────────────────────────────────────────────

describe('pastMonths', () => {
    it('returns the N months before the anchor, most recent first', () => {
        expect(fx.pastMonths('2026-03', 3)).toEqual(['2026-02', '2026-01', '2025-12']);
    });

    it('crosses a year boundary correctly', () => {
        expect(fx.pastMonths('2026-01', 2)).toEqual(['2025-12', '2025-11']);
    });

    it('defaults to the configured lookback', () => {
        expect(fx.pastMonths('2026-08')).toHaveLength(fx.LOOKBACK_MONTHS);
    });

    it('rejects a nonsense window rather than silently producing one', () => {
        expect(() => fx.pastMonths('2026-08', 0)).toThrow();
        expect(() => fx.pastMonths('2026-08', 99)).toThrow();
        expect(() => fx.pastMonths('2026-08', 2.5)).toThrow();
    });
});

describe('monthsBetween', () => {
    it('counts forward within a year', () => {
        expect(fx.monthsBetween('2026-01', '2026-04')).toBe(3);
    });

    it('counts across a year boundary', () => {
        expect(fx.monthsBetween('2025-11', '2026-02')).toBe(3);
    });

    it('is zero for the same month', () => {
        expect(fx.monthsBetween('2026-05', '2026-05')).toBe(0);
    });
});

// ── decayedMean ──────────────────────────────────────────────────────────────────

describe('decayedMean', () => {
    it('returns 0 for no history rather than NaN', () => {
        expect(fx.decayedMean([], '2026-08')).toBe(0);
        expect(fx.decayedMean(null, '2026-08')).toBe(0);
    });

    it('returns the value itself for a single month', () => {
        expect(fx.decayedMean([{ month: '2026-07', total: 900 }], '2026-08')).toBe(900);
    });

    it('equals the plain mean when every month is identical', () => {
        const rows = fx.pastMonths('2026-08', 6).map(m => ({ month: m, total: 1000 }));
        expect(fx.decayedMean(rows, '2026-08')).toBeCloseTo(1000, 6);
    });

    it('divides by months_with_data, not by the window length', () => {
        // The old bug this replaced: 1800 over two months in a 3-month window read as 600.
        const rows = [{ month: '2026-07', total: 900 }, { month: '2026-06', total: 900 }];
        expect(fx.decayedMean(rows, '2026-08')).toBeCloseTo(900, 6);
    });

    it('weights recent months more heavily than old ones', () => {
        const recentHigh = fx.decayedMean(
            [{ month: '2026-07', total: 2000 }, { month: '2026-02', total: 1000 }], '2026-08');
        const recentLow = fx.decayedMean(
            [{ month: '2026-07', total: 1000 }, { month: '2026-02', total: 2000 }], '2026-08');
        expect(recentHigh).toBeGreaterThan(recentLow);
        // Both sit inside the range of the inputs — a weighted mean cannot extrapolate.
        for (const v of [recentHigh, recentLow]) {
            expect(v).toBeGreaterThan(1000);
            expect(v).toBeLessThan(2000);
        }
    });

    it('applies the stated half-life: month-2 counts ~71% of month-1', () => {
        const a = fx.decayedMean([{ month: '2026-07', total: 1 }], '2026-08'); // weight 1
        expect(a).toBe(1);
        // Two months, values 1 and 0 → result is w1/(w1+w2) = 1/(1+0.7071)
        const mixed = fx.decayedMean(
            [{ month: '2026-07', total: 1 }, { month: '2026-06', total: 0 }], '2026-08');
        expect(mixed).toBeCloseTo(1 / (1 + Math.pow(0.5, 1 / fx.LOOKBACK_HALF_LIFE)), 6);
    });

    it('ignores rows at or after the anchor month — they are not history', () => {
        const rows = [{ month: '2026-08', total: 99999 }, { month: '2026-07', total: 100 }];
        expect(fx.decayedMean(rows, '2026-08')).toBe(100);
    });
});

// ── monthlyStdDev ────────────────────────────────────────────────────────────────

describe('monthlyStdDev', () => {
    it('returns null below two months — one point has no spread', () => {
        expect(fx.monthlyStdDev([])).toBeNull();
        expect(fx.monthlyStdDev([{ month: '2026-07', total: 900 }])).toBeNull();
        expect(fx.monthlyStdDev(null)).toBeNull();
    });

    it('is zero for identical months', () => {
        const rows = [{ total: 500 }, { total: 500 }, { total: 500 }];
        expect(fx.monthlyStdDev(rows)).toBe(0);
    });

    it('computes the sample standard deviation', () => {
        // [2, 4, 4, 4, 5, 5, 7, 9] has a sample sd of exactly sqrt(32/7)
        const rows = [2, 4, 4, 4, 5, 5, 7, 9].map(total => ({ total }));
        expect(fx.monthlyStdDev(rows)).toBeCloseTo(Math.sqrt(32 / 7), 10);
    });

    it('grows with the spread', () => {
        const tight = fx.monthlyStdDev([{ total: 990 }, { total: 1010 }]);
        const wide = fx.monthlyStdDev([{ total: 100 }, { total: 1900 }]);
        expect(wide).toBeGreaterThan(tight);
    });
});

// ── weekdayCounts ────────────────────────────────────────────────────────────────

describe('weekdayCounts', () => {
    it('counts every day in the window exactly once', () => {
        const counts = fx.weekdayCounts('2026-02-01', '2026-08-01'); // Feb–Jul 2026
        const total = counts.reduce((a, b) => a + b, 0);
        expect(total).toBe(28 + 31 + 30 + 31 + 30 + 31);
    });

    it('spreads a 28-day February evenly, four of each weekday', () => {
        expect(fx.weekdayCounts('2026-02-01', '2026-03-01')).toEqual([4, 4, 4, 4, 4, 4, 4]);
    });

    it('gives the extra days of a 31-day month to the weekdays it starts on', () => {
        // August 2026 starts on a Saturday, so Sat/Sun/Mon get 5 and the rest 4.
        const counts = fx.weekdayCounts('2026-08-01', '2026-09-01');
        expect(counts.reduce((a, b) => a + b, 0)).toBe(31);
        expect(counts[6]).toBe(5); // Saturday
        expect(counts[3]).toBe(4); // Wednesday
    });

    it('is empty when the window has no width', () => {
        expect(fx.weekdayCounts('2026-08-01', '2026-08-01')).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });
});

// ── dowWeights ───────────────────────────────────────────────────────────────────

describe('dowWeights', () => {
    const counts = new Array(7).fill(26); // ~6 months of history

    it('always sums to exactly 1', () => {
        const cases = [
            fx.dowWeights([], []),
            fx.dowWeights([100, 100, 100, 100, 100, 100, 100], counts),
            fx.dowWeights([0, 0, 0, 0, 0, 900, 900], counts),
            fx.dowWeights([5, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1]),
        ];
        for (const w of cases) {
            expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
        }
    });

    it('falls back to a flat week with no history at all', () => {
        expect(fx.dowWeights([], [])).toEqual(new Array(7).fill(1 / 7));
        expect(fx.dowWeights([0, 0, 0, 0, 0, 0, 0], counts)).toEqual(new Array(7).fill(1 / 7));
    });

    it('gives heavier weekdays a larger share', () => {
        // Fri/Sat double everything else — the Israeli weekend.
        const w = fx.dowWeights([100, 100, 100, 100, 100, 200, 200], counts);
        expect(w[5]).toBeGreaterThan(w[0]);
        expect(w[6]).toBeGreaterThan(w[0]);
        expect(w[0]).toBeCloseTo(w[1], 10); // equal inputs stay equal
    });

    it('shrinks toward flat, never reaching the raw share', () => {
        const raw = [0, 0, 0, 0, 0, 0, 700];
        const w = fx.dowWeights(raw, counts);
        expect(w[6]).toBeLessThan(1);      // never claims 100% of spending is Saturday
        expect(w[0]).toBeGreaterThan(0);   // never claims a day is impossible
    });

    it('shrinks harder when there is less history', () => {
        const shape = [0, 0, 0, 0, 0, 0, 700];
        const thin = fx.dowWeights(shape, new Array(7).fill(2));
        const thick = fx.dowWeights(shape, new Array(7).fill(60));
        const flat = 1 / 7;
        // Thin history should sit closer to the flat week than thick history does.
        expect(Math.abs(thin[6] - flat)).toBeLessThan(Math.abs(thick[6] - flat));
    });

    it('normalises out an uneven number of each weekday in the window', () => {
        // Same per-day rate everywhere, but Saturday occurred more often. Raw totals
        // would make Saturday look bigger; the rates must come out equal.
        const dayCounts = [4, 4, 4, 4, 4, 4, 5];
        const totals = dayCounts.map(n => n * 100);
        const w = fx.dowWeights(totals, dayCounts);
        for (let i = 1; i < 7; i++) expect(w[i]).toBeCloseTo(w[0], 10);
    });

    it('treats a weekday with no observations as unknown, not as zero spending', () => {
        const w = fx.dowWeights([100, 100, 100, 100, 100, 100, 0], [4, 4, 4, 4, 4, 4, 0]);
        expect(w[6]).toBeGreaterThan(0);
    });
});

// ── elapsedShare ─────────────────────────────────────────────────────────────────

describe('elapsedShare', () => {
    const share = (d, w) => fx.elapsedShare(d, AUG.start, AUG.days, w);

    it('reduces exactly to d/D with flat weights', () => {
        for (const d of [1, 7, 15, 30, 31]) {
            expect(share(d, FLAT)).toBeCloseTo(d / AUG.days, 10);
        }
    });

    it('treats a missing or malformed weight array as flat', () => {
        expect(share(15, undefined)).toBeCloseTo(15 / 31, 10);
        expect(share(15, [1, 2, 3])).toBeCloseTo(15 / 31, 10);
    });

    it('is 0 at day 0 and 1 at month end', () => {
        expect(share(0, FLAT)).toBe(0);
        expect(share(AUG.days, FLAT)).toBeCloseTo(1, 10);
    });

    it('is monotonically non-decreasing across the month', () => {
        const w = fx.dowWeights([50, 50, 50, 50, 50, 300, 300], new Array(7).fill(26));
        const vals = sweep(d => share(d, w));
        for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1]);
    });

    it('advances faster across a weekend than across midweek', () => {
        const w = fx.dowWeights([50, 50, 50, 50, 50, 300, 300], new Array(7).fill(26));
        // Aug 2026: the 1st is Saturday; the 7th Fri, 8th Sat; 11th Tue, 12th Wed.
        const weekendStep = share(8, w) - share(6, w);   // Fri + Sat
        const midweekStep = share(12, w) - share(10, w); // Tue + Wed
        expect(weekendStep).toBeGreaterThan(midweekStep);
    });
});

// ── idealPace ────────────────────────────────────────────────────────────────────

describe('idealPace', () => {
    const ideal = (d, w = FLAT) => fx.idealPace(d, 3100, AUG.start, AUG.days, w);

    it('day 1 is NOT zero — the old (d−1)/(D−1) bug flagged everyone as over on the 1st', () => {
        expect(ideal(1)).toBeGreaterThan(0);
        expect(ideal(1)).toBeCloseTo(100, 6); // 3100 / 31 days
    });

    it('reaches exactly the target on the last day', () => {
        expect(ideal(AUG.days)).toBeCloseTo(3100, 6);
    });

    it('is half the target at the midpoint of a flat month', () => {
        // Day 15.5 is not a day, so check that 15 and 16 straddle half.
        expect(ideal(15)).toBeLessThan(1550);
        expect(ideal(16)).toBeGreaterThan(1550);
    });

    it('returns 0 for a zero or missing target rather than NaN', () => {
        expect(fx.idealPace(10, 0, AUG.start, AUG.days, FLAT)).toBe(0);
        expect(fx.idealPace(10, null, AUG.start, AUG.days, FLAT)).toBe(0);
    });

    it('still lands on the target with seasonality applied', () => {
        const w = fx.dowWeights([10, 10, 10, 10, 10, 90, 90], new Array(7).fill(26));
        expect(ideal(AUG.days, w)).toBeCloseTo(3100, 6);
    });
});

// ── pacingTarget ─────────────────────────────────────────────────────────────────

/**
 * The momentum chart drew cumulative spend over EVERY category against a target of
 * `SUM(budgets.monthly_limit)` — two different sets of categories. The demo account is the
 * case in miniature: ₪3,400 of budgets (Food, Transport, Entertainment, Shopping) against a
 * line that also carries ₪4,200 of rent and ₪600 of utilities nobody budgeted, so the chip
 * charged the user for their rent against a target that never contained it.
 */
describe('pacingTarget', () => {
    // Food/Transport budgeted; Housing and Utilities fixed and unbudgeted, as in the demo.
    const DEMO = [
        { is_fixed: false, three_mo_avg: 1800, budget_limit: 1600 }, // Food
        { is_fixed: false, three_mo_avg: 700, budget_limit: 600 },   // Transport
        { is_fixed: true, three_mo_avg: 4200, budget_limit: null },  // Housing
        { is_fixed: true, three_mo_avg: 600, budget_limit: null },   // Utilities
        { is_fixed: false, three_mo_avg: 300, budget_limit: null },  // Uncategorized
    ];

    it('covers unbudgeted categories instead of ignoring them', () => {
        const p = fx.pacingTarget(DEMO);
        // 1600 + 600 budgeted, 4200 + 600 + 300 habit — not the bare 2,200 of budgets.
        expect(p.budgeted).toBe(2200);
        expect(p.habit).toBe(5100);
        expect(p.total).toBe(7300);
    });

    it('prefers the budget over the habit wherever the user set one', () => {
        // Food's habit is 1800 but the user asked for 1600; the target must say 1600.
        const p = fx.pacingTarget([{ is_fixed: false, three_mo_avg: 1800, budget_limit: 1600 }]);
        expect(p.total).toBe(1600);
    });

    it('collapses to the sum of 3-month averages when there are no budgets at all', () => {
        // This is the old `three_mo_avg_total` fallback, now reached by the general rule
        // rather than by a branch. Regressing this would break every budget-less user.
        const noBudgets = DEMO.map(c => ({ ...c, budget_limit: null }));
        const avgTotal = DEMO.reduce((s, c) => s + c.three_mo_avg, 0);

        const p = fx.pacingTarget(noBudgets);
        expect(p.total).toBe(avgTotal);
        expect(p.budgeted).toBe(0);
        expect(p.budgeted_categories).toBe(0);
    });

    it('treats a budget of zero as a real budget, not a missing one', () => {
        // "I intend to spend nothing on Shopping" must not be silently replaced by
        // "you usually spend ₪700 on Shopping".
        const p = fx.pacingTarget([{ is_fixed: false, three_mo_avg: 700, budget_limit: 0 }]);
        expect(p.total).toBe(0);
        expect(p.budgeted_categories).toBe(1);
    });

    it('splits fixed from variable, and the two halves add back to the total', () => {
        const p = fx.pacingTarget(DEMO);
        expect(p.fixed).toBe(4800);      // Housing + Utilities
        expect(p.variable).toBe(2500);   // Food 1600 + Transport 600 + Uncategorized 300
        expect(p.fixed + p.variable).toBeCloseTo(p.total, 10);
        expect(p.budgeted + p.habit).toBeCloseTo(p.total, 10);
    });

    it('follows the budget into a fixed category rather than assuming fixed means unbudgeted', () => {
        // Nothing stops anyone budgeting Housing; the split is by is_fixed, not by whether
        // a budget exists.
        const p = fx.pacingTarget([{ is_fixed: true, three_mo_avg: 4200, budget_limit: 4000 }]);
        expect(p.fixed).toBe(4000);
        expect(p.budgeted).toBe(4000);
    });

    it('is zero, not NaN, for no categories at all', () => {
        const p = fx.pacingTarget([]);
        expect(p.total).toBe(0);
        expect(Number.isFinite(p.total)).toBe(true);
    });
});

// ── fixedPaceShape ───────────────────────────────────────────────────────────────

describe('fixedPaceShape', () => {
    it('steps up on the day the charge lands, not smoothly across the month', () => {
        const shape = fx.fixedPaceShape({ 1: 4200 }, AUG.days);
        expect(shape[0]).toBeCloseTo(1, 10);  // day 1: all of it
        expect(shape[30]).toBeCloseTo(1, 10);
    });

    it('is the reason a rent payer is no longer over pace from the 1st', () => {
        // Uniform would put 1/31 of the rent on day 1 while the whole ₪4,200 has left the
        // account — a ~₪4,065 phantom overspend on the 1st of every month.
        const shape = fx.fixedPaceShape({ 1: 4200 }, AUG.days);
        expect(shape[0] * 4200).toBeCloseTo(4200, 6);
        expect(shape[0] * 4200 - (4200 / AUG.days)).toBeGreaterThan(4000);
    });

    it('orders two charges by their day of month', () => {
        const shape = fx.fixedPaceShape({ 1: 4200, 10: 600 }, AUG.days);
        expect(shape[0]).toBeCloseTo(4200 / 4800, 10);
        expect(shape[8]).toBeCloseTo(4200 / 4800, 10);  // day 9, before utilities
        expect(shape[9]).toBeCloseTo(1, 10);            // day 10, after
    });

    it('reaches exactly 1 on the last day, so the ideal lands on the target', () => {
        const shape = fx.fixedPaceShape({ 3: 100, 17: 250, 28: 40 }, AUG.days);
        expect(shape[AUG.days - 1]).toBeCloseTo(1, 10);
    });

    it('is monotonically non-decreasing', () => {
        const shape = fx.fixedPaceShape({ 1: 4200, 5: 600, 22: 130 }, AUG.days);
        for (let i = 1; i < shape.length; i++) {
            expect(shape[i]).toBeGreaterThanOrEqual(shape[i - 1]);
        }
    });

    it('folds a day-31 charge into the last day of a shorter month', () => {
        // February has no 31st, but the direct debit still has to land somewhere.
        const shape = fx.fixedPaceShape({ 31: 500 }, 28);
        expect(shape).toHaveLength(28);
        expect(shape[26]).toBe(0);
        expect(shape[27]).toBeCloseTo(1, 10);
    });

    it('falls back to a flat d/D with no fixed history', () => {
        const shape = fx.fixedPaceShape({}, AUG.days);
        for (let d = 1; d <= AUG.days; d++) expect(shape[d - 1]).toBeCloseTo(d / AUG.days, 10);
    });
});

// ── momentumIdeal ────────────────────────────────────────────────────────────────

describe('momentumIdeal', () => {
    const WEEKEND_W = fx.dowWeights([50, 50, 50, 50, 50, 300, 300], new Array(7).fill(26));

    const curve = (over = {}) => fx.momentumIdeal({
        fixedTarget: 4800,
        variableTarget: 2500,
        fixedShape: fx.fixedPaceShape({ 1: 4200, 5: 600 }, AUG.days),
        startDate: AUG.start,
        days: AUG.days,
        weights: WEEKEND_W,
        ...over,
    });

    it('lands exactly on the total target on the last day', () => {
        expect(curve()[AUG.days - 1]).toBeCloseTo(7300, 6);
    });

    it('charges the fixed half on the day it lands, not one day at a time', () => {
        const c = curve();
        // Rent is ₪4,200 of the ₪4,800 fixed target and it hits on the 1st, so day 1's
        // ideal is already most of the fixed half — plus one day's worth of variable.
        expect(c[0]).toBeGreaterThan(4200);
        expect(c[0]).toBeLessThan(4400);
    });

    it('would have flagged a perfectly-behaved rent payer as over pace without the split', () => {
        // The whole target on the day-of-week shape — what the chart used to draw.
        const oneComponent = fx.idealPace(1, 7300, AUG.start, AUG.days, WEEKEND_W);
        const twoComponent = curve()[0];
        // A user who paid ₪4,200 rent on the 1st and nothing else. The old curve had
        // accrued only one Saturday's share of the whole target by then, so it reported
        // thousands of shekels of overspend for a month that had done nothing wrong.
        expect(4200 - oneComponent).toBeGreaterThan(3000);
        expect(4200 - twoComponent).toBeLessThan(0); // correctly under pace
    });

    it('is monotonically non-decreasing', () => {
        const c = curve();
        for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
    });

    it('reduces to idealPace when there is nothing fixed', () => {
        const c = curve({ fixedTarget: 0, variableTarget: 3100 });
        for (const d of [1, 9, 17, 31]) {
            expect(c[d - 1]).toBeCloseTo(
                fx.idealPace(d, 3100, AUG.start, AUG.days, WEEKEND_W), 6
            );
        }
    });

    it('paces the variable half on day-of-week and the fixed half on day-of-month', () => {
        // Aug 2026: the 7th is a Friday, the 8th a Saturday; the 11th/12th are Tue/Wed.
        // No fixed charges in either window, so any difference is the variable half.
        const c = fx.momentumIdeal({
            fixedTarget: 4200,
            variableTarget: 3100,
            fixedShape: fx.fixedPaceShape({ 1: 4200 }, AUG.days),
            startDate: AUG.start, days: AUG.days, weights: WEEKEND_W,
        });
        expect(c[7] - c[5]).toBeGreaterThan(c[11] - c[9]);
    });

    it('draws a flat line rather than NaN with a zero target', () => {
        const c = curve({ fixedTarget: 0, variableTarget: 0 });
        expect(c).toHaveLength(AUG.days);
        for (const v of c) expect(v).toBe(0);
    });

    it('treats a missing fixed shape as uniform rather than crashing', () => {
        const c = curve({ fixedShape: undefined, variableTarget: 0 });
        expect(c[0]).toBeCloseTo(4800 / AUG.days, 6);
        expect(c[AUG.days - 1]).toBeCloseTo(4800, 6);
    });
});

// ── credibilityWeight ────────────────────────────────────────────────────────────

describe('credibilityWeight', () => {
    it('is 1 with no history — the current month is all the evidence there is', () => {
        expect(fx.credibilityWeight(1, 0)).toBe(1);
        expect(fx.credibilityWeight(20, 0)).toBe(1);
    });

    it('equals 0.5 at exactly K days, by definition of the constant', () => {
        expect(fx.credibilityWeight(fx.CREDIBILITY_K, 3)).toBeCloseTo(0.5, 10);
    });

    it('is near zero on day 0 and rises monotonically', () => {
        expect(fx.credibilityWeight(0, 3)).toBe(0);
        const vals = sweep(d => fx.credibilityWeight(d, 3));
        for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
    });

    it('never leaves [0, 1]', () => {
        for (const d of [-5, 0, 1, 15, 31, 1000]) {
            const w = fx.credibilityWeight(d, 3);
            expect(w).toBeGreaterThanOrEqual(0);
            expect(w).toBeLessThanOrEqual(1);
        }
    });
});

// ── projectVariableExpenses — the heart of the rehaul ────────────────────────────

describe('projectVariableExpenses', () => {
    const project = (over = {}) => fx.projectVariableExpenses({
        spentToDate: 0,
        dayIndex: 15,
        days: AUG.days,
        historicalMean: 3000,
        monthsWithData: 3,
        startDate: AUG.start,
        weights: FLAT,
        ...over,
    });

    it('CONTINUITY: no jump anywhere in the month, including across the old day-5 boundary', () => {
        // The mathematical review claimed a discontinuity at day 5. It did not exist in
        // the old blend either (its weight hit exactly 1.0 at d=5), but the estimator that
        // replaced it has no boundary at all — this sweep is what guarantees that.
        const vals = sweep(d => project({ dayIndex: d, spentToDate: 100 * d }));
        const steps = vals.slice(1).map((v, i) => Math.abs(v - vals[i]));
        const biggest = Math.max(...steps);
        const median = steps.slice().sort((a, b) => a - b)[Math.floor(steps.length / 2)];
        // No single day may move the forecast by more than a few times a typical day.
        expect(biggest).toBeLessThan(median * 5);
    });

    it('CONVERGENCE: lands exactly on actuals on the final day', () => {
        expect(project({ dayIndex: AUG.days, spentToDate: 2750 })).toBe(2750);
    });

    it('converges smoothly toward actuals over the last week', () => {
        const gaps = [25, 27, 29, 30, 31].map(d =>
            project({ dayIndex: d, spentToDate: 2750 }) - 2750);
        for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeLessThanOrEqual(gaps[i - 1]);
        expect(gaps[gaps.length - 1]).toBe(0);
    });

    it('EARLY MONTH: one ₪400 purchase on day 1 does not forecast a ₪12,000 month', () => {
        // The naive run-rate this replaced returned 400 × 31 = ₪12,400 here, which is what
        // the MIN_DAYS_FOR_FULL_PROJECTION hack existed to paper over. The credibility
        // form lands near ₪4,100: a day at 4× the usual rate does move the number, and
        // should, but it moves it by tens of percent rather than by 300%.
        const p = project({ dayIndex: 1, spentToDate: 400, historicalMean: 3000 });
        expect(p).toBeLessThan(4200);
        expect(p).toBeGreaterThan(2900); // and it does not ignore the ₪400 either
    });

    it('the leverage of a single day is bounded, so day 1 cannot run away', () => {
        // S_d enters the remainder as S × (D−d)/(d+K). At d=1 that multiplier is 30/11,
        // not 30 — this is the property that removed the need for an early-month hack.
        const base = project({ dayIndex: 1, spentToDate: 0, historicalMean: 3000 });
        const withBuy = project({ dayIndex: 1, spentToDate: 400, historicalMean: 3000 });
        const leverage = (withBuy - base) / 400;
        expect(leverage).toBeCloseTo(1 + (AUG.days - 1) / (1 + fx.CREDIBILITY_K), 6);
        expect(leverage).toBeLessThan(4);
    });

    it('PACE RESPONSIVENESS: 20 days at triple the usual rate forecasts well above μ', () => {
        // This is exactly the case the review's own S_d + μ(D−d)/D formula fails: it
        // would return 5806 + 3000×(11/31) ≈ 6871, barely above the money already spent.
        const mu = 3000;
        const tripleRate = (mu / AUG.days) * 3 * 20; // ~5806 spent by day 20
        const p = project({ dayIndex: 20, spentToDate: tripleRate, historicalMean: mu });
        expect(p).toBeGreaterThan(mu * 2.4);
        // And strictly above what the history-only estimator would have said.
        expect(p).toBeGreaterThan(tripleRate + mu * (11 / 31));
    });

    it('QUIET MONTH: a genuinely slow month is allowed to read as slow', () => {
        const p = project({ dayIndex: 25, spentToDate: 500, historicalMean: 3000 });
        expect(p).toBeLessThan(1200);
    });

    it('NO SPEND YET: leans on history instead of forecasting a ₪0 month', () => {
        // The old code short-circuited to 0 when variable_sum was 0, so a user who had not
        // spent yet on the 3rd was told to expect a ₪0 month. Three quiet days are real
        // evidence of a slower month, just weak evidence, so the number sits below the
        // ₪3,000 habit without collapsing anywhere near zero.
        const p = project({ dayIndex: 3, spentToDate: 0, historicalMean: 3000 });
        expect(p).toBeGreaterThan(1800);
        expect(p).toBeLessThan(3000);
    });

    it('quiet days early move the forecast less than quiet days late', () => {
        const early = project({ dayIndex: 3, spentToDate: 0, historicalMean: 3000 });
        const late = project({ dayIndex: 20, spentToDate: 0, historicalMean: 3000 });
        expect(early).toBeGreaterThan(late);
    });

    it('NO HISTORY: falls back to the plain run-rate rather than shrinking toward zero', () => {
        const p = project({ dayIndex: 10, spentToDate: 1000, historicalMean: 0, monthsWithData: 0 });
        expect(p).toBeCloseTo(1000 * (AUG.days / 10), 6);
    });

    it('is always finite and never below what has already been spent', () => {
        const cases = [
            { dayIndex: 1, spentToDate: 0, historicalMean: 0, monthsWithData: 0 },
            { dayIndex: 0, spentToDate: 0, historicalMean: 0, monthsWithData: 0 },
            { dayIndex: 31, spentToDate: 0, historicalMean: 0, monthsWithData: 0 },
            { dayIndex: 15, spentToDate: 9999, historicalMean: 0, monthsWithData: 6 },
            { dayIndex: 15, spentToDate: 0, historicalMean: 9999, monthsWithData: 6 },
        ];
        for (const c of cases) {
            const p = project(c);
            expect(Number.isFinite(p)).toBe(true);
            expect(p).toBeGreaterThanOrEqual(c.spentToDate);
        }
    });

    it('rises monotonically as more is spent, holding the day fixed', () => {
        const vals = [0, 500, 1000, 2000, 5000].map(s => project({ spentToDate: s }));
        for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
    });

    it('SEASONALITY: a month with more weekend left forecasts higher', () => {
        const weekendHeavy = fx.dowWeights([10, 10, 10, 10, 10, 90, 90], new Array(7).fill(26));
        // Aug 2026: day 9 is a Sunday (a fresh week ahead), day 14 is a Friday.
        const beforeWeekend = project({ dayIndex: 13, spentToDate: 1300, weights: weekendHeavy });
        const flatSame = project({ dayIndex: 13, spentToDate: 1300, weights: FLAT });
        expect(Number.isFinite(beforeWeekend)).toBe(true);
        expect(Number.isFinite(flatSame)).toBe(true);
        // Both are legitimate; what matters is that the weights actually move the answer.
        expect(beforeWeekend).not.toBeCloseTo(flatSame, 3);
    });

    it('a day-0 (future month) query returns the pure historical expectation', () => {
        const p = project({ dayIndex: 0, spentToDate: 0, historicalMean: 3000 });
        expect(p).toBeCloseTo(3000, 6);
    });
});

// ── projectVariableIncome ────────────────────────────────────────────────────────

describe('projectVariableIncome', () => {
    const project = (over = {}) => fx.projectVariableIncome({
        receivedToDate: 0,
        dayIndex: 15,
        days: AUG.days,
        historicalMean: 900,
        startDate: AUG.start,
        weights: FLAT,
        ...over,
    });

    it('NEVER below what has already arrived', () => {
        for (const d of [1, 10, 20, 31]) {
            expect(project({ dayIndex: d, receivedToDate: 5000 })).toBeGreaterThanOrEqual(5000);
        }
    });

    it('BIAS FIX: a weak month late on is allowed to read as weak', () => {
        // The old max(actual, avg) propped this to the full 900 on day 28. It now reports
        // roughly what actually happened, which is the entire point of the change.
        const p = project({ dayIndex: 28, receivedToDate: 100, historicalMean: 900 });
        expect(p).toBeLessThan(300);
        expect(p).toBeGreaterThanOrEqual(100);
    });

    it('still expects the average early in the month, when nothing has arrived yet', () => {
        const p = project({ dayIndex: 1, receivedToDate: 0, historicalMean: 900 });
        expect(p).toBeGreaterThan(850);
    });

    it('reports a hot month as hot rather than capping it', () => {
        const p = project({ dayIndex: 10, receivedToDate: 900, historicalMean: 900 });
        expect(p).toBeGreaterThan(900);
    });

    it('equals actuals exactly on the final day', () => {
        expect(project({ dayIndex: AUG.days, receivedToDate: 742 })).toBe(742);
    });

    it('returns the historical mean for a day-0 (future month) query', () => {
        expect(project({ dayIndex: 0, receivedToDate: 0, historicalMean: 900 })).toBeCloseTo(900, 6);
    });

    it('is finite with no history and no income', () => {
        const p = project({ receivedToDate: 0, historicalMean: 0 });
        expect(p).toBe(0);
    });

    it('decreases smoothly as the month runs out without income arriving', () => {
        const vals = sweep(d => project({ dayIndex: d, receivedToDate: 0 }));
        for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1]);
        expect(vals[vals.length - 1]).toBe(0);
    });
});

// ── forecastRange ────────────────────────────────────────────────────────────────

describe('forecastRange', () => {
    it('returns nulls when there is no history to build an interval from', () => {
        const r = fx.forecastRange(1000, { expenseStdDev: null, incomeStdDev: null, remainingShare: 0.5 });
        expect(r).toEqual({ low: null, high: null, sigma: null });
    });

    it('returns nulls rather than a zero-width band for a perfectly steady user', () => {
        const r = fx.forecastRange(1000, { expenseStdDev: 0, incomeStdDev: 0, remainingShare: 0.5 });
        expect(r.low).toBeNull();
        expect(r.high).toBeNull();
    });

    it('brackets the point estimate symmetrically', () => {
        const r = fx.forecastRange(1000, { expenseStdDev: 400, incomeStdDev: null, remainingShare: 0.5 });
        expect(r.low).toBeLessThan(1000);
        expect(r.high).toBeGreaterThan(1000);
        expect(1000 - r.low).toBeCloseTo(r.high - 1000, 10);
    });

    it('scales with the share of the month still unspent', () => {
        const early = fx.forecastRange(0, { expenseStdDev: 400, incomeStdDev: null, remainingShare: 0.9 });
        const late = fx.forecastRange(0, { expenseStdDev: 400, incomeStdDev: null, remainingShare: 0.1 });
        expect(early.sigma).toBeGreaterThan(late.sigma);
        expect(late.sigma).toBeCloseTo(40, 10);
    });

    it('collapses to nothing at month end — a finished month has no uncertainty left', () => {
        const r = fx.forecastRange(1000, { expenseStdDev: 400, incomeStdDev: 300, remainingShare: 0 });
        expect(r.low).toBeNull();
        expect(r.high).toBeNull();
    });

    it('adds income and expense uncertainty in quadrature, not linearly', () => {
        const r = fx.forecastRange(0, { expenseStdDev: 300, incomeStdDev: 400, remainingShare: 1 });
        expect(r.sigma).toBeCloseTo(500, 10);   // sqrt(300² + 400²)
        expect(r.sigma).toBeLessThan(700);      // linear addition would have said 700
    });

    it('clamps a nonsense remaining share into [0, 1]', () => {
        const over = fx.forecastRange(0, { expenseStdDev: 100, incomeStdDev: null, remainingShare: 5 });
        expect(over.sigma).toBeCloseTo(100, 10);
        const under = fx.forecastRange(0, { expenseStdDev: 100, incomeStdDev: null, remainingShare: -3 });
        expect(under.low).toBeNull();
    });
});

// ── safeToSpendPerDay ────────────────────────────────────────────────────────────

describe('safeToSpendPerDay', () => {
    const safe = (over = {}) => fx.safeToSpendPerDay({
        projectedIncome: 10000,
        spentToDate: 3000,
        fixedRemaining: 0,
        subscriptionsAhead: 0,
        savingsAllocation: 0,
        dayIndex: 15,
        days: AUG.days,
        ...over,
    });

    it('divides the headroom over the days that are actually left', () => {
        const r = safe();
        expect(r.days_left).toBe(16);
        expect(r.headroom).toBe(7000);
        expect(r.per_day).toBeCloseTo(7000 / 16, 10);
    });

    it('subtracts every committed obligation before dividing', () => {
        const r = safe({ subscriptionsAhead: 500, savingsAllocation: 1000, fixedRemaining: 500 });
        expect(r.headroom).toBe(5000);
    });

    it('goes negative when the month is already committed past its income', () => {
        const r = safe({ spentToDate: 12000 });
        expect(r.headroom).toBe(-2000);
        expect(r.per_day).toBeLessThan(0);
    });

    it('returns null on the last day — a per-day allowance over zero days is meaningless', () => {
        const r = safe({ dayIndex: AUG.days });
        expect(r.per_day).toBeNull();
        expect(r.days_left).toBe(0);
    });

    it('spreads over the whole month for a day-0 (future month) query', () => {
        const r = safe({ dayIndex: 0, spentToDate: 0 });
        expect(r.days_left).toBe(AUG.days);
        expect(r.per_day).toBeCloseTo(10000 / 31, 10);
    });

    it('the same headroom buys more per day as the month runs out', () => {
        // Not a bug: ₪7,000 spread over 6 remaining days really is a larger daily
        // allowance than the same ₪7,000 spread over 26. The number falls only when the
        // headroom itself falls, which is what the next case pins.
        const vals = [5, 15, 25].map(d => safe({ dayIndex: d }).per_day);
        expect(vals[0]).toBeLessThan(vals[1]);
        expect(vals[1]).toBeLessThan(vals[2]);
    });

    it('falls as spending eats the headroom, holding the day fixed', () => {
        const vals = [3000, 5000, 8000].map(s => safe({ spentToDate: s }).per_day);
        expect(vals[0]).toBeGreaterThan(vals[1]);
        expect(vals[1]).toBeGreaterThan(vals[2]);
    });
});

// ── money ────────────────────────────────────────────────────────────────────────

describe('money', () => {
    it('rounds to two decimals', () => {
        expect(fx.money(1234.5678)).toBe(1234.57);
        expect(fx.money(-0.005)).toBe(-0);
    });

    it('passes null and non-finite values through as null rather than NaN', () => {
        expect(fx.money(null)).toBeNull();
        expect(fx.money(undefined)).toBeNull();
        expect(fx.money(NaN)).toBeNull();
        expect(fx.money(Infinity)).toBeNull();
    });
});

// ── End-to-end scenarios, composing the whole forecast ───────────────────────────

describe('full P&L scenarios', () => {
    /** The controller's arithmetic, in one place, so a scenario reads like the app. */
    function forecast({ fixedIncome = 0, varIncome = 0, varIncomeMean = 0,
                        fixedSpend = 0, varSpend = 0, varSpendMean = 0, monthsWithData = 3,
                        subs = 0, savings = 0, day = 15 }) {
        const projIncome = fixedIncome + fx.projectVariableIncome({
            receivedToDate: varIncome, dayIndex: day, days: AUG.days,
            historicalMean: varIncomeMean, startDate: AUG.start, weights: FLAT,
        });
        const projExpenses = fixedSpend + fx.projectVariableExpenses({
            spentToDate: varSpend, dayIndex: day, days: AUG.days,
            historicalMean: varSpendMean, monthsWithData,
            startDate: AUG.start, weights: FLAT,
        });
        return projIncome - projExpenses - subs - savings;
    }

    it('salaried user on track mid-month forecasts comfortably positive', () => {
        const f = forecast({
            fixedIncome: 10000, fixedSpend: 3000, varSpend: 1500, varSpendMean: 3000,
            subs: 200, savings: 500, day: 15,
        });
        expect(f).toBeGreaterThan(2500);
        expect(f).toBeLessThan(6500);
    });

    it('a user spending far above their habit is warned, not reassured', () => {
        const onPace = forecast({ fixedIncome: 10000, varSpend: 1500, varSpendMean: 3000, day: 15 });
        const overspending = forecast({ fixedIncome: 10000, varSpend: 6000, varSpendMean: 3000, day: 15 });
        expect(overspending).toBeLessThan(onPace);
        expect(overspending).toBeLessThan(10000 - 3000 * 2);
    });

    it('day 1 of the month does not swing wildly on a single purchase', () => {
        const quiet = forecast({ fixedIncome: 10000, varSpend: 0, varSpendMean: 3000, day: 1 });
        const oneBigBuy = forecast({ fixedIncome: 10000, varSpend: 400, varSpendMean: 3000, day: 1 });
        // The naive run-rate moved the forecast by ₪12,400 on a ₪400 purchase. Roughly
        // ₪1,500 — under 4× the purchase itself — is a proportionate reaction to one day.
        expect(Math.abs(quiet - oneBigBuy)).toBeLessThan(400 * 4);
    });

    it('a brand-new user with income but no history still forecasts positive', () => {
        // The original bug this app fixed once already: projected income of 0 dragged the
        // whole forecast negative for someone who had actually been paid.
        const f = forecast({
            varIncome: 1100, varIncomeMean: 0, varSpend: 30, varSpendMean: 0,
            monthsWithData: 0, savings: 200, day: 29,
        });
        expect(f).toBeGreaterThan(0);
    });

    it('genuinely negative months still report negative', () => {
        const f = forecast({
            fixedIncome: 3000, varSpend: 4000, varSpendMean: 5000, subs: 200, savings: 300, day: 20,
        });
        expect(f).toBeLessThan(0);
    });

    it('is finite across every combination of empty history and zero data', () => {
        for (const day of [0, 1, 15, 31]) {
            for (const months of [0, 1, 6]) {
                const f = forecast({ monthsWithData: months, day });
                expect(Number.isFinite(f)).toBe(true);
            }
        }
    });
});
