/**
 * Keeps the derived "commitments" tables in step with imported bank/card data:
 *   - installment_plans, rebuilt from imported card rows (pure logic: installments.js)
 *   - auto-detected subscriptions (pure logic: recurringDetector.js)
 *   - one-time repairs of rows imported under older, wrong rules
 *
 * Called after every categorization drain for the users it touched, and once at boot for
 * every user with a bank connection, so a deploy fills these in without waiting for the
 * next scrape.
 */
const crypto = require('crypto');
const db = require('../config/db');
const bankCompanies = require('../config/bankCompanies');
const { buildPlans } = require('./installments');
const { detectRecurring } = require('./recurringDetector');
const { ruleCategoryOf } = require('./categoryRules');
const { zonedParts } = require('../utils/zonedTime');

const CARD_COMPANIES = Object.entries(bankCompanies).filter(([, c]) => c.kind === 'card').map(([id]) => id);
const DETECTION_LOOKBACK_DAYS = 130; // a little over four months: three full ones plus slack

const pad2 = (n) => String(n).padStart(2, '0');
function isoOf(v) {
    if (v instanceof Date) return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
    return String(v).slice(0, 10);
}
function currentMonthKey(now = new Date()) {
    const p = zonedParts(now, 'Asia/Jerusalem');
    return `${p.year}-${pad2(p.month)}`;
}

/** Rebuilds one user's installment plans from their imported card rows. */
async function refreshInstallmentPlans(userId) {
    const [rows] = await db.query(
        `SELECT t.bank_connection_id, t.account_number, t.description, t.memo, t.txn_date,
                t.charged_amount, t.raw_json
         FROM bank_transactions_raw t
         JOIN bank_connections c ON c.id = t.bank_connection_id
         WHERE t.user_id = ? AND t.import_status = 'imported' AND t.status = 'completed'
           AND c.company_id IN (?)`,
        [userId, CARD_COMPANIES]
    );
    const plans = buildPlans((rows || []).map((r) => ({ ...r, txn_date: isoOf(r.txn_date) })));

    const hashes = [];
    for (const p of plans) {
        const hash = crypto.createHash('sha256').update(p.plan_key).digest('hex');
        hashes.push(hash);
        await db.query(
            `INSERT INTO installment_plans
               (user_id, plan_hash, merchant, monthly_amount, total_amount, total_payments,
                last_number, last_payment_date, next_payment_date, end_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE merchant = VALUES(merchant), monthly_amount = VALUES(monthly_amount),
               total_amount = VALUES(total_amount), total_payments = VALUES(total_payments),
               last_number = VALUES(last_number), last_payment_date = VALUES(last_payment_date),
               next_payment_date = VALUES(next_payment_date), end_date = VALUES(end_date)`,
            [userId, hash, p.merchant.slice(0, 255), p.monthly_amount, p.total_amount, p.total_payments,
                p.last_number, p.last_payment_date, p.next_payment_date, p.end_date]
        );
    }
    // A plan whose rows were all deleted (or whose identity changed) must not linger and
    // keep projecting payments.
    if (hashes.length) {
        await db.query('DELETE FROM installment_plans WHERE user_id = ? AND plan_hash NOT IN (?)', [userId, hashes]);
    } else {
        await db.query('DELETE FROM installment_plans WHERE user_id = ?', [userId]);
    }
    return plans.length;
}

/**
 * Inserts newly detected recurring expenses into `subscriptions` as auto-detected.
 * Never touches a row the user already has for the same payee — including one they
 * removed (active = FALSE), which is how "remove" stays removed.
 */
