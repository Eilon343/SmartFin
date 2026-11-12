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
// Everyday spending may run this far ahead of the user's usual pace before it is "ahead".
// Measured against the usual spend, 1.15 fired on a mere 20% over -- inside ordinary
// week-to-week swing (one big grocery run moves a week by that much). It was set when the
// yardstick was the cycle's own projection, which damped every reading toward the line and
// made 1.15 behave like 1.5x-3x. 1.3: half again the usual pace fires, a fifth over does not.
const PACE_FACTOR = 1.3;
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

// Income this far below what the cycle expects is not the salary: a refund must not
// consume the once-per-cycle slot and leave the real arrival unannounced.
const SALARY_ARRIVED_SHARE = 0.5;
// Before this day a forecast is mostly prior, and calling a cycle doomed on day one is the
// fastest way to lose the user's trust in the forecast.
const FORECAST_MIN_CYCLE_DAY = 3;
// A forecast is an estimate, not a measurement, so a shortfall smaller than this is inside
// its own error bars. Calling a 27-agora gap "critical" spends the user's attention on noise
// and teaches them that critical does not mean critical.
const FORECAST_MIN_SHORTFALL_ILS = 100;
// Below this, a repeated charge is far more likely to be a daily habit at a fixed price
// (the same coffee, the same bus fare) than a double charge.
const DUPLICATE_MIN_ILS = 50;

const SEVERITY = { critical: 0, high: 1, normal: 2 };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * The user's usual everyday spend for a whole cycle: the decayed mean of past cycles'
 * variable spending, which getPnL returns as variable_expense_avg.
 *
 * Pace and burst measure against THIS. Two yardsticks were tried and rejected:
 *
 *   - Total spending. Rent lands in one lump early in the cycle, so a total-based pace reads
 *     "40% of the month gone, 60% of the money gone" for anyone whose rent clears on day one.
 *   - The cycle's projected variable spend. The projection is built FROM this cycle's
 *     spending (S + w*run-rate + (1-w)*habit), so the yardstick grew with the very thing it
 *     measured: on day 15, spending at twice the usual pace read 56% against a 57%
 *     threshold, and by day 20 even triple the pace stayed silent. It also subtracted the
 *     subscriptions, which were never part of it.
 *
 * Past cycles only, so nothing the user spends now can move it.
 */
function usualEveryday(pnl) {
    return num(pnl.variable_expense_avg);
}
// One odd cycle is not a habit. Below this much history "faster than usual" means nothing.
const PACE_MIN_HISTORY_MONTHS = 2;

/**
 * What this cycle's income is expected to be IN FULL: fixed income plus the user's own
 * decayed average of variable income.
 *
 * Not total_income_projected. That is `received + historicalMean * remainingShare`, a
 * forecast of what is still to come, so it shrinks as the cycle elapses. Bank sync imports
 * a salary as variable income, so for a synced user it is exactly that shrinking term.
 * Measured against it, the salary rules got looser the longer a salary was missing -- late
 * in a cycle a stray refund could pass for "arrived" -- and salary_missing quoted a prorated
 * figure: ₪15,242 on day 12 for a salary averaging over ₪25,000.
 */
