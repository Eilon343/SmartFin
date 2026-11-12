/**
 * Automatic recurring-expense (subscription) detection. Pure — no DB, no clock.
 *
 * RULE
 *   The same payee, at a similar amount, charged in EACH of the last 3 consecutive
 *   months, is a recurring expense. "Similar" is within 15% or ₪5 of the cluster's
 *   median, whichever is wider — a ₪19.90 → ₪21.90 price change is the same plan,
 *   ₪30 → ₪120 is not.
 *
 *   "The last 3 months" is anchored on the month the latest charge of that payee fell in,
 *   and that month must be the current or the previous one: a gym you stopped paying in
 *   the spring is not a subscription today. Month = calendar month of the charge date;
 *   billing days drift a few days but not out of their month often enough to matter, and
 *   a missed month simply means the payee is not detected yet.
 *
 * NEVER DETECTED
 *   - installments: they have a known end, and are counted by services/installments.js —
 *     detecting them too would forecast the same payment twice.
 *   - transfers, cash, card settlements, loan repayments (loans have their own tab).
 *   - one-offs, by construction: they cannot appear in three consecutive months.
 *
 * One payee can hold more than one plan (Apple bills iCloud and a game pass separately),
 * so rows are clustered by amount within a payee before the three-month test.
 */

const MONTHS_REQUIRED = 3;
const REL_TOLERANCE = 0.15;
const ABS_TOLERANCE = 5;

// Not subscriptions whatever their regularity.
const EXCLUDED_PATTERNS = [
    /העברה|העברת|^BIT$|BIT\b|PAYBOX|תשלום מיידי|משיכת מזומן|משיכה/i,
    /הלו?ואה|משכנתא/,
    /כרטיסי אשראי|ויזה כאל|מקס איט|ישראכרט|לאומי דביט|לאומי קארד|אמריקן אקספרס/,
    /משכורת|רבית זכות|ריבית זכות/,
];
const EXCLUDED_CATEGORIES = new Set(['Transfers', 'Loans']);

/**
 * Payee identity: case-folded, digits and punctuation runs removed (reference numbers,
 * "4259522 912-1844160"), whitespace collapsed. Kept in Hebrew as is.
 */
function payeeKey(description) {
    return String(description || '')
        .toUpperCase()
        .replace(/[0-9]+/g, ' ')
        .replace(/[*#_.,:;'"()\\/+-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

function isExcluded(row) {
    if (row.is_installment) return true;
    if (EXCLUDED_CATEGORIES.has(row.category)) return true;
    const d = row.description || '';
    return EXCLUDED_PATTERNS.some((p) => p.test(d));
}

const monthOf = (iso) => String(iso).slice(0, 7);
function prevMonth(key, n = 1) {
    const [y, m] = key.split('-').map(Number);
    const t = y * 12 + (m - 1) - n;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
function median(nums) {
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const similar = (a, b) => Math.abs(a - b) <= Math.max(ABS_TOLERANCE, REL_TOLERANCE * Math.max(a, b));

/** Greedy 1-D clustering on sorted amounts. */
function clusterByAmount(rows) {
    const sorted = [...rows].sort((a, b) => a.amount - b.amount);
    const clusters = [];
    for (const r of sorted) {
        const c = clusters[clusters.length - 1];
        if (c && similar(median(c.map((x) => x.amount)), r.amount)) c.push(r);
        else clusters.push([r]);
    }
    return clusters;
}

/**
 * @param {Array<{description, amount: number, date: 'YYYY-MM-DD', category?, is_installment?}>} rows
 *        positive spending rows (refunds excluded by the caller)
 * @param {string} currentMonth 'YYYY-MM' — today's calendar month
 * @returns {Array<{match_key, name, amount, day_of_month, category, months: string[]}>}
 */
function detectRecurring(rows, currentMonth) {
    const byPayee = new Map();
    for (const r of rows || []) {
        const amount = Number(r.amount);
        if (!(amount > 0) || isExcluded(r)) continue;
        const key = payeeKey(r.description);
        if (!key) continue;
        if (!byPayee.has(key)) byPayee.set(key, []);
        byPayee.get(key).push({ ...r, amount, date: String(r.date).slice(0, 10) });
    }

    const found = [];
    for (const [key, payeeRows] of byPayee) {
        for (const cluster of clusterByAmount(payeeRows)) {
            const months = new Set(cluster.map((r) => monthOf(r.date)));
            const latest = [...months].sort().pop();
            if (latest !== currentMonth && latest !== prevMonth(currentMonth)) continue;

            const window = Array.from({ length: MONTHS_REQUIRED }, (_, i) => prevMonth(latest, i));
            if (!window.every((m) => months.has(m))) continue;

            // Several charges a month (two coffees at the same café) is a habit, not a plan.
            const inWindow = cluster.filter((r) => window.includes(monthOf(r.date)));
            if (inWindow.length > MONTHS_REQUIRED + 1) continue;

            const newest = [...inWindow].sort((a, b) => a.date.localeCompare(b.date)).pop();
            const amountTag = Math.round(median(inWindow.map((r) => r.amount)));
            found.push({
                // A payee may carry two plans; the rounded amount keeps their keys apart.
                match_key: `${key}|${amountTag}`.slice(0, 190),
                name: (newest.description || '').trim().slice(0, 100),
                amount: Math.round(newest.amount * 100) / 100,
                day_of_month: Math.min(28, Math.max(1, Math.round(median(inWindow.map((r) => Number(r.date.slice(8, 10))))))),
                category: newest.category || null,
                months: [...window].reverse(),
            });
        }
    }
    return found.sort((a, b) => b.amount - a.amount);
}

module.exports = { detectRecurring, payeeKey, isExcluded, MONTHS_REQUIRED };
