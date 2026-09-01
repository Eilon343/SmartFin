const db = require('../config/db');
const fx = require('../services/forecastMath');
const cy = require('../services/cycle');

/**
 * Every endpoint below scopes its numbers to one financial CYCLE, not one calendar month.
 * `?month=YYYY-MM` still names the period — it is the month the cycle starts in — but the
 * boundary comes from services/cycle.js and the user's settings, never from `-01`.
 * `req.cycleSettings` is attached by the auth middleware.
 */
const MONTH_KEY = /^\d{4}-\d{2}$/;

/**
 * A category may be used by a caller only if it is a shared base category
 * (user_id IS NULL) or one they own. The FK alone only proves the category
 * exists — without this check a user could attach their own row to another
 * user's private category and read that category's name back out through the
 * joins in getAllExpenses / getSummary / getBudgets.
 * Returns true when category_id is absent (it is optional on every caller).
 */
async function categoryAllowed(category_id, user_id) {
    if (category_id == null) return true;
    const [rows] = await db.query(
        'SELECT 1 FROM categories WHERE category_id = ? AND (user_id IS NULL OR user_id = ?)',
        [category_id, user_id]
    );
    return rows.length > 0;
}

exports.getAllExpenses = async (req, res) => {
    const user_id = req.user.user_id;
    const { month } = req.query; // optional: "2025-04" — the cycle starting in that month
    if (month && !MONTH_KEY.test(month)) return res.status(400).json({ error: 'Invalid month format' });

    try {
        // The category join is scoped too: a row already pointing at a foreign
        // category yields a NULL name rather than leaking someone else's label.
        let query = 'SELECT e.*, c.name AS category_name, e.source FROM expenses e LEFT JOIN categories c ON e.category_id = c.category_id AND (c.user_id IS NULL OR c.user_id = ?) WHERE e.user_id = ?';
        const params = [user_id, user_id];

        if (month) {
            const cycle = cy.resolveCycle(month, req.cycleSettings);
            query += ' AND e.created_at >= ? AND e.created_at < ?';
            params.push(cycle.start, cycle.end);
        }

        query += ' ORDER BY e.created_at DESC';
        const [rows] = await db.query(query, params);
        res.json(rows);
    } catch (err) {
        console.error('getAllExpenses error:', err);
        res.status(500).json({ error: 'Failed to fetch expenses' });
    }
};

exports.getSummary = async (req, res) => {
    const user_id = req.user.user_id;
    const month = req.query.month || cy.currentCycleKey(req.cycleSettings); // default current cycle
    if (month && !MONTH_KEY.test(month)) return res.status(400).json({ error: 'Invalid month format' });

    try {
        const cycle = cy.resolveCycle(month, req.cycleSettings);
        const [rows] = await db.query(
            `SELECT COALESCE(c.name, 'Uncategorized') AS category, SUM(e.amount) AS total
             FROM expenses e
             LEFT JOIN categories c ON e.category_id = c.category_id AND (c.user_id IS NULL OR c.user_id = ?)
             WHERE e.user_id = ? AND e.created_at >= ? AND e.created_at < ? AND e.is_virtual = FALSE
             GROUP BY e.category_id
             ORDER BY total DESC`,
            [user_id, user_id, cycle.start, cycle.end]
        );
        const grand_total = rows.reduce((sum, r) => sum + Number(r.total), 0);
        res.json({ month, grand_total, by_category: rows });
    } catch (err) {
        console.error('getSummary error:', err);
        res.status(500).json({ error: 'Failed to fetch summary' });
    }
};

