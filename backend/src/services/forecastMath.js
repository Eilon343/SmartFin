/**
 * Every forecasting formula SmartFin shows the user.
 *
 * This module is pure — no DB, no `new Date()`, no config reads. Today's date, the user's
 * history and their month-to-date totals are all passed in. That is what makes the money
 * logic testable in isolation, the same arrangement as `duplicateMatcher.js` and
 * `classifyRow()`: the rules live in one place and the controller only fetches rows and
 * shapes a response.
 *
 * THE CORE RULE: a forecast must use BOTH the user's history and their current pace, and
 * must weight them by how much evidence this month has actually produced. Two estimators
 * were rejected for getting this wrong in opposite directions:
 *
 *   1. Naive run-rate — `(S_d / d) × D`, what the app used to do. On day 2 it turns one
 *      ₪400 grocery run into a ₪6,000 month. It ignores the user's history entirely and
 *      its variance goes as D/d, so it is at its loudest exactly when it knows least. The
 *      `MIN_DAYS_FOR_FULL_PROJECTION = 5` blend was a patch over this: it damped days 1–4
 *      and then stopped, which left the estimator just as noisy on day 6.
 *
 *   2. Pure historical accrual — `S_d + μ × (D − d)/D`, proposed in the mathematical
 *      review as "Bayesian shrinkage". It shrinks nothing. Every remaining day is
 *      forecast at the historical average regardless of what this month is doing, so a
 *      user spending triple their usual rate for twenty days gets a forecast that never
 *      says so. Correct for the *expected* month, useless for *this* month.
 *
 * What we do instead is credibility weighting: forecast the remaining days as a blend of
 * both, with the weight on this month's pace rising as the month supplies evidence. See
 * `projectVariableExpenses`.
 *
 * A NOTE ON "MONTH": the period this module forecasts is the user's financial CYCLE, which
 * runs from their card-settlement day to the day before the next one and is only a calendar
 * month for users who left the anchor at 1 (see services/cycle.js). The prose below says
 * "month" throughout because that is what the period means to the person reading the
 * dashboard; the parameters are `startDate` and `days`, and nothing here assumes the period
 * starts on the 1st or is a fixed length.
 *
 * SECOND RULE: fixed costs are never run-rated. `categories.is_fixed` (Housing, Utilities,
 * Savings) are flat monthly charges that already landed; scaling them to month-end would
 * bill the user for their rent twice.
 */

// ── Tunables ────────────────────────────────────────────────────────────────────

/**
 * Credibility constant, in days. The weight on this month's own pace is `d / (d + K)`, so
 * K is the number of elapsed days at which the current month and the historical prior
 * carry equal weight: at K = 10, ten days of observed spending is worth as much as
 * everything previous months say about you.
 *
 * K also bounds how much a single early purchase can move the forecast. With ρ the share of
 * the month still ahead, the month's spend enters the remainder as `S_d × ρD/((1 − ρ)D + K)`,
 * which is `S_d × (D − d)/(d + K)` under flat weights — the `+ K` is what stops the leverage
 * exploding as d → 1, which is the whole failure mode of a raw run-rate. Tuned on the two
 * cases that matter and pull in opposite directions: one ₪400 purchase on day 1 against a
 * ₪3,000 habit (K=7 forecast ₪4,440, K=10 ₪4,130, K=14 ₪3,910) versus twenty days at
 * triple the usual rate, which must still be reported loudly (K=7 ₪8,447, K=10 ₪8,290,
 * K=14 ₪8,123). Past ~10 the early-month gain costs real late-month responsiveness.
 */
const CREDIBILITY_K = 10;

/**
 * Strength of the uniform prior on the day-of-week weights, in day-observations. Each
 * weekday gets ~26 observations from a 6-month window, so at m = 10 the data carries
 * 26/36 ≈ 72% and a thin history degrades smoothly toward a flat week rather than toward
 * noise. This is why we weight by day-of-week (7 parameters) and not by day-of-month as
 * the review proposed (31 parameters, ~6 observations each — almost entirely noise).
 */
const DOW_PRIOR_STRENGTH = 10;

/** Months of history feeding every average. */
const LOOKBACK_MONTHS = 6;