function expectedIncome(pnl) {
    return num(pnl.fixed_income) + num(pnl.variable_income_avg);
}

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
         WHERE e.user_id = ? AND e.is_virtual = FALSE
               AND e.created_at >= ? AND e.created_at < ?
         ORDER BY e.created_at DESC`,
        // The upper bound is not cosmetic. An imported installment payment is dated to the
        // month it belongs to, and the scraper returns some of them ahead of time. Without
        // the bound the burst, duplicate and unusual-charge rules all treated money not yet
        // spent as "just spent", and the agent reported a charge that had not happened.
        [user.user_id, cy.addDays(today, -lookbackDays), cy.addDays(today, 1)]
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
        // Never synced is NEW, not stale. A first sync that fails flips status to 'error',
        // which the failing check already catches; treating "no success yet" as stale would
        // fire on every freshly added connection before it has had a chance to run.
        const hoursSince = lastOk ? (ctx.now - lastOk) / 36e5 : null;
        if (failing === 0 && (hoursSince === null || hoursSince < SYNC_STALE_HOURS)) return null;
        return {
            rule: 'data_stale',
            severity: 'critical',
            dedupe_key: ctx.today,
            payload: {
                healthy: false,
                last_successful_sync: lastOk ? localDate(lastOk) : null,
                hours_since_last_sync: hoursSince === null ? null : Math.floor(hoursSince),
            },
        };
    },

    // 2. The absence of expected income is worth more than its arrival, and it is the one
    //    thing the user cannot notice by looking at a balance that simply did not change.
    function salaryMissing(ctx) {
        const { pnl, cycle, settings } = ctx;
        const expected = expectedIncome(pnl);
        // Someone who does not track income has no salary to miss; without this the rule
        // would fire every cycle, forever, for every such user.
        if (expected <= 0) return null;
        // A partial payment still counts as arrived. Only a near-empty cycle is "missing".
        if (num(pnl.total_income_actual) >= expected * SALARY_ARRIVED_SHARE) return null;
        const due = cy.chargeDateInCycle(cycle, settings.salaryDay);
        if (ctx.today < cy.addDays(due, SALARY_GRACE_DAYS)) return null;
        return {
            rule: 'salary_missing',
            severity: 'critical',
            dedupe_key: ctx.cycleKey,
            payload: {
                expected_on: due,
                days_late: Math.round((new Date(ctx.today) - new Date(due)) / 864e5),
                income_expected: fx.money(expectedIncome(pnl)),
            },
        };
    },

    // 3. The cycle is already committed past its income.
    function negativeForecast(ctx) {
        const net = num(ctx.pnl.forecasted_net_pnl);
        if (net > -FORECAST_MIN_SHORTFALL_ILS) return null;
        if (num(ctx.pnl.cycle_day) < FORECAST_MIN_CYCLE_DAY) return null;
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
        const expected = expectedIncome(ctx.pnl);
        const received = num(ctx.pnl.total_income_actual);
        if (expected <= 0 || received < expected * SALARY_ARRIVED_SHARE) return null;
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

    // 5. Everyday spending is running ahead of the user's own usual pace: more of a usual
    //    cycle's spending already gone than the share of the cycle that has passed.
    //    Whether the money will run out is negative_forecast's question; this one is about
    //    behaviour, and it is the one that can still be acted on early.
    function paceAhead(ctx) {
        const { pnl } = ctx;
        const cycleDay = num(pnl.cycle_day);
        const daysInCycle = num(pnl.days_in_cycle);
        if (cycleDay < PACE_MIN_CYCLE_DAY || daysInCycle <= 0) return null;
        if (num(pnl.history_months) < PACE_MIN_HISTORY_MONTHS) return null;
        const usual = usualEveryday(pnl);
        if (usual <= 0) return null;
        const elapsedShare = cycleDay / daysInCycle;
        // Spent SO FAR, against time elapsed so far. Both sides must stop at today, which
        // getPnL's actuals now do on their own: its expense window ends at today and moves
        // dated future charges into commitments_ahead.
        const spentToDate = num(pnl.variable_expenses);
        const spentShare = spentToDate / usual;
        if (spentShare <= elapsedShare * PACE_FACTOR) return null;
        return {
            rule: 'pace_ahead',
            severity: 'high',
            dedupe_key: ctx.cycleKey,
            payload: {
                // To date, like everyday_spent. The agent is told every number it quotes comes
                // from the API, so two figures that both read as "spent" must count one period.
                spent: fx.money(num(pnl.total_expenses)),
                income_expected: fx.money(expectedIncome(pnl)),
                // The decision is made on everyday money only; these two are what it used.
                everyday_spent: fx.money(spentToDate),
                usual_everyday: fx.money(usual),
                // Share of a usual cycle's everyday spending already gone.
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
        if (num(pnl.history_months) < PACE_MIN_HISTORY_MONTHS) return null;
        const expectedDaily = usualEveryday(pnl) / daysInCycle;
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
            if (num(row.amount) < DUPLICATE_MIN_ILS) continue;
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
        // Only users who can actually receive an alert. The agent API is the single delivery
        // channel -- there is no push, no mail, no bot -- so for a user with no live key an
        // alert is a row nobody will ever read, and the rules still cost a full P&L each to
        // reach it. A key issued later simply starts alerting from that tick; nothing is
        // backfilled, and nothing about a cycle already in progress is lost.
        const [users] = await db.query(
            `SELECT DISTINCT u.user_id, u.cycle_anchor_day, u.salary_day
             FROM users u
             JOIN agent_api_keys k ON k.user_id = u.user_id AND k.revoked_at IS NULL`
        );
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
