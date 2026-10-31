const db = require('../config/db');
const fx = require('./forecastMath');
const cy = require('./cycle');
const { zonedParts, instantAtLocalHour } = require('../utils/zonedTime');
const { notifyUser } = require('../utils/telegram');
const { formatWeeklyMessage, formatNoHistoryMessage } = require('./weeklyScoreMessage');

/**
 * The Sunday-morning summary of the week that just closed.
 *
 * It used to run on Saturday morning, so a week still in progress was compared against a full
 * week's expectation, and Saturday's later spending reached no message at all. Sunday 08:30
 * is after the 07:00 bank sync, and a closed week has nothing left to scale.
 *
 * It lives here rather than in the bot so it can share forecastMath and the cycle resolver
 * with Insights instead of carrying a third hand-kept copy of the baseline.
 */

const TIME_ZONE = 'Asia/Jerusalem';
const SEND_DAY = 0; // Sunday
const SEND_HOUR = 8;
const SEND_MINUTE = 30;
const TICK_MS = 15 * 60 * 1000;

/** A chat that blocked the bot fails forever; three tries is enough to rule out a blip. */
const MAX_SEND_ATTEMPTS = 3;

/**
 * The week to report, or null when it is not yet time to send.
 *
 * `start` and `end` are Israel-local midnights. Bank rows store a bare date, which reads as
 * 00:00 UTC, and that still lands in the right week: a Sunday's row is 2-3 hours after the
 * local midnight that opened the week.
 */
function weekWindow(now) {
    const local = zonedParts(now, TIME_ZONE);
    const pad = (n) => String(n).padStart(2, '0');
    const todayISO = `${local.year}-${pad(local.month)}-${pad(local.day)}`;

    if (new Date(`${todayISO}T00:00:00Z`).getUTCDay() !== SEND_DAY) return null;
    if (local.hour * 60 + local.minute < SEND_HOUR * 60 + SEND_MINUTE) return null;

    const weekKey = cy.addDays(todayISO, -7);
    const [year, month, day] = weekKey.split('-').map(Number);
    return {
        start: instantAtLocalHour({ year, month, day }, 0, TIME_ZONE),
        end: instantAtLocalHour(local, 0, TIME_ZONE),
        weekKey,
        lastDayISO: cy.addDays(todayISO, -1),
    };
}

/** created_at is compared in the DB's UTC, whatever timezone this process runs in. */
const utcSql = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

function fetchUserRows(user, window, cycle, lookbackStart, shift) {
    const { user_id } = user;
    return Promise.all([
        db.query(
            `SELECT category_id, name, COALESCE(is_fixed, FALSE) AS is_fixed
             FROM categories WHERE user_id IS NULL OR user_id = ?`,
            [user_id]
        ),
        db.query(
            `SELECT category_id,
                    DATE_FORMAT(DATE_SUB(created_at, INTERVAL ? DAY), '%Y-%m') AS mo,
                    COALESCE(SUM(amount), 0) AS total,
                    MIN(created_at) AS first_at
             FROM expenses
             WHERE user_id = ?
               AND is_virtual = FALSE
               AND created_at >= ?
               AND created_at < ?
             GROUP BY category_id, mo`,
            [shift, user_id, lookbackStart, cycle.start]
        ),
        db.query(
            `SELECT category_id, COALESCE(SUM(monthly_limit), 0) AS monthly_limit
             FROM budgets WHERE user_id = ? GROUP BY category_id`,
            [user_id]
        ),
        // Everyday spending only. A rent charge lands in one week, so counting it graded
        // the calendar rather than the user.
        db.query(
            `SELECT e.category_id, c.name, COALESCE(SUM(e.amount), 0) AS total
             FROM expenses e LEFT JOIN categories c ON e.category_id = c.category_id
             WHERE e.user_id = ?
               AND e.is_virtual = FALSE AND COALESCE(c.is_fixed, FALSE) = FALSE
               AND e.created_at >= ? AND e.created_at < ?
             GROUP BY e.category_id, c.name`,
            [user_id, utcSql(window.start), utcSql(window.end)]
        ),
        // Approximate by design. A pending charge that settled under a different amount or
        // date is a new row, so its old pending row can linger; the message says "About".
        db.query(
            `SELECT COALESCE(SUM(-charged_amount), 0) AS total
             FROM bank_transactions_raw
             WHERE user_id = ?
               AND status = 'pending' AND import_status = 'pending_categorization'
               AND charged_amount < 0 AND currency = 'ILS'
               AND txn_date >= ? AND txn_date < ?`,
            [user_id, window.weekKey, cy.addDays(window.lastDayISO, 1)]
        ),
    ]);
}

/**
 * With no usable history, a budget is the only expectation there is, so it has to cover
 * everything being measured. Otherwise one budgeted category would become the target for
 * all of the week's spending and report a false overspend.
 */