/**
 * Half-life of the exponential decay applied across the lookback, in months. At 2 months,
 * the month before last counts ~71% of last month, and the 6th month back ~18%. This is
 * what lets the window be long (more data, less noise) without being slow to notice that
 * someone's spending genuinely changed.
 */
const LOOKBACK_HALF_LIFE = 2;

const DECAY = Math.pow(0.5, 1 / LOOKBACK_HALF_LIFE);

/** A cycle needs variable spending across this many days to count as a cycle at all. */
const MIN_CYCLE_HISTORY_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** Number of whole months from `from` (YYYY-MM) forward to `to`. Both are strings. */
function monthsBetween(from, to) {
    const [fy, fm] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    return (ty - fy) * 12 + (tm - fm);
}

/** The `count` months immediately before `month`, most recent first. */
function pastMonths(month, count = LOOKBACK_MONTHS) {
    if (!Number.isInteger(count) || count < 1 || count > 24) {
        throw new Error(`Invalid lookback count: ${count}`);
    }
    const [y, m] = month.split('-').map(Number);
    const out = [];
    for (let i = 1; i <= count; i++) {
        let yy = y, mm = m - i;
        while (mm <= 0) { mm += 12; yy--; }
        out.push(`${yy}-${String(mm).padStart(2, '0')}`);
    }
    return out;
}

/**
 * 'YYYY-MM-DD' → a UTC-midnight Date. Every calendar walk below is UTC so that a DST
 * transition can never add or drop a day from a window.
 */
