const db = require('../config/db');
const cy = require('../services/cycle');
const { addMonthsISO } = require('../services/installments');
const { payeeKey } = require('../services/recurringDetector');

// Loans are MANUAL ENTRY. No supported scraper (israeli-bank-scrapers 6.9) returns loan
// details — balance, rate and remaining payments are simply not in its output — so the
// user types them in and updates the balance from their bank statement. What sync DOES
// see is the monthly repayment debit ("פרעון הלוואה"); GET /loans offers those as
// `detected_repayments` so adding a loan starts from real numbers.

const LOAN_TYPES = ['mortgage', 'loan', 'overdraft', 'other'];
const REPAYMENT_PATTERN_SQL = ['%פרעון הלו%', '%פירעון הלו%', '%החזר הלו%', '%משכנתא%'];

const num = (v) => (v == null || v === '' ? null : Number(v));
const money = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);

/**
 * The next date a loan is due, on or after `today`. Taken from payment_day when set
 * (rolls forward on its own every month); otherwise the stored next_payment_date, rolled
 * forward by whole months once it has passed so the list never shows a date in the past.
 */
function nextDueDate(loan, today) {
    if (loan.payment_day) {
        const day = Math.min(28, Math.max(1, Number(loan.payment_day)));
        const thisMonth = `${today.slice(0, 7)}-${String(day).padStart(2, '0')}`;
        return thisMonth >= today ? thisMonth : addMonthsISO(thisMonth, 1);
    }
    if (!loan.next_payment_date) return null;
    let d = String(loan.next_payment_date instanceof Date ? isoDate(loan.next_payment_date) : loan.next_payment_date).slice(0, 10);
    for (let i = 0; d < today && i < 600; i++) d = addMonthsISO(d, 1);
    return d;
}

function isoDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shapeLoan(row, today) {
    const remaining = row.remaining_payments == null ? null : Number(row.remaining_payments);
    return {
        // remaining_payments reaching 0 (repayments applied automatically) means paid off.
        finished: remaining === 0,
        loan_id: row.loan_id,
        lender: row.lender,
        loan_type: row.loan_type,
        original_amount: money(row.original_amount),
        outstanding_balance: money(row.outstanding_balance),
        interest_rate: row.interest_rate == null ? null : Number(row.interest_rate),
        monthly_payment: money(row.monthly_payment),
        remaining_payments: row.remaining_payments == null ? null : Number(row.remaining_payments),
        payment_day: row.payment_day == null ? null : Number(row.payment_day),
        next_payment_date: nextDueDate(row, today),
        match_key: row.match_key || null,
        notes: row.notes || null,
        balance_updated_at: row.balance_updated_at
            ? String(row.balance_updated_at instanceof Date ? isoDate(row.balance_updated_at) : row.balance_updated_at).slice(0, 10)
            : null,
        source: 'manual',
        // Repayments applied to this loan automatically (loan_payments), newest first.
        payments: [],
    };
}

/** Totals for a list of shaped loans. Exported for the agent API and the dashboard. */
function summarizeLoans(loans) {
    const upcoming = loans.filter((l) => l.next_payment_date && !l.finished).sort((a, b) => a.next_payment_date.localeCompare(b.next_payment_date))[0];
    return {
        count: loans.length,
        total_outstanding: money(loans.reduce((s, l) => s + (l.outstanding_balance || 0), 0)),
        total_monthly_payment: money(loans.filter((l) => !l.finished).reduce((s, l) => s + (l.monthly_payment || 0), 0)),
        next_payment: upcoming
            ? { lender: upcoming.lender, date: upcoming.next_payment_date, amount: upcoming.monthly_payment }
            : null,
    };
}

async function loadLoans(userId) {
    const [rows] = await db.query(
        `SELECT loan_id, lender, loan_type, original_amount, outstanding_balance, interest_rate,
                monthly_payment, remaining_payments, payment_day, next_payment_date, match_key,
                notes, balance_updated_at
         FROM loans WHERE user_id = ? AND active = TRUE ORDER BY outstanding_balance DESC`,
        [userId]
    );
    const today = cy.todayISO();
    const loans = (rows || []).map((r) => shapeLoan(r, today));
    if (loans.length) {
        const [payments] = await db.query(
            `SELECT lp.loan_id, lp.paid_on, lp.amount, lp.principal, lp.balance_after
             FROM loan_payments lp JOIN loans l ON l.loan_id = lp.loan_id
             WHERE l.user_id = ? ORDER BY lp.paid_on DESC`,
            [userId]
        );
        const byLoan = new Map(loans.map((l) => [l.loan_id, l]));
        for (const p of payments || []) {
            const loan = byLoan.get(p.loan_id);
            if (!loan || loan.payments.length >= 12) continue;
            loan.payments.push({
                date: String(p.paid_on instanceof Date ? isoDate(p.paid_on) : p.paid_on).slice(0, 10),
                amount: money(p.amount),
                principal: money(p.principal),
                balance_after: money(p.balance_after),
            });
        }
    }
    return loans;
}

/**
 * Repayment debits seen in the last ~4 months, grouped per payee — candidates for a loan
 * the user has not entered yet. Only from the user's own expenses; never bank_* tables.
 */
