const db = require('../config/db');
const inst = require('../services/installments');
const loansController = require('./loansController');

// Committed monthly outflow: subscriptions, card installments, loan repayments.
// Reads only installment_plans / subscriptions / loans — never a bank_* table — so the
// agent API can reuse every function here under its privacy rule.

const money = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);
const pad2 = (n) => String(n).padStart(2, '0');
const iso = (v) => (v instanceof Date
    ? `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`
    : (v == null ? null : String(v).slice(0, 10)));

async function loadInstallmentPlans(userId) {
    const [rows] = await db.query(
        `SELECT plan_id, merchant, monthly_amount, total_amount, total_payments, last_number,
                last_payment_date, next_payment_date, end_date
         FROM installment_plans WHERE user_id = ? ORDER BY end_date DESC`,
        [userId]
    );
    return (rows || []).map((r) => {
        const remaining = Number(r.total_payments) - Number(r.last_number);
        return {
            plan_id: r.plan_id,
            merchant: r.merchant,
            monthly_amount: money(r.monthly_amount),
            total_amount: money(r.total_amount),
            total_payments: Number(r.total_payments),
            payments_made: Number(r.last_number),
            remaining_payments: remaining,
            remaining_amount: money(Number(r.monthly_amount) * remaining),
            next_payment_date: remaining > 0 ? iso(r.next_payment_date) : null,
            end_date: iso(r.end_date),
            last_payment_date: iso(r.last_payment_date),
            active: remaining > 0,
        };
    });
}

function summarizeInstallments(plans) {
    const active = plans.filter((p) => p.active);
    return {
        active_count: active.length,
        monthly_commitment: money(active.reduce((s, p) => s + p.monthly_amount, 0)),
        remaining_total: money(active.reduce((s, p) => s + p.remaining_amount, 0)),
    };
}

async function loadActiveSubscriptions(userId) {
    const [rows] = await db.query(
        `SELECT s.subscription_id, s.name, s.amount, s.day_of_month, s.auto_detected, s.confirmed_at,
                c.name AS category
         FROM subscriptions s LEFT JOIN categories c ON c.category_id = s.category_id
         WHERE s.user_id = ? AND s.active = TRUE AND s.paused = FALSE
         ORDER BY s.amount DESC`,
        [userId]
    );
    return (rows || []).map((s) => ({
        subscription_id: s.subscription_id,
        name: s.name,
        amount: money(s.amount),
        day_of_month: Number(s.day_of_month),
        category: s.category || null,
        auto_detected: !!Number(s.auto_detected),
        confirmed: !Number(s.auto_detected) || s.confirmed_at != null,
    }));
}

/**
 * The "Recurring expenses" (הוצאות שוטפות) aggregate.
 *
 * Standing orders: the bank scraper does not report a standing order as such — it is
 * just another debit. Recurring bank debits (insurance, pension, card fees) are caught by
 * recurring detection and so are already inside `subscriptions`; loan repayments are in
 * `loans`. Nothing is counted twice: loan repayments are excluded from detection, and
 * installments are excluded from both.
 */
async function buildRecurring(userId) {
    const [subscriptions, plans, loans] = await Promise.all([
        loadActiveSubscriptions(userId),
        loadInstallmentPlans(userId),
        loansController.loadLoans(userId),
    ]);
    const installments = summarizeInstallments(plans);
    const loanSummary = loansController.summarizeLoans(loans);
    const subscriptionsTotal = money(subscriptions.reduce((s, x) => s + x.amount, 0));
    return {
        currency: 'ILS',
        total_monthly: money(subscriptionsTotal + installments.monthly_commitment + loanSummary.total_monthly_payment),
        subscriptions: { count: subscriptions.length, monthly_total: subscriptionsTotal, items: subscriptions },
        installments: { ...installments, items: plans.filter((p) => p.active) },
        loans: loanSummary,
    };
}

exports.getInstallments = async (req, res) => {
    try {
        const plans = await loadInstallmentPlans(req.user.user_id);
        res.json({
            plans,
            summary: summarizeInstallments(plans),
            // Step 0 finding: installments come from the card feeds only (Max, Visa Cal,
            // Isracard, Amex report "payment N of M"). Banks never do.
            source: 'card_sync',
        });
    } catch (err) {
        console.error('getInstallments error:', err);
        res.status(500).json({ error: 'Failed to fetch installments' });
    }
};

exports.getRecurring = async (req, res) => {
    try {
        res.json(await buildRecurring(req.user.user_id));
    } catch (err) {
        console.error('getRecurring error:', err);
        res.status(500).json({ error: 'Failed to fetch recurring expenses' });
    }
};

/** Approves an auto-detected subscription. */
exports.confirmSubscription = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid subscription id' });
    try {
        const [result] = await db.query(
            'UPDATE subscriptions SET confirmed_at = NOW() WHERE subscription_id = ? AND user_id = ? AND active = TRUE',
            [id, req.user.user_id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Subscription not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('confirmSubscription error:', err);
        res.status(500).json({ error: 'Failed to confirm subscription' });
    }
};

/** Installment payments not yet imported that fall inside a cycle. Used by getPnL. */
function installmentsAheadForCycle(planRows, cycle) {
    return inst.installmentsAhead(
        (planRows || []).map((r) => ({ ...r, last_payment_date: iso(r.last_payment_date) })),
        cycle.start,
        cycle.end
    );
}

exports.loadInstallmentPlans = loadInstallmentPlans;
exports.summarizeInstallments = summarizeInstallments;
exports.loadActiveSubscriptions = loadActiveSubscriptions;
exports.buildRecurring = buildRecurring;
exports.installmentsAheadForCycle = installmentsAheadForCycle;