function utcDay(isoDate) {
    const [y, m, d] = String(isoDate).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

/** Weekday (0 = Sunday) of the `dayIndex`-th day of a period starting at `startDate`. */
function weekdayAt(startDate, dayIndex) {
    return (utcDay(startDate).getUTCDay() + dayIndex - 1) % 7;
}

/**
 * How many of each weekday fall in `[fromDate, toDate)`. Index 0 = Sunday.
 *
 * `dowWeights` needs this: a ~181-day window does not contain an equal number of each
 * weekday, so without it a weekday that happened to occur 27 times would look like a
 * bigger spending day than one that occurred 25 times.
 *
 * Takes cycle boundary dates rather than 'YYYY-MM' keys — the lookback window starts on
 * the user's anchor day, not on the 1st.
 */
function weekdayCounts(fromDate, toDate) {
    const counts = new Array(7).fill(0);
    const end = utcDay(toDate);
    for (const cur = utcDay(fromDate); cur < end; cur.setUTCDate(cur.getUTCDate() + 1)) {
        counts[cur.getUTCDay()]++;
    }
    return counts;
}

/**
 * Exponentially decayed mean of a set of monthly totals.
 *
 * `rows` is [{ month: 'YYYY-MM', total: Number }] — only months that actually have data,
 * which keeps the denominator `months_with_data`. A user with two months of history is
 * never divided by six, the same guarantee the old 3-month average made.
 */
function decayedMean(rows, anchorMonth) {
    if (!rows || rows.length === 0) return 0;
    let num = 0, den = 0;
    for (const r of rows) {
        const age = monthsBetween(r.month, anchorMonth); // 1 = last month
        if (age < 1) continue;
        const w = Math.pow(DECAY, age - 1);
        num += w * Number(r.total);
        den += w;
    }
    return den > 0 ? num / den : 0;
}

/**
 * The user's typical monthly spend in each category, from per-cycle category totals.
 *
 * `rows` is [{ category_id, mo: 'YYYY-MM', total, first_at?, last_at? }], where the two
 * timestamps bound a bucket's expenses. `cycleOf(mo)` gives { end, days } with `end` an
 * exclusive 'YYYY-MM-DD', and `isFixed(category_id)` says which categories are fixed costs.
 *
 * The denominator is the cycles the USER was active, not the cycles a category was. A
 * category that was silent in an active cycle spent ₪0 there, and counting that zero is what
 * makes the categories add up: dividing ₪900 of clothes by its one month called it a ₪900
 * habit, and the sum of those habits ran far above what the user actually spends. Because
 * the same months and weights apply to every category, the habits sum exactly to
 * `decayedMean` of the monthly totals.
 *
 * A cycle only counts if its variable spending spans MIN_CYCLE_HISTORY_DAYS. Four days of
 * logging after a long gap, or a lone generated subscription row, is not a month, and
 * counting it as one sets a far too low bar. Rent is ignored here because it arrives whether
 * or not the user is tracking anything. Rows with no timestamps make no claim. An empty
 * `months` means there is no usable history yet.
 *
 * The earliest cycle is usually partial, since the user joined part-way through it, so its
 * variable spending is scaled to a whole cycle: ₪3,200 over 16 days is a ₪6,000 month. Fixed
 * costs are not, because a partial cycle still held one whole rent.
 */
function categoryHabits(rows, { anchorMonth, cycleOf, isFixed = () => false }) {
    const all = rows || [];
    const dated = new Set();
    const spans = new Map(); // mo → { first, last } of its variable spending, in ms
    for (const r of all) {
        if (r.first_at == null) continue;
        dated.add(r.mo);
        if (isFixed(r.category_id)) continue;
        const first = new Date(r.first_at).getTime();
        const last = new Date(r.last_at == null ? r.first_at : r.last_at).getTime();
        const span = spans.get(r.mo) || { first, last };
        spans.set(r.mo, { first: Math.min(span.first, first), last: Math.max(span.last, last) });
    }

    const activeDays = (mo) => {
        const span = spans.get(mo);
        return span ? (span.last - span.first) / MS_PER_DAY + 1 : 0;
    };
    const months = [...new Set(all.map(r => r.mo))]
        .filter(mo => !dated.has(mo) || activeDays(mo) >= MIN_CYCLE_HISTORY_DAYS)
        .sort();

    let firstCycleScale = 1;
    if (spans.has(months[0])) {
        const { end, days } = cycleOf(months[0]);
        const heldDays = (new Date(`${end}T00:00:00Z`).getTime() - spans.get(months[0]).first) / MS_PER_DAY;
        if (heldDays > 0 && heldDays < days) firstCycleScale = days / heldDays;
    }

    const totals = new Map();
    for (const r of all) {
        if (!months.includes(r.mo)) continue;
        if (!totals.has(r.category_id)) totals.set(r.category_id, {});
        const byMonth = totals.get(r.category_id);
        const scale = r.mo === months[0] && !isFixed(r.category_id) ? firstCycleScale : 1;
        byMonth[r.mo] = (byMonth[r.mo] || 0) + Number(r.total) * scale;
    }

    const byCategory = new Map();
    for (const [categoryId, byMonth] of totals) {
        byCategory.set(categoryId, decayedMean(
            months.map(month => ({ month, total: byMonth[month] || 0 })),
            anchorMonth
        ));
    }
    return { byCategory, months };
}

/**
 * Sample standard deviation of the monthly totals, unweighted.
 *
 * Deliberately not decay-weighted: the decay exists to track a moving mean, but the spread
 * we want is "how much do this user's months differ from each other at all", and weighting
 * it would understate the older, equally real variation. Returns null below two months —
 * one observation has no spread, and inventing one would be the exact false precision this
 * range is meant to remove.
 */
function monthlyStdDev(rows) {
    if (!rows || rows.length < 2) return null;
    const xs = rows.map(r => Number(r.total));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1);
    return Math.sqrt(variance);
}

// ── Day-of-week seasonality ─────────────────────────────────────────────────────

/**
 * Seven weights, summing to 1, describing what share of a typical week's spending lands on
 * each weekday. Index 0 = Sunday … 6 = Saturday (JS `getDay()` order).
 *
 * `totals[i]` is the summed spend on that weekday across the lookback and `dayCounts[i]`
 * how many such days the window contained — the second is required because a 181-day
 * window does not hold an equal number of each weekday, and dividing by it turns a total
 * into a rate that can be compared across weekdays.
 *
 * Each rate is then shrunk toward the flat 1/7 by `DOW_PRIOR_STRENGTH`, so a user with two
 * weeks of history gets a nearly-flat week instead of a confident claim that they never
 * spend on Tuesdays.
 */