async function detectedRepayments(userId, loans) {
    const [rows] = await db.query(
        `SELECT description, amount, created_at FROM expenses
         WHERE user_id = ? AND is_virtual = FALSE AND amount > 0
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL 130 DAY)
           AND (description LIKE ? OR description LIKE ? OR description LIKE ? OR description LIKE ?)
         ORDER BY created_at`,
        [userId, ...REPAYMENT_PATTERN_SQL]
    );
    const linked = new Set(loans.map((l) => l.match_key).filter(Boolean));
    const groups = new Map();
    for (const r of rows || []) {
        const key = payeeKey(r.description);
        if (!groups.has(key)) groups.set(key, { match_key: key, description: r.description, payments: [] });
        groups.get(key).payments.push({ date: isoDate(new Date(r.created_at)), amount: Number(r.amount) });
    }
    return [...groups.values()]
        .map((g) => {
            const last = g.payments[g.payments.length - 1];
            const avg = g.payments.reduce((s, p) => s + p.amount, 0) / g.payments.length;
            return {
                // Already linked to a loan: still listed (the form offers it for linking),
                // but the "add as loan" suggestion hides it.
                linked: linked.has(g.match_key),
                match_key: g.match_key,
                description: g.description,
                payments_seen: g.payments.length,
                average_amount: money(avg),
                last_amount: money(last.amount),
                last_date: last.date,
                payment_day: Number(last.date.slice(8, 10)),
            };
        });
}

exports.getLoans = async (req, res) => {
    try {
        const loans = await loadLoans(req.user.user_id);
        const payees = await detectedRepayments(req.user.user_id, loans);
        res.json({
            loans,
            summary: summarizeLoans(loans),
            detected_repayments: payees.filter((p) => !p.linked),
            repayment_payees: payees.map(({ match_key, description }) => ({ match_key, description })),
        });
    } catch (err) {
        console.error('getLoans error:', err);
        res.status(500).json({ error: 'Failed to fetch loans' });
    }
};

function validate(body, { partial = false } = {}) {
    const out = {};
    const errors = [];
    if (!partial || body.lender !== undefined) {
        const lender = String(body.lender || '').trim();
        if (!lender) errors.push('lender is required');
        out.lender = lender.slice(0, 100);
    }
    if (body.loan_type !== undefined || !partial) {
        const t = body.loan_type || 'loan';
        if (!LOAN_TYPES.includes(t)) errors.push(`loan_type must be one of ${LOAN_TYPES.join(', ')}`);
        out.loan_type = t;
    }
    const numeric = {
        original_amount: [0, 100_000_000],
        outstanding_balance: [0, 100_000_000],
        interest_rate: [0, 100],
        monthly_payment: [0, 10_000_000],
        remaining_payments: [0, 1200],
        payment_day: [1, 31],
    };
    for (const [field, [min, max]] of Object.entries(numeric)) {
        if (body[field] === undefined) {
            if (!partial && (field === 'outstanding_balance' || field === 'monthly_payment')) out[field] = 0;
            continue;
        }
        const v = num(body[field]);
        if (v != null && (!Number.isFinite(v) || v < min || v > max)) errors.push(`${field} must be between ${min} and ${max}`);
        out[field] = v;
    }
    if (out.remaining_payments != null) out.remaining_payments = Math.round(out.remaining_payments);
    if (out.payment_day != null) out.payment_day = Math.round(out.payment_day);
    if (body.next_payment_date !== undefined) {
        const d = body.next_payment_date;
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) errors.push('next_payment_date must be YYYY-MM-DD');
        out.next_payment_date = d || null;
    }
    if (body.notes !== undefined) out.notes = body.notes ? String(body.notes).slice(0, 255) : null;
    if (body.match_key !== undefined) out.match_key = body.match_key ? String(body.match_key).slice(0, 190) : null;
    return { values: out, errors };
}

exports.addLoan = async (req, res) => {
    const { values, errors } = validate(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    try {
        const cols = Object.keys(values);
        const [result] = await db.query(
            `INSERT INTO loans (user_id, ${cols.join(', ')}, balance_updated_at) VALUES (?, ${cols.map(() => '?').join(', ')}, CURDATE())`,
            [req.user.user_id, ...cols.map((c) => values[c])]
        );
        res.json({ loan_id: result.insertId });
    } catch (err) {
        console.error('addLoan error:', err);
        res.status(500).json({ error: 'Failed to add loan' });
    }
};

exports.updateLoan = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid loan id' });
    const { values, errors } = validate(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    const cols = Object.keys(values);
    if (cols.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    try {
        // A balance edit is the "balance update" — stamp when it was last checked.
        const stamp = values.outstanding_balance !== undefined ? ', balance_updated_at = CURDATE()' : '';
        const [result] = await db.query(
            `UPDATE loans SET ${cols.map((c) => `${c} = ?`).join(', ')}${stamp}
             WHERE loan_id = ? AND user_id = ? AND active = TRUE`,
            [...cols.map((c) => values[c]), id, req.user.user_id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Loan not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('updateLoan error:', err);
        res.status(500).json({ error: 'Failed to update loan' });
    }
};

exports.deleteLoan = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid loan id' });
    try {
        const [result] = await db.query(
            'UPDATE loans SET active = FALSE WHERE loan_id = ? AND user_id = ?',
            [id, req.user.user_id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Loan not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('deleteLoan error:', err);
        res.status(500).json({ error: 'Failed to delete loan' });
    }
};

exports.loadLoans = loadLoans;
exports.summarizeLoans = summarizeLoans;
exports.nextDueDate = nextDueDate;
exports.LOAN_TYPES = LOAN_TYPES;
