const db = require('../config/db');
const fx = require('../services/forecastMath');
const cy = require('../services/cycle');

// Returns deep analytics for a single CYCLE — used by the Insights page.
// month=YYYY-MM names the cycle by the month it starts in (defaults to the current one).
// Returns:
//  - per-category totals (current, previous, 3-cycle avg)
//  - daily totals for the requested cycle (1..days_in_cycle, indexed from the anchor day)
//  - weekend vs weekday averages (computed from daily)
//  - pacing_target + ideal[] for the momentum chart (see forecastMath.pacingTarget)
//  - budget_total (sum of all category monthly_limits) — reported for the budgets UI
//
// The lookback key math below is untouched: a cycle is still identified by a 'YYYY-MM'
// string, so "the three periods before this one" is the same arithmetic it always was.
// Only the boundaries those keys resolve to have changed.
exports.getInsights = async (req, res) => {
    const user_id = req.user.user_id;
    const settings = req.cycleSettings;
    const month = req.query.month || cy.currentCycleKey(settings);
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month format' });

    const [y, m] = month.split('-').map(Number);
    const cycle = cy.resolveCycle(month, settings);
    const daysInCycle = cycle.days;
    // Shifting a date back by (anchor - 1) days moves the anchor day onto the 1st, so
    // DAY() of the shifted date is the day's index within its own cycle and DATE_FORMAT()
    // of it is that cycle's key. One constant does both jobs.
    const shift = cy.anchorShiftDays(settings);

    // previous month
    let py = y, pm = m - 1;
    if (pm === 0) { pm = 12; py--; }
    const prevMonth = `${py}-${String(pm).padStart(2, '0')}`;
    const prevCycle = cy.resolveCycle(prevMonth, settings);

    // 3-month avg window: months [m-3, m-2, m-1]
    const lookback = [];
    for (let i = 1; i <= 3; i++) {
        let yy = y, mm = m - i;
        while (mm <= 0) { mm += 12; yy--; }
        lookback.push(`${yy}-${String(mm).padStart(2, '0')}`);
    }
    const avgWindowStart = cy.cycleStart(lookback[2], settings);

    // The day-of-week shape gets the full lookback the forecast uses — 7 weights want
    // more than 3 months to be anything but noise, and this window feeds no per-category
    // figure, so widening it changes nothing else on the page.
    const dowMonths = fx.pastMonths(month, fx.LOOKBACK_MONTHS);
    const dowWindowStart = cy.cycleStart(dowMonths[dowMonths.length - 1], settings);

    try {
        const [catRows, curBuckets, prevBuckets, avgBuckets, dailyRows, budgetRows, dowRows, fixedDomRows] = await Promise.all([
            db.query(
                `SELECT category_id, name, COALESCE(is_fixed, FALSE) AS is_fixed
                 FROM categories WHERE user_id IS NULL OR user_id = ?
                 ORDER BY is_base DESC, name`,
                [user_id]
            ),
            db.query(
                `SELECT category_id, COALESCE(SUM(amount), 0) AS total
                 FROM expenses
                 WHERE user_id = ?
                   AND is_virtual = FALSE
                   AND created_at >= ?
                   AND created_at < ?
                 GROUP BY category_id`,
                [user_id, cycle.start, cycle.end]
            ),
            db.query(
                `SELECT category_id, COALESCE(SUM(amount), 0) AS total
                 FROM expenses
                 WHERE user_id = ?
                   AND is_virtual = FALSE
                   AND created_at >= ?
                   AND created_at < ?
                 GROUP BY category_id`,
                [user_id, prevCycle.start, prevCycle.end]
            ),
            db.query(
                `SELECT category_id,
                        DATE_FORMAT(DATE_SUB(created_at, INTERVAL ? DAY), '%Y-%m') AS mo,
                        COALESCE(SUM(amount), 0) AS total
                 FROM expenses
                 WHERE user_id = ?
                   AND is_virtual = FALSE
                   AND created_at >= ?
                   AND created_at < ?
                 GROUP BY category_id, mo`,
                [shift, user_id, avgWindowStart, cycle.start]
            ),
            db.query(
                // Split by is_fixed: daily[] is every shekel that left (it draws the
                // cumulative line), but the weekend-habit metric below must see only
                // variable spend — see the day-of-week query for why.
                `SELECT DAY(DATE_SUB(e.created_at, INTERVAL ? DAY)) AS d,
                        COALESCE(c.is_fixed, FALSE) AS is_fixed,
                        COALESCE(SUM(e.amount), 0) AS total
                 FROM expenses e LEFT JOIN categories c ON e.category_id = c.category_id
                 WHERE e.user_id = ?
                   AND e.is_virtual = FALSE
                   AND e.created_at >= ?
                   AND e.created_at < ?
                 GROUP BY d, is_fixed
                 ORDER BY d`,
                [shift, user_id, cycle.start, cycle.end]
            ),
            // Per-category, not a bare SUM. The momentum target is built category by
            // category — budget where the user set one, 3-month habit where they did not —
            // so a total is no longer enough information. GROUP BY guards the case of two
            // budget rows for one category; `budget_total` stays the sum of them all.
            db.query(
                `SELECT category_id, COALESCE(SUM(monthly_limit), 0) AS monthly_limit
                 FROM budgets WHERE user_id = ? GROUP BY category_id`,
                [user_id]
            ),
            // Day-of-week spending shape, for the momentum chart's ideal curve. A flat
            // line assumes every day of the month is equally expensive, which is false for
            // anyone whose weekend looks different from their Tuesday.
            //
            // is_fixed categories are excluded, and that exclusion is load-bearing: rent
            // is charged on the 1st, which is a day-of-MONTH event, not a day-of-week one.
            // Without the filter a ₪4,200 rent falling on two Sundays and two Wednesdays
            // over the window made those the "heavy" weekdays and buried the real Fri/Sat
            // signal completely. Day-of-week only models habitual spending.
            // DAYOFWEEK() is 1=Sunday..7; shifted to JS getDay() order on the way out.
            db.query(
                `SELECT DAYOFWEEK(e.created_at) - 1 AS dow, COALESCE(SUM(e.amount), 0) AS total
                 FROM expenses e LEFT JOIN categories c ON e.category_id = c.category_id
                 WHERE e.user_id = ?
                   AND e.is_virtual = FALSE AND COALESCE(c.is_fixed, FALSE) = FALSE
                   AND e.created_at >= ?
                   AND e.created_at < ?
                 GROUP BY dow`,
                [user_id, dowWindowStart, cycle.start]
            ),
            // Day-of-CYCLE shape of fixed spending, the other half of the ideal curve.
            // This is the exact complement of the query above: that one models habitual
            // spending on a day-of-week axis and excludes fixed costs, this one models
            // fixed costs on the axis they actually live on. Rent lands on the same date
            // every month, so smearing it evenly — which is what the chart did before —
            // reported everyone as over pace for the first three weeks.
            //
            // The axis is the day's position WITHIN ITS CYCLE, not its day-of-month: with
            // an anchor of 10 a rent charged on the 1st is day 22, and the step has to
            // land there or the smearing bug simply moves three weeks later.
            db.query(
                `SELECT DAY(DATE_SUB(e.created_at, INTERVAL ? DAY)) AS dom,
                        COALESCE(SUM(e.amount), 0) AS total
                 FROM expenses e LEFT JOIN categories c ON e.category_id = c.category_id
                 WHERE e.user_id = ?
                   AND e.is_virtual = FALSE AND COALESCE(c.is_fixed, FALSE) = TRUE
                   AND e.created_at >= ?
                   AND e.created_at < ?
                 GROUP BY dom`,
                [shift, user_id, dowWindowStart, cycle.start]
            ),
        ]);

        const categories = catRows[0];
        const curMap = Object.fromEntries(curBuckets[0].map(r => [r.category_id, Number(r.total)]));
        const prevMap = Object.fromEntries(prevBuckets[0].map(r => [r.category_id, Number(r.total)]));

        // 3-month avg per category — denom = months_with_data so partial history isn't unfairly low
        const avgAccum = {}; // {cat_id: { sum, monthsSet }}
        for (const r of avgBuckets[0]) {
            const cid = r.category_id;
            if (!avgAccum[cid]) avgAccum[cid] = { sum: 0, months: new Set() };
            avgAccum[cid].sum += Number(r.total);
            avgAccum[cid].months.add(r.mo);
        }

        const by_category = categories.map(c => {
            const a = avgAccum[c.category_id];
            const months_with_data = a ? a.months.size : 0;
            return {
                category_id: c.category_id,
                name: c.name,
                is_fixed: !!c.is_fixed,
                spent: Math.round((curMap[c.category_id] || 0) * 100) / 100,
                prev_spent: Math.round((prevMap[c.category_id] || 0) * 100) / 100,
                three_mo_avg: months_with_data > 0
                    ? Math.round((a.sum / months_with_data) * 100) / 100
                    : 0,
            };
        });

        // Uncategorized spend, the same way getBudgets surfaces it.
        //
        // Without this row it disappears: the map above walks the `categories` table while
        // curMap is keyed by category_id, so rows with a NULL category never match anything
        // and were silently dropped from total_spent and every per-category chart. The
        // daily[] array below is grouped by DAY, not by category, so it always DID include
        // them — meaning one response contradicted itself, and the momentum line ran above
        // the total the burn-rate card was computed from.
        const uncatAvg = avgAccum['null'] || avgAccum[null];
        const uncat = {
            category_id: null,
            name: 'Uncategorized',
            is_fixed: false,
            spent: Math.round((curMap['null'] || curMap[null] || 0) * 100) / 100,
            prev_spent: Math.round((prevMap['null'] || prevMap[null] || 0) * 100) / 100,
            three_mo_avg: uncatAvg && uncatAvg.months.size > 0
                ? Math.round((uncatAvg.sum / uncatAvg.months.size) * 100) / 100
                : 0,
        };
        if (uncat.spent > 0 || uncat.prev_spent > 0 || uncat.three_mo_avg > 0) by_category.push(uncat);

        // Daily array — index 0..daysInCycle-1, day 1 being the user's anchor day. Only
        // past/today days are non-null for the live cycle.
        const today = new Date();
        const isCurrentCycle = cy.currentCycleKey(settings, today) === month;
        const todayDay = isCurrentCycle ? cy.dayIndexIn(cycle, today) : daysInCycle;

        const dayMap = {};      // everything
        const dayMapVar = {};   // variable only
        for (const r of dailyRows[0]) {
            const d = Number(r.d);
            const v = Number(r.total);
            dayMap[d] = (dayMap[d] || 0) + v;
            if (Number(r.is_fixed) !== 1) dayMapVar[d] = (dayMapVar[d] || 0) + v;
        }
        const daily = [];
        for (let d = 1; d <= daysInCycle; d++) {
            if (d > todayDay) daily.push(null);
            else daily.push(Math.round((dayMap[d] || 0) * 100) / 100);
        }

        // Weekend vs weekday daily averages — real day-of-week, variable spend only.
        // Rent is charged on the 1st; when that lands on a Saturday it single-handedly
        // made the weekend look 5x heavier than the week, which is an artefact of the
        // calendar rather than anything about the user's habits.
        let weStot = 0, wdStot = 0, weDays = 0, wdDays = 0;
        const cycleDow0 = new Date(`${cycle.start}T00:00:00Z`).getUTCDay();
        for (let d = 1; d <= todayDay; d++) {
            const dow = (cycleDow0 + d - 1) % 7; // 0=Sun..6=Sat — Fri/Sat = weekend in IL
            const v = dayMapVar[d] || 0;
            if (dow === 5 || dow === 6) { weStot += v; weDays++; } else { wdStot += v; wdDays++; }
        }
        const weekend_daily_avg = weDays ? Math.round((weStot / weDays) * 100) / 100 : 0;
        const weekday_daily_avg = wdDays ? Math.round((wdStot / wdDays) * 100) / 100 : 0;

        const total_spent = Math.round(by_category.reduce((s, c) => s + c.spent, 0) * 100) / 100;
        const three_mo_avg_total = Math.round(by_category.reduce((s, c) => s + c.three_mo_avg, 0) * 100) / 100;

        const budgetMap = {};
        for (const r of budgetRows[0] || []) budgetMap[r.category_id] = Number(r.monthly_limit);
        const budget_total = Math.round(
            Object.values(budgetMap).reduce((s, v) => s + v, 0) * 100
        ) / 100;

        const dowTotals = new Array(7).fill(0);
        for (const r of dowRows[0] || []) {
            const i = Number(r.dow);
            if (i >= 0 && i <= 6) dowTotals[i] = Number(r.total);
        }
        const dow_weights = fx.dowWeights(dowTotals, fx.weekdayCounts(dowWindowStart, cycle.start));

        // Momentum pacing target — every category contributes its budget if the user set
        // one and its 3-month habit if they did not, so the target covers exactly the
        // categories the cumulative line sums. `by_category` is the right list to walk
        // because it already carries the Uncategorized row.
        const pacing = fx.pacingTarget(by_category.map(c => ({
            is_fixed: c.is_fixed,
            three_mo_avg: c.three_mo_avg,
            budget_limit: c.category_id != null && budgetMap[c.category_id] !== undefined
                ? budgetMap[c.category_id]
                : null,
        })));

        const fixedDomTotals = {};
        for (const r of fixedDomRows[0] || []) fixedDomTotals[Number(r.dom)] = Number(r.total);

        const ideal = fx.momentumIdeal({
            fixedTarget: pacing.fixed,
            variableTarget: pacing.variable,
            fixedShape: fx.fixedPaceShape(fixedDomTotals, daysInCycle),
            startDate: cycle.start,
            days: daysInCycle,
            weights: dow_weights,
        }).map(v => Math.round(v * 100) / 100);

        const pacing_target = {
            total: Math.round(pacing.total * 100) / 100,
            budgeted: Math.round(pacing.budgeted * 100) / 100,
            habit: Math.round(pacing.habit * 100) / 100,
            fixed: Math.round(pacing.fixed * 100) / 100,
            variable: Math.round(pacing.variable * 100) / 100,
            budgeted_categories: pacing.budgeted_categories,
        };

        res.json({
            month,
            prev_month: prevMonth,
            // The period, spelled out — the chart's x-axis is cycle days, and only the
            // server knows what calendar dates those are.
            days_in_cycle: daysInCycle,
            cycle_start: cycle.start,
            cycle_end: cycle.last_day,
            cycle_day: todayDay,
            is_current_cycle: isCurrentCycle,
            budget_total,
            pacing_target,
            ideal,
            total_spent,
            three_mo_avg_total,
            by_category,
            daily,
            weekend_daily_avg,
            weekend_days_elapsed: weDays,
            weekday_days_elapsed: wdDays,
            weekday_daily_avg,
            dow_weights,
        });
    } catch (err) {
        console.error('getInsights error:', err);
        res.status(500).json({ error: 'Failed to fetch insights' });
    }
};