function dowWeights(totals = [], dayCounts = []) {
    const flat = 1 / 7;
    const rates = [];
    for (let i = 0; i < 7; i++) {
        const n = Number(dayCounts[i]) || 0;
        rates.push(n > 0 ? (Number(totals[i]) || 0) / n : 0);
    }
    const rateSum = rates.reduce((a, b) => a + b, 0);
    if (rateSum <= 0) return new Array(7).fill(flat);

    const shrunk = rates.map((r, i) => {
        const n = Number(dayCounts[i]) || 0;
        return (n * (r / rateSum) + DOW_PRIOR_STRENGTH * flat) / (n + DOW_PRIOR_STRENGTH);
    });
    // Re-normalise: the shrinkage above only sums to 1 exactly when every dayCount is
    // equal, which a real calendar window never guarantees.
    const s = shrunk.reduce((a, b) => a + b, 0);
    return shrunk.map(w => w / s);
}

/**
 * The share of a whole cycle's expected spending that falls on days 1..`throughDay`.
 *
 * This is the seasonality-aware replacement for `d / D`. A cycle whose remaining days hold
 * two weekends should forecast higher than one ending mid-week, and this is the term that
 * knows it. With flat weights it reduces exactly to `d / D`, so there is no separate
 * code path for a user without history.
 *
 * `startDate` and `days` describe the user's cycle, not a calendar month — the weekday walk
 * is the only reason this function ever needed to know where on the calendar it sat.
 */
function elapsedShare(throughDay, startDate, days, weights) {
    const w = weights && weights.length === 7 ? weights : new Array(7).fill(1 / 7);
    const dow0 = utcDay(startDate).getUTCDay();
    let elapsed = 0, whole = 0;
    for (let d = 1; d <= days; d++) {
        const wd = w[(dow0 + d - 1) % 7];
        whole += wd;
        if (d <= throughDay) elapsed += wd;
    }
    return whole > 0 ? elapsed / whole : 0;
}

/**
 * Ideal cumulative spend by day `d` for the momentum chart.
 *
 * Fixes an off-by-one in the old `target × (d−1)/(D−1)`, which made ideal(1) = 0 — every
 * user was "over pace" the moment they bought anything on the 1st. Day 1 should be
 * allowed its own day's worth of spending.
 */
function idealPace(day, target, startDate, days, weights) {
    if (!(target > 0)) return 0;
    return target * elapsedShare(day, startDate, days, weights);
}

// ── Momentum pacing (Insights) ──────────────────────────────────────────────────

/**
 * What this month *should* cost, over exactly the categories the momentum line sums.
 *
 * The bug this replaces: the chart drew cumulative spend across every category against a
 * target of `SUM(budgets.monthly_limit)`. Those are two different sets of categories.
 * A user who budgets Food and Transport but not Housing was charged for their rent
 * against a target that never contained rent, so the chip read "over pace by ₪5,837"
 * for a month that was ~₪700 over on the things they had actually budgeted.
 *
 * The rule is one line, and it is uniform across every category on the page:
 *
 *     a category contributes its BUDGET if the user set one, and its HABIT
 *     (`three_mo_avg`, from `categoryHabits`) if they did not.
 *
 * That keeps the target like-for-like with the line without narrowing the line, and it
 * subsumes the old `three_mo_avg_total` fallback rather than special-casing it: a user
 * with no budgets has no budgeted categories, so the total collapses to exactly the sum
 * of the habits — reached by the general formula instead of a branch.
 *
 * `categories` is [{ is_fixed, three_mo_avg, budget_limit }] where `budget_limit` is null
 * for an unbudgeted category. A limit of 0 is a real, deliberate budget of zero and is NOT
 * treated as absent.
 *
 * The fixed/variable split comes back out because the two halves are paced differently —
 * see `momentumIdeal`.
 */
function pacingTarget(categories = []) {
    let budgeted = 0, habit = 0, fixed = 0, variable = 0, budgetedCount = 0, budgetedVariable = 0;
    for (const c of categories || []) {
        const raw = c.budget_limit;
        const hasBudget = raw != null && Number.isFinite(Number(raw));
        const amount = hasBudget ? Number(raw) : (Number(c.three_mo_avg) || 0);
        if (hasBudget) { budgeted += amount; budgetedCount += 1; } else { habit += amount; }
        if (c.is_fixed) fixed += amount; else variable += amount;
        if (hasBudget && !c.is_fixed) budgetedVariable += 1;
    }
    return {
        total: budgeted + habit,
        budgeted,
        habit,
        fixed,
        variable,
        budgeted_categories: budgetedCount,
        budgeted_variable_categories: budgetedVariable,
    };
}

