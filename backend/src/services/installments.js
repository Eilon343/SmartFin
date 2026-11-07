/**
 * Credit-card installment plans ("תשלומים"). Pure — no DB, no clock; every input passed in.
 *
 * WHERE THE DATA COMES FROM (Step 0 of the installments work)
 *
 * israeli-bank-scrapers returns, per card transaction (Max and Visa Cal both fill these):
 *   type            'normal' | 'installments'
 *   installments    { number, total }  — "payment 3 of 12"; absent on a one-off purchase
 *   chargedAmount   THIS payment (negative = spending)
 *   originalAmount  the whole purchase
 *   date            with combineInstallments:false, the purchase date shifted forward by
 *                   (number − 1) months, i.e. the month this payment belongs to
 * bankSyncScheduler stores the full transaction in bank_transactions_raw.raw_json, so
 * everything here is read from there. Banks (Leumi etc.) never report installments.
 *
 * COUNTED EXACTLY ONCE
 *
 * A payment the scraper has already returned is staged → imported → an `expenses` row.
 * A payment it has NOT returned yet is projected from the plan. The boundary between
 * the two is `last_number`, the highest payment number already imported, so a payment
 * is either real or projected, never both: the moment it is imported, `last_number`
 * passes it and the projection drops it. Installments are also never fed to recurring
 * detection (see recurringDetector), so a plan is never mistaken for a subscription.
 */

const pad2 = (n) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` + n months, day clamped to the target month's length. */
function addMonthsISO(iso, n) {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    const total = (y * 12 + (m - 1)) + n;
    const ty = Math.floor(total / 12);
    const tm = total % 12; // 0-based
    const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return `${ty}-${pad2(tm + 1)}-${pad2(Math.min(d, last))}`;
}

function parseRaw(raw) {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
}

/** `{number,total}` when the row is a genuine multi-payment plan, else null. */
function installmentInfoOf(raw) {
    const r = parseRaw(raw);
    const inst = r?.installments;
    const number = Number(inst?.number);
    const total = Number(inst?.total);
    if (!Number.isInteger(number) || !Number.isInteger(total)) return null;
    if (total < 2 || number < 1 || number > total) return null;
    return { number, total };
}

/**
 * Fallback for issuers that only spell it out in the text: "תשלום 3 מתוך 12",
 * "3 מ-12", "installment 3 of 12".
 */
function installmentInfoFromText(text) {
    const m = String(text || '').match(/(?:תשלום|installment)\s*(\d{1,2})\s*(?:מתוך|מ-|of|\/)\s*(\d{1,2})/i);
    if (!m) return null;
    const number = Number(m[1]);
    const total = Number(m[2]);
    return total >= 2 && number >= 1 && number <= total ? { number, total } : null;
}

/**
 * Groups imported installment rows into plans.
 *
 * @param {Array<{bank_connection_id, account_number, description, memo, txn_date: string,
 *                charged_amount, raw_json}>} rows  imported card rows for ONE user
 * @returns {Array<object>} one entry per plan
 *
 * A plan's identity is the purchase it belongs to: same card account, merchant, original
 * amount, payment count and FIRST-payment month (txn month shifted back by number − 1).
 * Two identical purchases at the same shop in the same month would merge — rare, and the
 * cost is projecting one plan instead of two, not inventing money.
 */
function buildPlans(rows) {
    const plans = new Map();
    for (const row of rows) {
        const raw = parseRaw(row.raw_json);
        const info = installmentInfoOf(raw) || installmentInfoFromText(`${row.description || ''} ${row.memo || ''}`);
        if (!info) continue;

        const date = String(row.txn_date).slice(0, 10);
        const firstMonth = addMonthsISO(date, -(info.number - 1)).slice(0, 7);
        const monthly = Math.abs(Number(row.charged_amount));
        const original = Math.abs(Number(raw?.originalAmount ?? 0)) || monthly * info.total;
        const key = [row.bank_connection_id, row.account_number || '', (row.description || '').trim(),
            original.toFixed(2), info.total, firstMonth].join('|');

        const existing = plans.get(key);
        if (!existing || info.number > existing.last_number) {
            plans.set(key, {
                plan_key: key,
                merchant: (row.description || '').trim(),
                monthly_amount: monthly,
                total_amount: Math.round(original * 100) / 100,
                total_payments: info.total,
                last_number: info.number,
                last_payment_date: date,
                first_month: firstMonth,
            });
        }
    }
    return [...plans.values()].map(withSchedule);
}

/** Adds remaining / next / end, derived only from the last imported payment. */
function withSchedule(plan) {
    const remaining = plan.total_payments - plan.last_number;
    return {
        ...plan,
        remaining_payments: remaining,
        remaining_amount: Math.round(plan.monthly_amount * remaining * 100) / 100,
        next_payment_date: remaining > 0 ? addMonthsISO(plan.last_payment_date, 1) : null,
        end_date: addMonthsISO(plan.last_payment_date, remaining),
        active: remaining > 0,
    };
}

/** Dates of the payments not yet imported. */
function futurePaymentDates(plan) {
    const out = [];
    for (let k = 1; k <= plan.total_payments - plan.last_number; k++) {
        out.push(addMonthsISO(plan.last_payment_date, k));
    }
    return out;
}

/**
 * Money a set of plans will still take inside [start, end) — the installments the
 * forecast must add because they are not in `expenses` yet.
 */
function installmentsAhead(plans, start, end) {
    let total = 0;
    for (const p of plans || []) {
        const amount = Number(p.monthly_amount);
        for (const d of futurePaymentDates({
            total_payments: Number(p.total_payments),
            last_number: Number(p.last_number),
            last_payment_date: String(p.last_payment_date).slice(0, 10),
        })) {
            if (d >= start && d < end) total += amount;
        }
    }
    return Math.round(total * 100) / 100;
}

/** What active plans cost per month, all together. */
function monthlyCommitment(plans) {
    const sum = (plans || [])
        .filter((p) => Number(p.total_payments) - Number(p.last_number) > 0)
        .reduce((s, p) => s + Number(p.monthly_amount), 0);
    return Math.round(sum * 100) / 100;
}

module.exports = {
    addMonthsISO,
    installmentInfoOf,
    installmentInfoFromText,
    buildPlans,
    withSchedule,
    futurePaymentDates,
    installmentsAhead,
    monthlyCommitment,
};