function budgetsCoverSpending(weekRows, budgets) {
    return weekRows
        .filter((r) => r.total > 0)
        .every((r) => r.category_id != null && budgets[r.category_id] !== undefined);
}

/** The message for one user. Throws if a query fails; the caller owns retrying. */
async function buildUserScore(user, window) {
    const settings = { cycle_anchor_day: user.cycle_anchor_day, salary_day: user.salary_day };
    const [y, m, d] = window.lastDayISO.split('-').map(Number);
    const cycleKey = cy.cycleKeyOfDate(new Date(y, m - 1, d), settings);
    const cycle = cy.resolveCycle(cycleKey, settings);
    const lookback = fx.pastMonths(cycleKey, fx.LOOKBACK_MONTHS);
    const lookbackStart = cy.cycleStart(lookback[lookback.length - 1], settings);

    const [[categories], [buckets], [budgetRows], [weekRowsRaw], [pendingRows]] =
        await fetchUserRows(user, window, cycle, lookbackStart, cy.anchorShiftDays(settings));

    const { byCategory: habits, months } = fx.categoryHabits(buckets, {
        anchorMonth: cycleKey,
        cycleEndOf: (key) => cy.resolveCycle(key, settings).end,
    });

    const budgets = {};
    for (const r of budgetRows) budgets[r.category_id] = Number(r.monthly_limit);
    const weekRows = weekRowsRaw.map((r) => ({ ...r, total: Number(r.total) }));

    if (months.length === 0 && !budgetsCoverSpending(weekRows, budgets)) {
        return formatNoHistoryMessage();
    }

    const pacing = fx.pacingTarget([
        ...categories.map((c) => ({
            is_fixed: !!c.is_fixed,
            three_mo_avg: habits.get(c.category_id) || 0,
            budget_limit: budgets[c.category_id] !== undefined ? budgets[c.category_id] : null,
        })),
        { is_fixed: false, three_mo_avg: habits.get(null) || 0, budget_limit: null },
    ]);

    const score = fx.weeklyScore({
        weekTotal: weekRows.reduce((sum, r) => sum + r.total, 0),
        monthlyTarget: pacing.variable,
        cycleDays: cycle.days,
    });
    if (!score) return formatNoHistoryMessage();

    return formatWeeklyMessage({
        score,
        weekStart: window.weekKey,
        weekEnd: window.lastDayISO,
        basis: pacing.budgeted_variable_categories > 0 ? 'target' : 'usual',
        topCategories: weekRows
            .filter((r) => r.total > 0)
            .sort((a, b) => b.total - a.total)
            .slice(0, 3)
            .map((r) => ({ name: r.name || 'Uncategorized', total: r.total })),
        pendingTotal: Number(pendingRows[0].total),
    });
}

const attempts = new Map(); // `${weekKey}:${user_id}` → failed sends this week
let running = false;

const markSent = (weekKey, userId) =>
    db.query('UPDATE users SET weekly_score_sent_for = ? WHERE user_id = ?', [weekKey, userId]);

/** Counts a failed try; after the last one, stops retrying this user for this week. */
async function recordFailure(window, user, reason) {
    const key = `${window.weekKey}:${user.user_id}`;
    const failed = (attempts.get(key) || 0) + 1;
    attempts.set(key, failed);
    if (failed < MAX_SEND_ATTEMPTS) return;
    console.error(`Weekly score: giving up on user ${user.user_id} for ${window.weekKey}: ${reason}`);
    attempts.delete(key);
    await markSent(window.weekKey, user.user_id);
}

async function runWeeklyScores(now = new Date()) {
    const window = weekWindow(now);
    if (!window || running) return;

    running = true;
    try {
        const [users] = await db.query(
            `SELECT user_id, telegram_chat_id, cycle_anchor_day, salary_day FROM users
             WHERE telegram_chat_id IS NOT NULL
               AND (weekly_score_sent_for IS NULL OR weekly_score_sent_for < ?)`,
            [window.weekKey]
        );
        for (const user of users) {
            // One user's bad data must not cost everyone after them their summary.
            try {
                const text = await buildUserScore(user, window);
                if (await notifyUser(user.telegram_chat_id, text)) {
                    await markSent(window.weekKey, user.user_id);
                } else {
                    await recordFailure(window, user, 'send failed');
                }
            } catch (err) {
                console.error(`Weekly score error for user ${user.user_id}:`, err);
                await recordFailure(window, user, err.message).catch(() => {});
            }
        }
    } finally {
        running = false;
    }
}

function start() {
    setInterval(() => {
        runWeeklyScores().catch((err) => console.error('Weekly score run error:', err));
    }, TICK_MS).unref();
}

module.exports = { MAX_SEND_ATTEMPTS, weekWindow, buildUserScore, runWeeklyScores, start };