/**
 * Cumulative share of a cycle's FIXED spending that has landed by each day, indexed
 * `[0] = day 1`.
 *
 * `dowWeights` deliberately excludes `is_fixed` categories, because rent is charged on the
 * 1st: that is a day-of-**month** event, and letting it into the day-of-week shape buried
 * the real Fri/Sat signal. But that left the momentum chart half-corrected — the ideal
 * curve's *shape* was variable-only while the target and the cumulative line were not. So
 * the whole target, rent included, was smeared evenly across the month while the actual
 * rent hit on day 1, and every user with a fixed cost read "over pace" from the 1st to
 * roughly the 20th no matter how they behaved.
 *
 * Fixed spending gets its own axis instead. `totalsByDay[d]` is historical fixed spend on
 * the `d`-th day OF THE CYCLE over the lookback; the cumulative normalisation of that is
 * the curve. Cycle-relative, not day-of-month: with an anchor of 10 a rent charged on the
 * 1st is day 22 of the cycle, and placing its step on day 1 would be exactly the smearing
 * bug this function was written to remove, just moved three weeks.
 *
 * Deliberately NOT shrunk toward uniform, unlike `dowWeights`. The review's objection to
 * per-day-of-month weights — 31 parameters from a thin history is noise — applies to
 * discretionary spending, which is what it was aimed at. Fixed charges are the opposite
 * case: a handful of near-deterministic direct debits on the same date every month.
 * Shrinking them toward flat would re-smear the rent this function exists to place.
 * Cumulative-and-normalised is already the robust form — a rent that moved from the 1st to
 * the 3rd across the window softens the step rather than splitting it.
 *
 * Days beyond `days` fold into the last day (a charge on day 31 of a past 31-day cycle
 * still has to land inside a 30-day one). With no fixed history at all it returns
 * `d / days`, which is what the chart drew before and is the right agnostic answer.
 */
function fixedPaceShape(totalsByDay, days) {
    const buckets = new Array(days + 1).fill(0);
    let sum = 0;
    for (let d = 1; d <= 31; d++) {
        const v = Number(totalsByDay && totalsByDay[d]) || 0;
        if (v <= 0) continue;
        buckets[Math.min(d, days)] += v;
        sum += v;
    }
    const out = [];
    if (!(sum > 0)) {
        for (let d = 1; d <= days; d++) out.push(d / days);
        return out;
    }
    let acc = 0;
    for (let d = 1; d <= days; d++) { acc += buckets[d]; out.push(acc / sum); }
    return out;
}

/**
 * The momentum chart's ideal curve: expected cumulative spend by each day of the cycle,
 * indexed `[0] = day 1`.
 *
 * Two components, because the two kinds of spending arrive on different clocks:
 *
 *     ideal(d) = fixedTarget × fixedShare(d)  +  variableTarget × elapsedShare(d)
 *
 * The fixed half steps up on the days those charges actually land; the variable half
 * follows the day-of-week seasonality, which is the only spending it was ever measured
 * from. Both reach 1 at month end, so `ideal(D)` lands exactly on the target and the
 * curve stays monotone.
 *
 * `idealPace` (single-component, whole target on the day-of-week shape) is what this
 * replaces for the chart. It is kept because it is the correct form when there is no
 * fixed/variable split to make.
 */
function momentumIdeal({
    fixedTarget = 0,
    variableTarget = 0,
    fixedShape,
    startDate,
    days,
    weights,
}) {
    const F = Math.max(0, Number(fixedTarget) || 0);
    const V = Math.max(0, Number(variableTarget) || 0);
    const shape = Array.isArray(fixedShape) && fixedShape.length >= days ? fixedShape : null;
    const out = [];
    for (let d = 1; d <= days; d++) {
        const fShare = shape ? shape[d - 1] : d / days;
        const vShare = elapsedShare(d, startDate, days, weights);
        out.push(F * fShare + V * vShare);
    }
    return out;
}

// ── The estimators ──────────────────────────────────────────────────────────────

