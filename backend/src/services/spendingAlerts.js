const db = require('../config/db');
const cy = require('./cycle');
const fx = require('./forecastMath');
const expenseController = require('../controllers/expenseController');
const { zonedParts } = require('../utils/zonedTime');

/**
 * Proactive financial alerts for the external AI agent.
 *
 * The rules run HERE, in the backend, rather than in the agent, for two reasons that are
 * not interchangeable:
 *
 *   1. Two of them cannot be computed from the agent API at all. The stale-data rule reads
 *      bank_connections and the duplicate rule compares raw expense rows; the PRIVACY RULE
 *      in controllers/agentController.js forbids exposing either to the agent.
 *   2. Every rule is a numeric comparison. Running them on a timer costs nothing, while
 *      asking a model to re-derive them on every poll costs money and invents thresholds.
 *
 * The tick writes what fired to alert_log. GET /api/agent/alerts only reads that table, so
 * the agent API stays read-only even though alerting is inherently stateful.
 *
 * Severity decides what the agent interrupts the user for, not whether a rule is stored:
 * everything that fires is written, and the agent filters.
 */

const TIME_ZONE = 'Asia/Jerusalem';
const TICK_MS = 30 * 60 * 1000;

/**
 * Thresholds. These are deliberately conservative: a false positive teaches the user to
 * ignore alerts, and an ignored channel is worth less than no channel at all.
 */
// Spending may outrun the elapsed share of the cycle by this much before it is "ahead".
// 1.0 would fire for anyone whose rent lands on day one, which is almost everyone.
const PACE_FACTOR = 1.15;
// Before this day of the cycle the elapsed share is too small to be a stable denominator.
const PACE_MIN_CYCLE_DAY = 7;
const BURST_WINDOW_DAYS = 3;
// A burst is this many times what those days would normally cost.
const BURST_FACTOR = 2.5;
// A single charge is unusual at this multiple of the user's own recent average...
const UNUSUAL_FACTOR = 3;
// ...but never below this, or every small anomaly on a quiet week becomes an alert.
const UNUSUAL_FLOOR_ILS = 200;
// Days after the expected salary day before its absence is worth raising.
const SALARY_GRACE_DAYS = 2;
// A surplus is only actionable while there is still a cycle left to act in.
const SURPLUS_DAYS_LEFT = 4;
const SURPLUS_MIN_ILS = 300;
// A sync that last succeeded longer ago than this is stale even if nothing reported an error.
const SYNC_STALE_HOURS = 48;
const DUPLICATE_WINDOW_DAYS = 3;

const SEVERITY = { critical: 0, high: 1, normal: 2 };

/** Runs an Express handler and resolves with what it would have sent. */
function run(handler, req, query = {}) {
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) {
                if (this.statusCode >= 400) {
                    const err = new Error(body?.error || 'Internal request failed');
                    err.status = this.statusCode;
                    reject(err);
                } else resolve(body);
            },
        };
        Promise.resolve(handler({ user: req.user, cycleSettings: req.cycleSettings, query, params: {}, body: {} }, res)).catch(reject);
    });
}

const pad2 = (n) => String(n).padStart(2, '0');

/** The user's calendar date. Containers run on UTC, so a 00:30 purchase in Israel would
 *  otherwise be dated to the previous day. */
function localDate(d, now = new Date()) {
    const p = zonedParts(d instanceof Date ? d : new Date(d), TIME_ZONE);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}