exports.getBudgets = async (req, res) => {
    const user_id = req.user.user_id;
    const month = req.query.month || cy.currentCycleKey(req.cycleSettings); // 'YYYY-MM' cycle key
    if (month && !MONTH_KEY.test(month)) return res.status(400).json({ error: 'Invalid month format' });

    try {
        const cycle = cy.resolveCycle(month, req.cycleSettings);
        // Shifting a date back by (anchor - 1) days puts the anchor day on the 1st, so the
        // ordinary month truncation then yields the cycle the row belongs to. Used for both
        // the budget's own first cycle and the per-cycle spend buckets below.
        const shift = cy.anchorShiftDays(req.cycleSettings);
        const [budgetRows] = await db.query(
            `SELECT b.budget_id, b.category_id, c.name AS category,
                    b.monthly_limit, b.carry_over,
                    DATE_FORMAT(DATE_SUB(b.created_at, INTERVAL ? DAY), '%Y-%m') AS start_month
             FROM budgets b JOIN categories c ON b.category_id = c.category_id
                  AND (c.user_id IS NULL OR c.user_id = ?)
             WHERE b.user_id = ?`,
            [shift, user_id, user_id]
        );

        // Fetch all expense totals per category per month in one query
        const earliestStart = budgetRows.reduce((min, b) => {
            const s = b.start_month <= month ? b.start_month : month;
            return s < min ? s : min;
        }, month);
        const [expenseRows] = await db.query(
            `SELECT category_id,
                    DATE_FORMAT(DATE_SUB(created_at, INTERVAL ? DAY), '%Y-%m') AS mo,
                    COALESCE(SUM(amount), 0) AS total
             FROM expenses
             WHERE user_id = ?
               AND created_at >= ?
               AND created_at < ?
               AND is_virtual = FALSE
             GROUP BY category_id, mo`,
            [shift, user_id, cy.cycleStart(earliestStart, req.cycleSettings), cycle.end]
        );
        const spentMap = {};
        for (const r of expenseRows) {
            if (!spentMap[r.category_id]) spentMap[r.category_id] = {};
            spentMap[r.category_id][r.mo] = Number(r.total);
        }
        const getSpent = (catId, mo) => (spentMap[catId]?.[mo] || 0);

        const result = [];
        const budgetedCategoryIds = new Set();

        for (const b of budgetRows) {
            budgetedCategoryIds.add(b.category_id);
            const limit = Number(b.monthly_limit);
            const startMonth = b.start_month <= month ? b.start_month : month;

            let carry = 0;
            if (b.carry_over) {
                const months = monthsBetween(startMonth, month);
                for (const m of months.slice(0, -1)) {
                    const leftover = (limit + carry) - getSpent(b.category_id, m);
                    carry = leftover > 0 ? leftover : 0;
                }
            }

            const spent_this_month = getSpent(b.category_id, month);
            const effective_limit = limit + carry;
            const remaining = effective_limit - spent_this_month;

            result.push({
                budget_id: b.budget_id,
                category_id: b.category_id,
                category: b.category,
                monthly_limit: limit,
                carry_over: !!b.carry_over,
                carried_in: Math.round(carry * 100) / 100,
                spent: Math.round(spent_this_month * 100) / 100,
                effective_limit: Math.round(effective_limit * 100) / 100,
                remaining: Math.round(remaining * 100) / 100,
                pct_used: effective_limit > 0 ? Math.round((spent_this_month / effective_limit) * 100) : 0,
                no_budget: false,
            });
        }

        // Also include all base/user categories not already covered by a budget entry
        const [allCatRows] = await db.query(
            `SELECT category_id, name AS category
             FROM categories
             WHERE user_id IS NULL OR user_id = ?
             ORDER BY is_base DESC, name`,
            [user_id]
        );

        for (const c of allCatRows) {
            if (!budgetedCategoryIds.has(c.category_id)) {
                result.push({
                    budget_id: null,
                    category_id: c.category_id,
                    category: c.category,
                    monthly_limit: null,
                    carry_over: false,
                    carried_in: 0,
                    spent: getSpent(c.category_id, month),
                    effective_limit: null,
                    remaining: null,
                    pct_used: null,
                    no_budget: true,
                });
            }
        }

        // Include null-category expenses as "Uncategorized" if any exist this month
        const uncategorizedSpent = getSpent(null, month);
        if (uncategorizedSpent > 0) {
            result.push({
                budget_id: null,
                category_id: null,
                category: 'Uncategorized',
                monthly_limit: null,
                carry_over: false,
                carried_in: 0,
                spent: Math.round(uncategorizedSpent * 100) / 100,
                effective_limit: null,
                remaining: null,
                pct_used: null,
                no_budget: true,
            });
        }

        res.json({ month, budgets: result });
    } catch (err) {
        console.error('getBudgets error:', err);
        res.status(500).json({ error: 'Failed to fetch budgets' });
    }
};