/**
 * Weight on this month's own pace, rising from ~0 on day 0 toward 1 at month end.
 * Continuous and monotone in `d`, which is what removes the day-5 boundary the old
 * dampening needed. With no history there is no prior to blend toward, so the current
 * month is all the evidence there is and the weight is 1 — shrinking a new user's forecast
 * toward a μ of zero would tell them they are about to spend nothing.
 */
function credibilityWeight(dayIndex, monthsWithData) {
    if (!(monthsWithData > 0)) return 1;
    const d = Math.max(0, dayIndex);
    return d / (d + CREDIBILITY_K);
}

/**
 * Projected variable spend for the whole month.
 *
 *   run-rate remaining  = S_d × (remaining share / elapsed share)   ← this month's pace
 *   historical remaining = μ × remaining share                      ← this user's habit
 *   projection = S_d + w × run-rate + (1 − w) × historical
 *
 * Properties worth keeping, each pinned by a test:
 *   • continuous and monotone in `d` — no boundary anywhere in the month
 *   • at d = D the remaining share is 0, so the projection lands exactly on actuals
 *   • early in the month w is small, so one large purchase cannot run away with the month
 *   • late in the month w is large, so a genuinely unusual month is reported as unusual
 */
function projectVariableExpenses({
    spentToDate,
    dayIndex,
    days,
    historicalMean = 0,
    monthsWithData = 0,
    startDate,
    weights,
}) {
    const S = Number(spentToDate) || 0;
    if (dayIndex >= days) return S;

    const elapsed = elapsedShare(dayIndex, startDate, days, weights);
    const remaining = 1 - elapsed;
    if (remaining <= 0) return S;

    // elapsed is never 0 for dayIndex >= 1: every shrunk weight is strictly positive.
    const runRateRemaining = elapsed > 0 ? S * (remaining / elapsed) : 0;
    const histRemaining = (Number(historicalMean) || 0) * remaining;

    // Effective days, not calendar days. The run-rate above divides by the seasonal elapsed
    // share, so the weight has to be measured in the same units or a quiet first day gets a
    // huge multiplier with only a calendar day's damping. With flat weights this is `d`.
    const w = credibilityWeight(elapsed * days, monthsWithData);
    return S + w * runRateRemaining + (1 - w) * histRemaining;
}

/**
 * Projected variable income for the whole month.
 *
 * Replaces `fixed + max(variable_actual, variable_avg)`. That `max` was a floor, not an
 * estimator: late in the month it quietly propped a genuinely bad income month back up to
 * the average, so the forecast could never warn anyone that their income had fallen short.
 * Adding the still-expected remainder instead is the unbiased conditional expectation and
 * lets a weak month read as weak.
 *
 * Adapted from the review's §3.2, which assumes income accrued *by day d* — `income.month`
 * is a `YYYY-MM` column with no day granularity, so there is no `I_d` to read. What we have
 * is everything recorded for the month so far, plus today's date, which is enough.
 *
 * Floored at what has already arrived: a forecast may never show less income than the user
 * has already been paid.
 */
function projectVariableIncome({
    receivedToDate,
    dayIndex,
    days,
    historicalMean = 0,
    startDate,
    weights,
}) {
    const I = Number(receivedToDate) || 0;
    if (dayIndex >= days) return I;
    // Income does not follow the spending week — a salary is not likelier on a Friday —
    // so this stays on plain calendar days rather than the day-of-week weights.
    void startDate; void weights;
    const remaining = (days - dayIndex) / days;
    return Math.max(I, I + (Number(historicalMean) || 0) * remaining);
}

/**
 * A ±1σ band around the forecast, or nulls when there is not enough history to have a
 * defensible one.
 *
 * Only the *unspent* part of the month is uncertain — money already spent is known — so
 * each standard deviation is scaled by the share of the month still ahead. Income and
 * expense uncertainty are independent enough to add in quadrature rather than linearly;
 * summing them would overstate the band by roughly 40%.
 *
 * Returns nulls rather than a zero-width band when history is too thin. A range the user
 * cannot rely on is worse than no range at all — it is the same false precision as a
 * point estimate, just wearing a confidence interval.
 */
