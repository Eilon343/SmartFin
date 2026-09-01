/**
 * The single definition of a financial period in SmartFin.
 *
 * Every figure in the app used to be scoped to a calendar month, with the boundary
 * `created_at >= CONCAT(month,'-01') AND < DATE_ADD(..., INTERVAL 1 MONTH)` inlined at a
 * dozen call sites. That is not how money moves: a credit card settles on the 10th and a
 * salary lands on the 15th, so a calendar month splices the tail of one financial period
 * onto the head of the next and reports the sum as "this month".
 *
 * A cycle runs from the user's `cycle_anchor_day` to the day before the next anchor day.
 * With anchor = 10, the cycle keyed '2026-09' is 2026-09-10 → 2026-10-09 inclusive.
 *
 * The key stays a 'YYYY-MM' string — the month a cycle STARTS in — so no query parameter,
 * no lookback list and none of the month-keyed math in forecastMath.js had to change.
 *
 * ── The anchor is restricted to 1..28 ──
 * Recovering a cycle key from a date is a single shift: `date - (anchor - 1) days`, then
 * take its YYYY-MM. That identity holds only for a day that exists in every month. Anchors
 * of 29-31 would need per-month clamping and would produce cycles of unpredictable length,
 * so they are rejected at the API rather than silently corrected.
 *
 * ── Time zone ──
 * All arithmetic is UTC-based, and "now" is read from the server's local clock, matching
 * what `new Date().getDate()` did before this module existed. Production containers run
 * UTC, so the two agree. `currentCycleKey` is now the ONLY place the app asks what period
 * it is, which is what makes a future time-zone fix a one-function change.
 */

const DEFAULT_ANCHOR = 1;
const DEFAULT_SALARY_DAY = 1;
const MIN_DAY = 1;
const MAX_DAY = 28;
const MS_PER_DAY = 86400000;

const pad2 = n => String(n).padStart(2, '0');

/** 'YYYY-MM' → { y, m } with m in 1..12. */
function parseKey(key) {
    const [y, m] = String(key).split('-').map(Number);
    return { y, m };
}

/** Shift a 'YYYY-MM' key by `n` months, in either direction. */
function addMonths(key, n) {
    const { y, m } = parseKey(key);
    const total = y * 12 + (m - 1) + n;
    return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
}

/** A UTC midnight Date, so day arithmetic is never bent by a DST transition. */
function utcDate(y, m, d) {
    return new Date(Date.UTC(y, m - 1, d));
}