function monthsBetween(start, end) {
    // start, end as 'YYYY-MM'; returns inclusive list
    const [sy, sm] = start.split('-').map(Number);
    const [ey, em] = end.split('-').map(Number);
    const months = [];
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
        months.push(`${y}-${String(m).padStart(2, '0')}`);
        m++;
        if (m > 12) { m = 1; y++; }
    }
    return months;
}

exports.getSubscriptions = async (req, res) => {
    const user_id = req.user.user_id;
    try {
        const [rows] = await db.query(
            `SELECT s.subscription_id, s.name, s.amount, s.currency,
                    s.day_of_month, s.active, s.paused, s.last_charged_month,
                    s.category_id, c.name AS category
             FROM subscriptions s
             LEFT JOIN categories c ON s.category_id = c.category_id
             WHERE s.user_id = ? AND s.active = TRUE
             ORDER BY s.day_of_month`,
            [user_id]
        );
        res.json(rows.map(r => ({ ...r, amount: Number(r.amount) })));
    } catch (err) {
        console.error('getSubscriptions error:', err);
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
};

exports.addSubscription = async (req, res) => {
    const user_id = req.user.user_id;
    const { name, amount, currency = 'ILS', category_id, day_of_month } = req.body;
    if (!name || amount == null || !day_of_month) {
        return res.status(400).json({ error: 'name, amount, day_of_month required' });
    }
    const day = parseInt(day_of_month, 10);
    if (day < 1 || day > 28) return res.status(400).json({ error: 'day_of_month must be 1–28' });
    try {
        if (!await categoryAllowed(category_id, user_id)) return res.status(400).json({ error: 'Invalid category' });
        const [result] = await db.query(
            `INSERT INTO subscriptions (user_id, name, amount, currency, category_id, day_of_month)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [user_id, name.trim(), Number(amount), currency, category_id || null, day]
        );
        res.json({ subscription_id: result.insertId });
    } catch (err) {
        console.error('addSubscription error:', err);
        res.status(500).json({ error: 'Failed to add subscription' });
    }
};

exports.updateSubscription = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    const { name, amount, currency, category_id, day_of_month } = req.body;
    if (!name || amount == null || !day_of_month) {
        return res.status(400).json({ error: 'name, amount, day_of_month required' });
    }
    const day = parseInt(day_of_month, 10);
    if (day < 1 || day > 28) return res.status(400).json({ error: 'day_of_month must be 1–28' });
    try {
        if (!await categoryAllowed(category_id, user_id)) return res.status(400).json({ error: 'Invalid category' });
        const [result] = await db.query(
            `UPDATE subscriptions SET name=?, amount=?, currency=?, category_id=?, day_of_month=?
             WHERE subscription_id=? AND user_id=?`,
            [name.trim(), Number(amount), currency || 'ILS', category_id || null, day, id, user_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('updateSubscription error:', err);
        res.status(500).json({ error: 'Failed to update subscription' });
    }
};

exports.deleteSubscription = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    try {
        const [result] = await db.query(
            `UPDATE subscriptions SET active=FALSE WHERE subscription_id=? AND user_id=?`,
            [id, user_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('deleteSubscription error:', err);
        res.status(500).json({ error: 'Failed to delete subscription' });
    }
};

exports.togglePauseSubscription = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    const { paused } = req.body;
    try {
        const [result] = await db.query(
            'UPDATE subscriptions SET paused=? WHERE subscription_id=? AND user_id=?',
            [paused ? 1 : 0, id, user_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('togglePauseSubscription error:', err);
        res.status(500).json({ error: 'Failed to toggle pause' });
    }
};

// P&L = projected_income - projected_expenses - subscription_total - savings_transferred
// savings_transferred = SUM(amount) of virtual expenses this month (actual moves to savings goals).
//
// Every formula below lives in `services/forecastMath.js` and is pure — this controller
// fetches rows and shapes a response, nothing more. Read that module's header before
// changing any of it; it records which estimators were rejected and why.
//
//   projected_income   = fixed_income + variable_actual + μ_income × (remaining days / D)
//                        (floored at variable_actual — never forecast less than received)
//   projected_expenses = fixed_sum + credibility-weighted projection of variable spend,
//                        blending this month's pace with the user's own history by
//                        w = d / (d + 7). Fixed costs are never run-rated.
//   forecast_low/high  = ±1σ of the *unspent* part of the month, or null below 2 months
//                        of history — never a fabricated interval.
//   safe_to_spend      = what is left per remaining day after everything committed.
//
// Averages use a 6-month window with a 2-month half-life, and the denominator is always
// months_with_data — a user with two months of history is never divided by six.
//
// subscription_total counts ONLY subscriptions not yet billed in the requested month
// (future month → all of them; current month → billing day still ahead; past month → 0).
// It is a forecast of money still to leave, not a record of money that left. Once the
// billing day passes, the real charge lands in `expenses` via bank/card sync and is
// already inside projected_expenses; counting the subscription as well subtracted the
// same money twice. Being forward-only, it is NOT pro-rated by the MTD clamp, and it
// belongs to forecasted_net_pnl alone — current_net_pnl is actuals only.

exports.getPnL = async (req, res) => {
    const user_id = req.user.user_id;
    const settings = req.cycleSettings;
    const month = req.query.month || cy.currentCycleKey(settings);
    if (month && !MONTH_KEY.test(month)) return res.status(400).json({ error: 'Invalid month format' });

    // The cycle is the period. `month` names the calendar month it starts in; everything
    // below reads its boundaries from here and never reconstructs them.
    const cycle = cy.resolveCycle(month, settings);
    const daysInCycle = cycle.days;

    // Cycle-to-Date clamp (`?as_of_day=N`): only count data for days 1..N OF THE CYCLE.
    // Used by the dashboard to compare same-length windows (e.g. days 1–8 of this cycle vs
    // days 1–8 of the last) so the previous cycle doesn't look artificially better/worse
    // just because it's complete. Clamped to this cycle's real length, which handles the
    // 28-vs-31 day spread cycles inherit from the calendar underneath them.
    const asOfRaw = req.query.as_of_day != null ? Number(req.query.as_of_day) : NaN;
    const asOfDay = Number.isFinite(asOfRaw)
        ? Math.max(1, Math.min(daysInCycle, Math.floor(asOfRaw)))
        : null;
    const isMTD = asOfDay != null;
    // Income and subscriptions have no per-day granularity in their tables, so they are
    // pro-rated by (asOfDay / daysInCycle) for fair MTD comparison. Savings transfers use
    // created_at, so they are SQL-clamped instead.
    const proRate = isMTD ? asOfDay / daysInCycle : 1;
    // One window end for every expense query: the clamp is a shorter window, not a
    // different query, which is what collapsed the old MTD/full SQL pairs into one each.
    const windowEnd = isMTD ? cy.addDays(cycle.start, asOfDay) : cycle.end;

    try {
        const lookback = fx.pastMonths(month, fx.LOOKBACK_MONTHS);
        const oldestLookback = lookback[lookback.length - 1];
        const lookbackStart = cy.cycleStart(oldestLookback, settings);
        const shift = cy.anchorShiftDays(settings);
        // `income.month` has no day, so the cycle a salary belongs to is derived from the
        // user's salary_day rather than read off the row. See cycle.incomeMonthOf.
        const incomeMonth = cycle.income_month;
        const lookbackIncomeMonths = lookback.map(k => cy.incomeMonthOf(k, settings));

        // Expenses have a real `created_at` timestamp, so we clamp them via SQL rather than pro-rating.
        // Split into fixed vs variable buckets via categories.is_fixed for smart forecasting.
        // NULL category_id (uncategorized) treated as variable.
        const expensesSql =
            `SELECT COALESCE(c.is_fixed, FALSE) AS is_fixed, COALESCE(SUM(e.amount), 0) AS total
             FROM expenses e LEFT JOIN categories c ON e.category_id = c.category_id
             WHERE e.user_id = ? AND e.created_at >= ? AND e.created_at < ? AND e.is_virtual = FALSE
             GROUP BY COALESCE(c.is_fixed, FALSE)`;

        const [[expRows], [subRows], [savRows], [fixedRows], [varActualRows], [varPastRows], [expPastRows], [dowRows]] = await Promise.all([
            db.query(expensesSql, [user_id, cycle.start, windowEnd]),
            // Subscriptions that have NOT been charged yet in this cycle. Once the billing
            // day passes, the real charge is already in `expenses` — imported by bank/card
            // sync — so counting the subscription too would subtract it twice.
            // Future cycle  → every subscription is still ahead.
            // Current cycle → only those whose billing day has not arrived.
            // Past cycle    → all already charged, hence 0.
            //
            // The "has it happened yet" test moved out of SQL. `day_of_month > DAY(CURDATE())`
            // is meaningless once a cycle straddles two months: with an anchor of 10, the 5th
            // is the END of the cycle, not the start, so a numeric day comparison ranks the
            // charges in the wrong order. The rows are resolved to real dates in JS below.
            db.query(
                `SELECT subscription_id, amount, day_of_month FROM subscriptions
                 WHERE user_id = ? AND active = TRUE AND paused = FALSE
                   AND created_at < ?`,
                [user_id, cycle.end]
            ),
            db.query(
                `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
                 WHERE user_id = ? AND is_virtual = TRUE
                   AND created_at >= ? AND created_at < ?`,
                [user_id, cycle.start, windowEnd]
            ),
            db.query(
                "SELECT COALESCE(SUM(amount), 0) AS total FROM income WHERE user_id = ? AND type = 'fixed' AND month = ?",
                [user_id, incomeMonth]
            ),
            db.query(
                "SELECT COALESCE(SUM(amount), 0) AS total FROM income WHERE user_id = ? AND type = 'variable' AND month = ?",
                [user_id, incomeMonth]
            ),
            // Per-month rows, not a pre-averaged total: the decay weighting and the
            // standard deviation behind the forecast range both need the individual months.
            db.query(
                `SELECT month, COALESCE(SUM(amount), 0) AS total FROM income
                 WHERE user_id = ? AND type = 'variable' AND month IN (${lookbackIncomeMonths.map(() => '?').join(', ')})
                 GROUP BY month`,
                [user_id, ...lookbackIncomeMonths]
            ),
            // Historical VARIABLE spend per month — the prior the credibility weighting
            // blends toward. Same fixed/variable split and is_virtual exclusion as the
            // current-month query above, or the prior would not be comparable to S_d.
            db.query(
                `SELECT DATE_FORMAT(DATE_SUB(e.created_at, INTERVAL ? DAY), '%Y-%m') AS month,
                        COALESCE(SUM(e.amount), 0) AS total
                 FROM expenses e LEFT JOIN categories c ON e.category_id = c.category_id
                 WHERE e.user_id = ? AND e.is_virtual = FALSE AND COALESCE(c.is_fixed, FALSE) = FALSE
                   AND e.created_at >= ?
                   AND e.created_at < ?
                 GROUP BY month`,
                [shift, user_id, lookbackStart, cycle.start]
            ),
            // Day-of-week spending shape over the same window. DAYOFWEEK() is 1=Sunday..7,
            // shifted to JS getDay() order (0=Sunday) on the way out.
            db.query(
                `SELECT DAYOFWEEK(e.created_at) - 1 AS dow, COALESCE(SUM(e.amount), 0) AS total
                 FROM expenses e LEFT JOIN categories c ON e.category_id = c.category_id
                 WHERE e.user_id = ? AND e.is_virtual = FALSE AND COALESCE(c.is_fixed, FALSE) = FALSE
                   AND e.created_at >= ?
                   AND e.created_at < ?
                 GROUP BY dow`,
                [user_id, lookbackStart, cycle.start]
            )
        ]);

        // Bucket expenses by fixed/variable. Row may be missing if no rows in that bucket.
        let fixed_sum = 0, variable_sum = 0;
        for (const r of expRows) {
            if (Number(r.is_fixed) === 1) fixed_sum = Number(r.total);
            else variable_sum = Number(r.total);
        }
        const total_expenses = fixed_sum + variable_sum;
        // Subscriptions still ahead of us, resolved to real dates inside this cycle. A
        // billing day is placed on whichever side of the anchor it belongs to, so with an
        // anchor of 10 a subscription billed on the 3rd is near the cycle's END and stays
        // "ahead" for almost the whole period — which the old day-number comparison in SQL
        // got exactly backwards.
        //
        // Not pro-rated by the MTD clamp: this is already only the charges still ahead,
        // not a whole-cycle figure being narrowed to a partial window.
        const todayISO = cy.todayISO();
        const subscription_total = (subRows || [])
            .filter(s => cy.chargeDateInCycle(cycle, s.day_of_month) > todayISO)
            .reduce((sum, s) => sum + Number(s.amount), 0);
        const savings_allocation = Number(savRows[0].total);
        const fixed_income = Number(fixedRows[0].total) * proRate;
        const variable_actual = Number(varActualRows[0].total) * proRate;

        // Decayed means over the lookback. `months_with_data` is the row count, so a user
        // with two months of history is divided by two, never by LOOKBACK_MONTHS.
        // Income rows come back keyed by `income.month`; the decay ages them by distance
        // from the anchor CYCLE, so they are mapped back before being weighed.
        const incomeHistory = (varPastRows || []).map(r => ({
            month: cy.cycleKeyOfIncomeMonth(r.month, settings),
            total: Number(r.total),
        }));
        const expenseHistory = (expPastRows || []).map(r => ({ month: r.month, total: Number(r.total) }));
        const incomeMonths = incomeHistory.length;
        const expenseMonths = expenseHistory.length;
        const variable_avg = fx.decayedMean(incomeHistory, month) * proRate;
        const variable_expense_avg = fx.decayedMean(expenseHistory, month);

        // Day-of-week shape. dayCounts must come from the same window the totals did, or
        // the rates are not comparable across weekdays.
        const dowTotals = new Array(7).fill(0);
        for (const r of dowRows || []) {
            const i = Number(r.dow);
            if (i >= 0 && i <= 6) dowTotals[i] = Number(r.total);
        }
        const dow_weights = fx.dowWeights(dowTotals, fx.weekdayCounts(lookbackStart, cycle.start));

        const actual_income = fixed_income + variable_actual;
        // Subscriptions are deliberately NOT subtracted here. subscription_total is money
        // still ahead of us this month; current_net_pnl is where the user stands right now,
        // built only from money that has actually moved. Mixing the two also broke the
        // month-vs-month delta on the dashboard: a past month always scores 0 subscriptions,
        // so the current month was penalised by charges that had not happened in either.
        // The forecast below is where subscription_total belongs.
        const current_net_pnl = actual_income - total_expenses - savings_allocation;

        // Smart Forecast. Fixed expenses (rent, utilities) are flat — already paid, won't
        // recur this month — so only variable spend is projected forward, by the
        // credibility blend in forecastMath. Unlike the run-rate this replaced, it needs
        // no minimum-day guard and no special case for zero spend: with S_d = 0 it simply
        // returns the historical expectation, which is the right answer on the 1st.
        // For MTD requests (prev-month comparison anchor), keep projection = actual.
        const currentCycle = cy.currentCycleKey(settings);
        // A future cycle is day 0 — nothing has happened yet, so the whole cycle is still
        // ahead and both estimators fall through to the historical expectation on their
        // own. A past cycle is fully elapsed and its "projection" is simply its actuals.
        const isFutureCycle = month > currentCycle;
        const isLiveCycle = !isMTD && month >= currentCycle;
        const dayIndex = isFutureCycle
            ? 0
            : (month === currentCycle ? Math.max(1, cy.dayIndexIn(cycle, new Date())) : daysInCycle);
        const remaining_share = isLiveCycle
            ? 1 - fx.elapsedShare(dayIndex, cycle.start, daysInCycle, dow_weights)
            : 0;

        let projected_expenses = total_expenses;
        let projected_variable = variable_sum;
        if (isLiveCycle) {
            projected_variable = fx.projectVariableExpenses({
                spentToDate: variable_sum,
                dayIndex,
                days: daysInCycle,
                historicalMean: variable_expense_avg,
                monthsWithData: expenseMonths,
                startDate: cycle.start,
                weights: dow_weights,
            });
            projected_expenses = fixed_sum + projected_variable;
        }

        const projected_variable_income = isLiveCycle
            ? fx.projectVariableIncome({
                receivedToDate: variable_actual,
                dayIndex,
                days: daysInCycle,
                historicalMean: variable_avg,
                startDate: cycle.start,
                weights: dow_weights,
            })
            : variable_actual;
        const projected_income = isMTD ? actual_income : fixed_income + projected_variable_income;
        // The forecast is the only place subscription_total belongs — in both branches,
        // so "money still to come out" is never silently dropped by the MTD clamp.
        const forecasted_net_pnl = isMTD
            ? current_net_pnl - subscription_total
            : projected_income - projected_expenses - subscription_total - savings_allocation;

        // ±1σ on the unspent part of the month only. Suppressed entirely outside the live
        // month: a completed month has no uncertainty left to describe.
        const range = isLiveCycle
            ? fx.forecastRange(forecasted_net_pnl, {
                expenseStdDev: fx.monthlyStdDev(expenseHistory),
                incomeStdDev: fx.monthlyStdDev(incomeHistory),
                remainingShare: remaining_share,
            })
            : { low: null, high: null, sigma: null };

        // What is left per remaining day once everything already committed is off the top.
        // fixed_remaining is 0: fixed costs are flat monthly charges that have already
        // landed by the time they matter, and they are inside total_expenses via fixed_sum.
        const safe = isLiveCycle
            ? fx.safeToSpendPerDay({
                projectedIncome: projected_income,
                spentToDate: total_expenses,
                subscriptionsAhead: subscription_total,
                savingsAllocation: savings_allocation,
                dayIndex,
                days: daysInCycle,
            })
            : { per_day: null, headroom: null, days_left: 0 };

        res.json({
            month,
            as_of_day: asOfDay,
            // The period, spelled out. The client draws its date axis and its "days left"
            // from these rather than re-deriving a boundary it would have to keep in sync.
            days_in_cycle: daysInCycle,
            cycle_start: cycle.start,
            cycle_end: cycle.last_day,
            cycle_day: dayIndex,
            income_month: incomeMonth,
            is_mtd: isMTD,
            fixed_income: Math.round(fixed_income * 100) / 100,
            variable_income_actual: Math.round(variable_actual * 100) / 100,
            variable_income_avg: Math.round(variable_avg * 100) / 100,
            total_income_actual: Math.round(actual_income * 100) / 100,
            total_income_projected: Math.round(projected_income * 100) / 100,
            total_expenses: Math.round(total_expenses * 100) / 100,
            fixed_expenses: Math.round(fixed_sum * 100) / 100,
            variable_expenses: Math.round(variable_sum * 100) / 100,
            projected_variable_expenses: Math.round(projected_variable * 100) / 100,
            projected_expenses: Math.round(projected_expenses * 100) / 100,
            subscription_total: Math.round(subscription_total * 100) / 100,
            savings_allocation: Math.round(savings_allocation * 100) / 100,
            current_net_pnl: Math.round(current_net_pnl * 100) / 100,
            forecasted_net_pnl: Math.round(forecasted_net_pnl * 100) / 100,
            // null below two months of history — the UI shows the point estimate alone
            // rather than an interval nobody can stand behind.
            forecast_low: fx.money(range.low),
            forecast_high: fx.money(range.high),
            safe_to_spend_per_day: fx.money(safe.per_day),
            safe_to_spend_headroom: fx.money(safe.headroom),
            days_left: safe.days_left,
            history_months: Math.max(incomeMonths, expenseMonths),
        });
    } catch (err) {
        console.error('getPnL error:', err);
        res.status(500).json({ error: 'Failed to calculate P&L' });
    }
};

exports.upsertBudget = async (req, res) => {
    const user_id = req.user.user_id;
    const { category_id, monthly_limit, carry_over } = req.body;
    if (!category_id || monthly_limit == null) {
        return res.status(400).json({ error: 'category_id and monthly_limit required' });
    }
    try {
        if (!await categoryAllowed(category_id, user_id)) return res.status(400).json({ error: 'Invalid category' });
        await db.query(
            `INSERT INTO budgets (user_id, category_id, monthly_limit, carry_over)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE monthly_limit = VALUES(monthly_limit), carry_over = VALUES(carry_over)`,
            [user_id, category_id, Number(monthly_limit), carry_over ? 1 : 0]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('upsertBudget error:', err);
        res.status(500).json({ error: 'Failed to save budget' });
    }
};

exports.addExpense = async (req, res) => {
    const user_id = req.user.user_id;
    const { amount, currency = 'ILS', description, category_id } = req.body;
    if (amount == null || isNaN(Number(amount)) || Number(amount) <= 0) return res.status(400).json({ error: 'Valid amount required' });
    try {
        if (!await categoryAllowed(category_id, user_id)) return res.status(400).json({ error: 'Invalid category' });
        const [result] = await db.query(
            'INSERT INTO expenses (user_id, amount, currency, description, category_id, source) VALUES (?, ?, ?, ?, ?, ?)',
            [user_id, Number(amount), currency, description?.trim() || null, category_id || null, 'web']
        );
        res.json({ expense_id: result.insertId });
    } catch (err) {
        console.error('addExpense error:', err);
        res.status(500).json({ error: 'Failed to add expense' });
    }
};

exports.updateExpense = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    const { amount, currency = 'ILS', description, category_id, source } = req.body;

    if (amount == null || isNaN(Number(amount)) || Number(amount) <= 0) {
        return res.status(400).json({ error: 'Valid amount required' });
    }

    try {
        if (!await categoryAllowed(category_id, user_id)) return res.status(400).json({ error: 'Invalid category' });
        const [result] = await db.query(
            'UPDATE expenses SET amount = ?, currency = ?, description = ?, category_id = ?, source = ? WHERE expense_id = ? AND user_id = ?',
            [Number(amount), currency, description?.trim() || null, category_id || null, source || 'web', id, user_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('updateExpense error:', err);
        res.status(500).json({ error: 'Failed to update expense' });
    }
};

exports.deleteExpense = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    try {
        const [result] = await db.query(
            'DELETE FROM expenses WHERE expense_id = ? AND user_id = ?',
            [id, user_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('deleteExpense error:', err);
        res.status(500).json({ error: 'Failed to delete expense' });
    }
};

exports.getCategories = async (req, res) => {
    const user_id = req.user.user_id;
    try {
        const [rows] = await db.query(
            'SELECT category_id, name, is_base FROM categories WHERE user_id IS NULL OR user_id = ? ORDER BY is_base DESC, name',
            [user_id]
        );
        res.json(rows);
    } catch (err) {
        console.error('getCategories error:', err);
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
};

exports.addCategory = async (req, res) => {
    const user_id = req.user.user_id;
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    try {
        const [existing] = await db.query(
            'SELECT 1 FROM categories WHERE (user_id IS NULL OR user_id = ?) AND LOWER(name) = LOWER(?) LIMIT 1',
            [user_id, name.trim()]
        );
        if (existing.length > 0) return res.status(400).json({ error: 'Category already exists' });
        const [result] = await db.query(
            'INSERT INTO categories (user_id, name, is_base) VALUES (?, ?, FALSE)',
            [user_id, name.trim()]
        );
        res.json({ category_id: result.insertId });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Category already exists' });
        console.error('addCategory error:', err);
        res.status(500).json({ error: 'Failed to add category' });
    }
};