function forecastRange(point, { expenseStdDev, incomeStdDev, remainingShare }) {
    const rho = Math.max(0, Math.min(1, Number(remainingShare) || 0));
    const se = expenseStdDev == null ? null : Number(expenseStdDev) * rho;
    const si = incomeStdDev == null ? null : Number(incomeStdDev) * rho;
    if (se == null && si == null) return { low: null, high: null, sigma: null };
    const sigma = Math.sqrt((se || 0) ** 2 + (si || 0) ** 2);
    if (!(sigma > 0)) return { low: null, high: null, sigma: null };
    return { low: point - sigma, high: point + sigma, sigma };
}

/**
 * How much is left to spend per remaining day without breaking the month.
 *
 * The one number that answers the question the app exists for. Everything already
 * committed comes off the top — the fixed costs still to come, subscriptions not yet
 * billed, the savings the user has chosen to set aside — and what remains is divided by
 * the plain count of days left.
 *
 * Plain days, not seasonality-weighted days: a weighted figure would be larger before a
 * weekend and smaller after it, which is arguably more accurate and definitely unusable —
 * the user needs a number they can hold in their head for the rest of the month.
 *
 * Negative means the month is already committed past its income; the caller reports the
 * overshoot rather than a negative allowance.
 */
function safeToSpendPerDay({
    projectedIncome,
    spentToDate,
    fixedRemaining = 0,
    subscriptionsAhead = 0,
    savingsAllocation = 0,
    dayIndex,
    days,
}) {
    const daysLeft = days - dayIndex;
    const headroom = Number(projectedIncome)
        - Number(spentToDate)
        - Number(fixedRemaining)
        - Number(subscriptionsAhead)
        - Number(savingsAllocation);
    if (daysLeft <= 0) return { per_day: null, headroom, days_left: 0 };
    return { per_day: headroom / daysLeft, headroom, days_left: daysLeft };
}

/**
 * How a closed Sunday-to-Saturday week compares with a typical one.
 *
 * Measures everyday spending only, so `monthlyTarget` must be the variable target and
 * `weekTotal` must exclude fixed categories: a rent charge lands in one week, so counting it
 * graded the calendar rather than the user. Seven consecutive days hold every weekday
 * once, so the expectation needs no day-of-week weighting, only the cycle's daily rate.
 *
 * The ratio is rounded to the precision the message prints, so a grade can never disagree
 * with the percentage beside it. Null means there is no baseline to compare with.
 */
function weeklyScore({ weekTotal, monthlyTarget, cycleDays }) {
    if (!(monthlyTarget > 0) || !(cycleDays > 0)) return null;
    const expected = (monthlyTarget / cycleDays) * 7;
    const ratio = Math.round((weekTotal / expected) * 100) / 100;

    let state;
    if (weekTotal < 0) state = 'refund';
    else if (ratio <= 0.8) state = 'well_under';
    else if (ratio < 1) state = 'under';
    else if (ratio === 1) state = 'on_pace';
    else if (ratio <= 1.2) state = 'over';
    else state = 'well_over';

    return { state, weekTotal, expected, ratio, delta: weekTotal - expected, pct: (ratio - 1) * 100 };
}

/**
 * What a carry-over budget brings into the next cycle.
 *
 * Deficits do not roll forward, and the carry is capped at one monthly limit: uncapped, years
 * of small underspends built a cushion that made the budget meaningless.
 */
function carryForward(limit, carry, spent) {
    const leftover = (limit + carry) - spent;
    return Math.max(0, Math.min(leftover, limit));
}

/** Round once, at the response boundary — never mid-formula. */
const money = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

module.exports = {
    CREDIBILITY_K,
    DOW_PRIOR_STRENGTH,
    LOOKBACK_MONTHS,
    LOOKBACK_HALF_LIFE,
    MIN_CYCLE_HISTORY_DAYS,
    monthsBetween,
    pastMonths,
    weekdayCounts,
    decayedMean,
    categoryHabits,
    monthlyStdDev,
    dowWeights,
    elapsedShare,
    idealPace,
    pacingTarget,
    fixedPaceShape,
    momentumIdeal,
    credibilityWeight,
    projectVariableExpenses,
    projectVariableIncome,
    forecastRange,
    safeToSpendPerDay,
    weeklyScore,
    carryForward,
    money,
};
