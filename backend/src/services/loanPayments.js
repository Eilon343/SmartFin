/**
 * Applying imported loan repayments to their loans. Pure — no DB, no clock.
 *
 * A loan is linked to its repayment debit by `match_key` (the payee identity, e.g.
 * "פרעון הלוואה"). Every matching expense dated AFTER the loan's balance was last entered
 * by hand reduces the balance and the remaining-payment count, once — the caller records
 * each applied expense in loan_payments, which is what makes "once" hold.
 *
 * Interest: a repayment is principal + that month's interest. When the user entered an
 * interest rate, only the principal part (payment − balance × rate / 12) lowers the
 * balance; without a rate the whole payment does, which runs slightly ahead of the bank's
 * figure — the user re-syncs the exact balance by editing it, and that resets the base.
 *
 * Two loans may repay under the same label (Leumi books every loan as "פרעון הלוואה").
 * A payment then goes to the loan whose monthly payment it is closest to, and only if it
 * is plausibly that loan's payment (within 15% or ₪5). A loan with no monthly payment
 * entered accepts any payment under its label, but only when it is the sole loan there.
 */
const { payeeKey } = require('./recurringDetector');

const REL_TOLERANCE = 0.15;
const ABS_TOLERANCE = 5;
const round2 = (n) => Math.round(n * 100) / 100;

function plausible(amount, monthly) {
    return Math.abs(amount - monthly) <= Math.max(ABS_TOLERANCE, REL_TOLERANCE * monthly);
}

/**
 * @param {Array<{loan_id, match_key, monthly_payment, balance_updated_at: 'YYYY-MM-DD'|null}>} loans
 * @param {Array<{expense_id, description, amount, date: 'YYYY-MM-DD'}>} expenses
 * @param {Set<number>} alreadyApplied expense ids in loan_payments
 * @returns {Array<{loan_id, expense_id, amount, date}>} chronological
 */
function matchRepayments(loans, expenses, alreadyApplied = new Set()) {
    const byKey = new Map();
    for (const l of loans || []) {
        if (!l.match_key) continue;
        if (!byKey.has(l.match_key)) byKey.set(l.match_key, []);
        byKey.get(l.match_key).push(l);
    }
    const out = [];
    for (const e of expenses || []) {
        const amount = Number(e.amount);
        if (!(amount > 0) || alreadyApplied.has(e.expense_id)) continue;
        const candidates = (byKey.get(payeeKey(e.description)) || [])
            .filter((l) => !l.balance_updated_at || e.date > l.balance_updated_at);
        if (candidates.length === 0) continue;

        let loan = null;
        const priced = candidates.filter((l) => Number(l.monthly_payment) > 0 && plausible(amount, Number(l.monthly_payment)));
        if (priced.length) {
            loan = priced.sort((a, b) => Math.abs(amount - a.monthly_payment) - Math.abs(amount - b.monthly_payment))[0];
        } else if (candidates.length === 1 && !(Number(candidates[0].monthly_payment) > 0)) {
            loan = candidates[0];
        }
        if (loan) out.push({ loan_id: loan.loan_id, expense_id: e.expense_id, amount, date: e.date });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.expense_id - b.expense_id);
}

/**
 * The loan after one repayment.
 * @returns {{principal, outstanding_balance, remaining_payments}}
 */
function applyPayment({ outstanding_balance, remaining_payments, interest_rate }, amount) {
    const balance = Number(outstanding_balance) || 0;
    const rate = Number(interest_rate) || 0;
    const interest = rate > 0 ? round2(balance * rate / 100 / 12) : 0;
    const principal = round2(Math.min(balance, Math.max(0, amount - interest)));
    return {
        principal,
        outstanding_balance: round2(Math.max(0, balance - principal)),
        remaining_payments: remaining_payments == null ? null : Math.max(0, Number(remaining_payments) - 1),
    };
}

module.exports = { matchRepayments, applyPayment, plausible };