/** The money numbers every rule shares, fetched once per user per tick. */
async function buildContext(user, now) {
    const req = {
        user: { user_id: user.user_id },
        cycleSettings: { cycle_anchor_day: user.cycle_anchor_day, salary_day: user.salary_day },
    };
    const settings = cy.normalizeSettings(req.cycleSettings);
    const cycleKey = cy.currentCycleKey(settings);
    const cycle = cy.resolveCycle(cycleKey, settings);
    const today = localDate(now);

    // Every figure comes from the dashboard's own controller, so an alert can never quote a
    // number the user cannot find in the app.
    const pnl = await run(expenseController.getPnL, req, { month: cycleKey });

    // One window wide enough for the burst, duplicate and unusual-charge rules together.
    const lookbackDays = Math.max(BURST_WINDOW_DAYS, DUPLICATE_WINDOW_DAYS, 7);
    const [recent] = await db.query(
        `SELECT e.expense_id, e.amount, e.description, e.created_at,
                COALESCE(c.is_fixed, FALSE) AS is_fixed, c.name AS category
         FROM expenses e
         LEFT JOIN categories c ON e.category_id = c.category_id
         WHERE e.user_id = ? AND e.is_virtual = FALSE AND e.created_at >= ?
         ORDER BY e.created_at DESC`,
        [user.user_id, cy.addDays(today, -lookbackDays)]
    );

    // Aggregate only. Never a bank name, an account id, or a row count the user could map
    // back to a specific connection: the agent must not learn that bank links exist.
    const [[sync]] = await db.query(
        `SELECT COUNT(*) AS connections,
                SUM(status = 'error') AS failing,
                MAX(last_sync_at) AS last_ok
         FROM bank_connections WHERE user_id = ?`,
        [user.user_id]
    );

    return { user, req, settings, cycleKey, cycle, today, now, pnl, recent: recent || [], sync: sync || {} };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Each rule returns an alert or null. They are listed in the order a human would want to
 * hear them, and every one carries the numbers behind its own verdict so the agent phrases
 * the alert instead of recomputing it.
 */
const RULES = [
    // 1. Nothing else on this list can be trusted while the data is stale. Without this
    //    rule, silence is ambiguous: it means either "all clear" or "nothing is arriving".
    function dataStale(ctx) {
        const connections = num(ctx.sync.connections);
        if (connections === 0) return null;
        const failing = num(ctx.sync.failing);
        const lastOk = ctx.sync.last_ok ? new Date(ctx.sync.last_ok) : null;
        const hoursSince = lastOk ? (ctx.now - lastOk) / 36e5 : Infinity;
        if (failing === 0 && hoursSince < SYNC_STALE_HOURS) return null;
        return {
            rule: 'data_stale',
            severity: 'critical',
            dedupe_key: ctx.today,
            payload: {
                healthy: false,
                last_successful_sync: lastOk ? localDate(lastOk) : null,
                hours_since_last_sync: Number.isFinite(hoursSince) ? Math.floor(hoursSince) : null,
            },
        };
    },

    // 2. The absence of expected income is worth more than its arrival, and it is the one
    //    thing the user cannot notice by looking at a balance that simply did not change.
    function salaryMissing(ctx) {
        const { pnl, cycle, settings } = ctx;
        if (num(pnl.total_income_actual) > 0) return null;
        const due = cy.chargeDateInCycle(cycle, settings.salaryDay);
        if (ctx.today < cy.addDays(due, SALARY_GRACE_DAYS)) return null;
        return {
            rule: 'salary_missing',
            severity: 'critical',
            dedupe_key: ctx.cycleKey,
            payload: {
                expected_on: due,
                days_late: Math.round((new Date(ctx.today) - new Date(due)) / 864e5),
                income_expected: fx.money(num(pnl.total_income_projected)),
            },
        };
    },

    // 3. The cycle is already committed past its income.
    function negativeForecast(ctx) {
        const net = num(ctx.pnl.forecasted_net_pnl);
        if (net >= 0) return null;
        const daysLeft = num(ctx.pnl.days_left);
        return {
            rule: 'negative_forecast',
            severity: 'critical',
            dedupe_key: ctx.cycleKey,
            payload: {
                net_forecast: fx.money(net),
                days_left: daysLeft,
                // What it takes to come back to zero, which is the only actionable part.
                daily_cut_needed: daysLeft > 0 ? fx.money(Math.abs(net) / daysLeft) : null,
            },
        };
    },

    // 4. Salary landed: the one moment in the cycle where a single decision shapes the rest.
    function salaryArrived(ctx) {
        const received = num(ctx.pnl.total_income_actual);
        if (received <= 0) return null;
        return {
            rule: 'salary_arrived',
            severity: 'normal',
            dedupe_key: ctx.cycleKey,
            payload: {
                income_received: fx.money(received),
                subscriptions_ahead: fx.money(num(ctx.pnl.subscription_total)),
                headroom: fx.money(num(ctx.pnl.safe_to_spend_headroom)),
                daily_allowance: fx.money(num(ctx.pnl.safe_to_spend_per_day)),
            },
        };
    },

    // 5. "It is mid-cycle and more than half the salary is gone." Compared against the
    //    elapsed share rather than a flat half, so it works for any cycle length.
    function paceAhead(ctx) {
        const { pnl } = ctx;
        const cycleDay = num(pnl.cycle_day);
        const daysInCycle = num(pnl.days_in_cycle);
        if (cycleDay < PACE_MIN_CYCLE_DAY || daysInCycle <= 0) return null;
        const income = num(pnl.total_income_projected);
        if (income <= 0) return null;
        const elapsedShare = cycleDay / daysInCycle;
        const spentShare = num(pnl.total_expenses) / income;
        if (spentShare <= elapsedShare * PACE_FACTOR) return null;
        return {
            rule: 'pace_ahead',
            severity: 'high',
            dedupe_key: ctx.cycleKey,
            payload: {
                spent: fx.money(num(pnl.total_expenses)),
                income_expected: fx.money(income),
                spent_pct: Math.round(spentShare * 100),
                cycle_elapsed_pct: Math.round(elapsedShare * 100),
                days_left: num(pnl.days_left),
            },
        };
    },

    // 6. A short, sharp run of spending that the cycle-long pace rule would average away.
    function spendingBurst(ctx) {
        const { pnl } = ctx;
        const daysInCycle = num(pnl.days_in_cycle);
        if (daysInCycle <= 0) return null;
        const expectedDaily = num(pnl.projected_expenses) / daysInCycle;
        if (expectedDaily <= 0) return null;
        const since = cy.addDays(ctx.today, -BURST_WINDOW_DAYS);
        const rows = ctx.recent.filter((r) => !r.is_fixed && localDate(r.created_at) > since);
        const total = rows.reduce((s, r) => s + num(r.amount), 0);
        const expected = expectedDaily * BURST_WINDOW_DAYS;
        if (total <= expected * BURST_FACTOR) return null;
        return {
            rule: 'spending_burst',
            severity: 'high',
            dedupe_key: ctx.today,
            payload: {
                window_days: BURST_WINDOW_DAYS,
                spent_in_window: fx.money(total),
                normal_for_window: fx.money(expected),
                times_normal: Math.round((total / expected) * 10) / 10,
                charges: rows.length,
            },
        };
    },

    // 7. The same amount and description twice inside a few days. duplicateMatcher owns the
    //    cleanup flow; this only raises the question, and never deletes anything.
    function duplicateCharge(ctx) {
        const seen = new Map();
        for (const row of [...ctx.recent].reverse()) {
            const key = `${num(row.amount).toFixed(2)}|${(row.description || '').trim().toLowerCase()}`;
            const prev = seen.get(key);
            const day = localDate(row.created_at);
            if (prev && (new Date(day) - new Date(prev.day)) / 864e5 <= DUPLICATE_WINDOW_DAYS) {
                return {
                    rule: 'duplicate_charge',
                    severity: 'high',
                    dedupe_key: `expense:${row.expense_id}`,
                    payload: {
                        amount: fx.money(num(row.amount)),
                        description: row.description,
                        category: row.category || 'Uncategorized',
                        first_seen: prev.day,
                        charged_again: day,
                    },
                };
            }
            seen.set(key, { day });
        }
        return null;
    },

    // 8. One charge far outside what this user normally spends, judged against their own
    //    recent charges so it never fires on someone whose ordinary purchases are large.
    //
    //    The baseline is the MEDIAN of the other charges, not the mean of all of them. A
    //    mean that includes the candidate is pulled up by it, so the bigger the charge the
    //    harder it becomes to flag — the rule would hide exactly the case it exists for.
    //    A median also survives one outlier in a quiet week, which a mean does not.
    function unusualExpense(ctx) {
        const variable = ctx.recent.filter((r) => !r.is_fixed);
        if (variable.length < 4) return null; // 3 others plus the candidate.

        const median = (nums) => {
            if (!nums.length) return 0;
            const sorted = [...nums].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        };

        const yesterday = cy.addDays(ctx.today, -1);
        // Largest first: if several qualify, the one worth raising is the biggest.
        const candidates = variable
            .filter((r) => localDate(r.created_at) >= yesterday)
            .sort((a, b) => num(b.amount) - num(a.amount));

        for (const hit of candidates) {
            const others = variable.filter((r) => r.expense_id !== hit.expense_id).map((r) => num(r.amount));
            if (others.length < 3) continue;
            const typical = median(others);
            const threshold = Math.max(UNUSUAL_FLOOR_ILS, typical * UNUSUAL_FACTOR);
            if (num(hit.amount) < threshold) continue;
            return {
                rule: 'unusual_expense',
                severity: 'normal',
                dedupe_key: `expense:${hit.expense_id}`,
                payload: {
                    amount: fx.money(num(hit.amount)),
                    description: hit.description,
                    category: hit.category || 'Uncategorized',
                    // The rule only looks at the last day, but a morning check still has to
                    // be able to say "yesterday" rather than leaving the user to guess.
                    date: localDate(hit.created_at),
                    your_typical_charge: fx.money(typical),
                    times_typical: typical > 0 ? Math.round((num(hit.amount) / typical) * 10) / 10 : null,
                },
            };
        }
        return null;
    },

    // 9. The only rule that is an opportunity rather than a warning. A system that only ever
    //    warns gets read as nagging, and then stops being read.
    function cycleSurplus(ctx) {
        const { pnl } = ctx;
        const daysLeft = num(pnl.days_left);
        const net = num(pnl.forecasted_net_pnl);
        if (daysLeft > SURPLUS_DAYS_LEFT || daysLeft < 0) return null;
        if (net < SURPLUS_MIN_ILS) return null;
        return {
            rule: 'cycle_surplus',
            severity: 'normal',
            dedupe_key: ctx.cycleKey,
            payload: {
                net_forecast: fx.money(net),
                days_left: daysLeft,
                savings_set_aside: fx.money(num(pnl.savings_allocation)),
            },
        };
    },
];

/** Every rule that fires, worst first. One bad rule must not silence the rest. */
function evaluate(ctx) {
    const fired = [];
    for (const rule of RULES) {
        try {
            const alert = rule(ctx);
            if (alert) fired.push(alert);
        } catch (err) {
            console.error(`Alert rule ${rule.name} failed for user ${ctx.user.user_id}:`, err.message);
        }
    }
    return fired.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
}

/** INSERT IGNORE is the cooldown: the UNIQUE key rejects an occurrence already recorded. */
async function record(userId, cycleKey, alert) {
    const [res] = await db.query(
        `INSERT IGNORE INTO alert_log (user_id, rule, severity, dedupe_key, cycle_key, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, alert.rule, alert.severity, alert.dedupe_key, cycleKey, JSON.stringify(alert.payload)]
    );
    return res && res.affectedRows > 0;
}

let running = false;

async function runSpendingAlerts(now = new Date()) {
    if (running) return 0;
    running = true;
    let written = 0;
    try {
        const [users] = await db.query('SELECT user_id, cycle_anchor_day, salary_day FROM users');
        for (const user of users || []) {
            // One user's bad data must not cost everyone after them their alerts.
            try {
                const ctx = await buildContext(user, now);
                for (const alert of evaluate(ctx)) {
                    if (await record(user.user_id, ctx.cycleKey, alert)) written += 1;
                }
            } catch (err) {
                console.error(`Spending alerts error for user ${user.user_id}:`, err.message);
            }
        }
    } finally {
        running = false;
    }
    return written;
}

function start() {
    setInterval(() => {
        runSpendingAlerts().catch((err) => console.error('Spending alerts run error:', err));
    }, TICK_MS).unref();
}

module.exports = {
    start,
    runSpendingAlerts,
    buildContext,
    evaluate,
    RULES,
    TICK_MS,
    SEVERITY,
};