/** Date → 'YYYY-MM-DD', the form MySQL compares against a DATETIME without a cast. */
function toISODate(date) {
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * A settings row from `users`, coerced to something the math can rely on.
 * Missing or out-of-range values fall back to 1 — the calendar-month behaviour — because a
 * period that silently becomes undefined is far worse than one that is merely not customised.
 */
function normalizeSettings(settings) {
    const clamp = (v, fallback) => {
        const n = Math.floor(Number(v));
        return Number.isFinite(n) && n >= MIN_DAY && n <= MAX_DAY ? n : fallback;
    };
    return {
        anchor: clamp(settings && settings.cycle_anchor_day, DEFAULT_ANCHOR),
        salaryDay: clamp(settings && settings.salary_day, DEFAULT_SALARY_DAY),
    };
}

/** True for an integer day the anchor/salary settings will accept as-is. */
function isValidDay(v) {
    const n = Number(v);
    return Number.isInteger(n) && n >= MIN_DAY && n <= MAX_DAY;
}

/**
 * Resolve a cycle key into everything a query or a chart needs.
 *
 * `start` is inclusive and `end` exclusive, so the two drop straight into
 * `created_at >= ? AND created_at < ?` with no off-by-one at midnight.
 *
 * `days` is the real length of THIS cycle and varies with the calendar underneath it
 * (Feb 10 → Mar 9 is 28 days; Mar 10 → Apr 9 is 31). Nothing may assume 30.
 */
function resolveCycle(key, settings) {
    const { anchor, salaryDay } = normalizeSettings(settings);
    const { y, m } = parseKey(key);
    const nextKey = addMonths(key, 1);
    const next = parseKey(nextKey);

    const start = utcDate(y, m, anchor);
    const end = utcDate(next.y, next.m, anchor);

    return {
        key,
        anchor,
        salary_day: salaryDay,
        start: toISODate(start),
        end: toISODate(end),
        // Last day the cycle actually covers — what the UI labels, never sent to SQL.
        last_day: toISODate(new Date(end.getTime() - MS_PER_DAY)),
        days: Math.round((end.getTime() - start.getTime()) / MS_PER_DAY),
        income_month: incomeMonthOf(key, settings),
    };
}

/**
 * Which `income.month` row belongs to a cycle.
 *
 * `income` has no day column — only 'YYYY-MM' — so the salary date is reconstructed from
 * the user's setting: the salary tagged month M is treated as arriving on M-`salaryDay`.
 * Exactly one such date falls inside any cycle, so this is a key-to-key map, not a scan.
 *
 * With salaryDay >= anchor the salary lands in the cycle's own start month. Below the
 * anchor it has not arrived yet when the cycle opens, so it is the NEXT month's income row
 * that falls inside this cycle — anchor 10 / salary 5 means cycle '2026-09' (Sep 10 - Oct 9)
 * is funded by income month '2026-10', paid Oct 5.
 */
function incomeMonthOf(key, settings) {
    const { anchor, salaryDay } = normalizeSettings(settings);
    return salaryDay >= anchor ? key : addMonths(key, 1);
}

/**
 * The inverse of `incomeMonthOf`: which cycle an `income.month` row funds.
 * Needed because the decay weighting in forecastMath ages history by distance from the
 * anchor CYCLE — feeding it raw income months would shift every weight by one period.
 */
function cycleKeyOfIncomeMonth(incomeMonth, settings) {
    const { anchor, salaryDay } = normalizeSettings(settings);
    return salaryDay >= anchor ? incomeMonth : addMonths(incomeMonth, -1);
}

/** The inverse of `resolveCycle`: which cycle contains this date. */
function cycleKeyOfDate(date, settings) {
    const { anchor } = normalizeSettings(settings);
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const key = `${y}-${pad2(m)}`;
    return d >= anchor ? key : addMonths(key, -1);
}

/** Which cycle we are living in right now. The app's only source of "the current period". */
function currentCycleKey(settings, now = new Date()) {
    return cycleKeyOfDate(now, settings);
}

/** Today as 'YYYY-MM-DD', read off the server's local clock — see the time-zone note above. */
function todayISO(now = new Date()) {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * Position of a date within a cycle, 1..`days`.
 * Returns 0 before the cycle opens (a future cycle has no elapsed days) and clamps to
 * `days` after it closes, which is what a fully-elapsed past cycle should report.
 */
function dayIndexIn(cycle, date) {
    const start = new Date(`${cycle.start}T00:00:00Z`).getTime();
    const at = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const idx = Math.floor((at - start) / MS_PER_DAY) + 1;
    if (idx < 1) return 0;
    return Math.min(idx, cycle.days);
}

/**
 * The constant for `DATE_FORMAT(DATE_SUB(created_at, INTERVAL ? DAY), '%Y-%m')`, which is
 * how a row is bucketed into its cycle key in SQL. Shifting a date back by anchor-1 days
 * moves the anchor day onto the 1st, so the ordinary month truncation then yields the
 * cycle key. Exact for every anchor in 1..28 — see the note at the top of this file.
 */
function anchorShiftDays(settings) {
    return normalizeSettings(settings).anchor - 1;
}

/** Start date of a cycle key, for callers that need only the boundary. */
function cycleStart(key, settings) {
    return resolveCycle(key, settings).start;
}

/** 'YYYY-MM-DD' plus `n` days, as another 'YYYY-MM-DD'. Used to build the MTD window end. */
function addDays(isoDate, n) {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return toISODate(d);
}

/**
 * The date a recurring charge billed on day-of-month `dom` falls due inside `cycle`.
 *
 * A cycle straddles two calendar months, so a day-of-month maps to whichever side of the
 * anchor it sits on: with anchor 10, the 12th belongs to the cycle's start month and the
 * 3rd to its end month. `dom` above the target month's length is clamped to its last day,
 * the same way a subscription billed on the 31st still charges in February.
 */
function chargeDateInCycle(cycle, dom) {
    const day = Math.max(1, Math.min(31, Math.floor(Number(dom)) || 1));
    const monthKey = day >= cycle.anchor ? cycle.key : addMonths(cycle.key, 1);
    const { y, m } = parseKey(monthKey);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return toISODate(utcDate(y, m, Math.min(day, lastDay)));
}

module.exports = {
    DEFAULT_ANCHOR,
    DEFAULT_SALARY_DAY,
    MIN_DAY,
    MAX_DAY,
    addDays,
    addMonths,
    anchorShiftDays,
    chargeDateInCycle,
    currentCycleKey,
    cycleKeyOfDate,
    cycleKeyOfIncomeMonth,
    cycleStart,
    dayIndexIn,
    incomeMonthOf,
    isValidDay,
    normalizeSettings,
    resolveCycle,
    toISODate,
    todayISO,
};