async function syncDetectedSubscriptions(userId, now = new Date()) {
    const since = new Date(now.getTime() - DETECTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    // Bank-sync rows only: hand-logged or bot-generated "[Subscription] …" rows would
    // otherwise detect the user's own subscriptions back into the list.
    const [rows] = await db.query(
        `SELECT e.description, e.amount, e.created_at, e.category_id, c.name AS category,
                JSON_EXTRACT(t.raw_json, '$.installments.total') AS inst_total
         FROM expenses e
         LEFT JOIN categories c ON c.category_id = e.category_id
         LEFT JOIN bank_transactions_raw t ON t.expense_id = e.expense_id
         WHERE e.user_id = ? AND e.source = 'bank_sync' AND e.is_virtual = FALSE
           AND e.amount > 0 AND e.created_at >= ?`,
        [userId, since]
    );
    const candidates = detectRecurring(
        (rows || []).map((r) => ({
            description: r.description,
            amount: Number(r.amount),
            date: isoOf(r.created_at),
            category: r.category,
            category_id: r.category_id,
            is_installment: Number(r.inst_total) > 1,
        })),
        currentMonthKey(now)
    );
    if (candidates.length === 0) return 0;

    const [existing] = await db.query(
        'SELECT name, match_key FROM subscriptions WHERE user_id = ?',
        [userId]
    );
    const keys = new Set((existing || []).map((s) => s.match_key).filter(Boolean));
    const names = new Set((existing || []).map((s) => String(s.name || '').trim().toLowerCase()));
    const categoryIdByName = new Map((rows || []).filter((r) => r.category).map((r) => [r.category, r.category_id]));

    let added = 0;
    for (const c of candidates) {
        if (keys.has(c.match_key) || names.has(c.name.toLowerCase())) continue;
        await db.query(
            `INSERT INTO subscriptions (user_id, name, amount, currency, category_id, day_of_month, auto_detected, match_key)
             VALUES (?, ?, ?, 'ILS', ?, ?, TRUE, ?)`,
            [userId, c.name, c.amount, categoryIdByName.get(c.category) ?? null, c.day_of_month, c.match_key]
        );
        added++;
    }
    if (added) console.log(`Recurring detection: ${added} new auto-detected subscription(s) for user ${userId}`);
    return added;
}

/**
 * Loan disbursements ("העמדת הלואה") used to be imported as income. A loan is not
 * earnings — it inflated that month's income and, through the decayed average, every
 * income forecast after it. Converts each such row into the negative expense the
 * classifier now produces (category Loans), keeping the staging link. Idempotent: a
 * converted row is no longer income, so a second pass finds nothing.
 */
const LOAN_DISBURSEMENT_SQL_LIKE = ['%העמדת הלואה%', '%העמדת הלוואה%'];
async function repairLoanDisbursements() {
    const [rows] = await db.query(
        `SELECT t.id AS raw_id, i.income_id, i.user_id, i.amount, i.currency, i.description, i.created_at
         FROM income i JOIN bank_transactions_raw t ON t.income_id = i.income_id
         WHERE t.description LIKE ? OR t.description LIKE ?`,
        LOAN_DISBURSEMENT_SQL_LIKE
    );
    if (!rows || rows.length === 0) return 0;
    const [[loansCat] = []] = await db.query(
        "SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Loans' LIMIT 1"
    );
    for (const r of rows) {
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            const [ins] = await conn.query(
                `INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
                 VALUES (?, ?, ?, ?, ?, 'bank_sync', ?)`,
                [r.user_id, -Number(r.amount), r.currency || 'ILS', r.description, loansCat?.category_id ?? null, r.created_at]
            );
            await conn.query('UPDATE bank_transactions_raw SET income_id = NULL, expense_id = ? WHERE id = ?', [ins.insertId, r.raw_id]);
            await conn.query('DELETE FROM income WHERE income_id = ?', [r.income_id]);
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            console.error(`repairLoanDisbursements: income ${r.income_id} not converted —`, err.message);
        } finally {
            conn.release();
        }
    }
    console.log(`repairLoanDisbursements: ${rows.length} loan disbursement(s) moved out of income`);
    return rows.length;
}

/**
 * Applies the deterministic rules to imported rows that are still UNCATEGORIZED — rows
 * imported before the rules existed (loan repayments, bank fees, Bit/PayBox, cash). Only
 * NULL categories are touched, so nothing a user chose by hand is ever overwritten.
 * Idempotent: a row it categorizes is no longer NULL.
 */
async function repairUncategorized() {
    const [rows] = await db.query(
        `SELECT expense_id, description FROM expenses
         WHERE source = 'bank_sync' AND category_id IS NULL AND is_virtual = FALSE`
    );
    if (!rows || rows.length === 0) return 0;
    const [cats] = await db.query('SELECT category_id, name FROM categories WHERE user_id IS NULL');
    const idByName = new Map((cats || []).map((c) => [c.name, c.category_id]));
    let fixed = 0;
    for (const r of rows) {
        const id = idByName.get(ruleCategoryOf(r.description));
        if (!id) continue;
        await db.query('UPDATE expenses SET category_id = ? WHERE expense_id = ? AND category_id IS NULL', [id, r.expense_id]);
        fixed++;
    }
    if (fixed) console.log(`repairUncategorized: ${fixed} imported expense(s) categorized by rule`);
    return fixed;
}

/** Refreshes everything derived for one user. Never throws — derived data must not break sync. */
async function refreshUser(userId) {
    try {
        await refreshInstallmentPlans(userId);
    } catch (err) {
        console.error(`refreshInstallmentPlans(${userId}) failed:`, err.message);
    }
    try {
        await syncDetectedSubscriptions(userId);
    } catch (err) {
        console.error(`syncDetectedSubscriptions(${userId}) failed:`, err.message);
    }
}

/** Boot pass: repairs, then every user with a bank connection. */
async function refreshAll() {
    try {
        await repairLoanDisbursements();
    } catch (err) {
        console.error('repairLoanDisbursements failed:', err.message);
    }
    try {
        await repairUncategorized();
    } catch (err) {
        console.error('repairUncategorized failed:', err.message);
    }
    try {
        const [users] = await db.query('SELECT DISTINCT user_id FROM bank_connections');
        for (const { user_id } of users || []) await refreshUser(user_id);
    } catch (err) {
        console.error('commitments.refreshAll failed:', err.message);
    }
}

module.exports = {
    refreshInstallmentPlans,
    syncDetectedSubscriptions,
    repairLoanDisbursements,
    repairUncategorized,
    refreshUser,
    refreshAll,
};
