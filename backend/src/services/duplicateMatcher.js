/**
 * Duplicate matching between hand-logged rows and bank/card-imported rows.
 *
 * Once a bank or card connection exists, sync imports purchases the user already logged
 * by hand (Apple Pay shortcut, the Telegram bot, the web form). This module decides which
 * hand-logged rows now have a real counterpart and are therefore safe to remove.
 *
 * Every rule lives here and the entry point is pure — no DB, no clock — so the money
 * logic is testable in isolation, the same way `classifyRow()` holds the import rules.
 *
 * THE CORE RULE: a date range is not evidence. Plenty of hand-logged spending never
 * reaches a bank or card feed at all — cash, Bit, PayBox, a card that was never
 * connected. Deleting "everything in the synced window" would erase those permanently
 * and they cannot be reconstructed. So a row counts as a duplicate only when a real
 * imported transaction with the SAME AMOUNT sits within a few days of it.
 *
 * Descriptions are deliberately never compared. You type "shawarma"; Isracard reports
 * "שווארמה הקסם". Requiring them to agree would match almost nothing.
 */

// How far apart a hand-logged row and the issuer's version of it may sit. The user logs
// at the moment of payment; banks and card issuers post one to a few days later.
const MATCH_WINDOW_DAYS = 5;

// Everything a person entered themselves. These are the only rows cleanup may touch —
// a 'bank_sync' row is the imported fact and is never a deletion candidate.
const USER_ENTERED_SOURCES = ['apple_pay', 'bot', 'manual', 'web'];

// Money compares as integer agorot. Amounts arrive as DECIMAL strings from mysql2 and as
// floats elsewhere; rounding both to agorot avoids 55.00 !== 54.999999999999996.
function toAgorot(amount) {
    return Math.round(Number(amount) * 100);
}

/**
 * Day-only difference between two dates, ignoring time and timezone entirely.
 *
 * Both sides are date-only values that mysql2 hands back as local-midnight Date objects.
 * Comparing them as instants would let a DST shift or a local-vs-UTC mismatch bend a
 * 5-day window into 4 or 6 — the same class of bug that dated every imported transaction
 * one day early. Reading the calendar fields directly sidesteps the question.
 */
function dayDiff(a, b) {
    const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.abs(utcA - utcB) / 86400000;
}

function asDate(value) {
    if (value instanceof Date) return value;
    // 'YYYY-MM-DD' — split rather than Date.parse, which reads it as UTC midnight and
    // then renders it as the previous day west of Greenwich.
    const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
}

/**
 * Pairs hand-logged rows with the imported transaction that now covers them.
 *
 * Matching is ONE-TO-ONE: each imported transaction can absorb only one hand-logged row,
 * so two ₪19.90 coffees still need two separate counterparts before both are removed.
 * Without that, one imported coffee would justify deleting every coffee you ever logged.
 *
 * Among equally valid candidates the CLOSEST DATE wins. Any untaken same-amount row
 * inside the window would be defensible, but the nearest one is the pair a human would
 * draw, and these pairs are shown in the UI for approval — an odd-looking pairing costs
 * trust even when the arithmetic is identical.
 *
 * @param {Array} logged  hand-logged rows: { id, amount, date, description, source, category_id }
 * @param {Array} synced  imported rows:    { id, amount, date, description, account }
 * @returns {{ matched: Array, unmatched: Array }} matched rows carry `match` — the
 *          counterpart they were paired with — so the caller can show the evidence.
 */
function matchDuplicates(logged, synced, { windowDays = MATCH_WINDOW_DAYS } = {}) {
    const candidates = synced.map((row) => ({
        id: row.id,
        amount: toAgorot(row.amount),
        date: asDate(row.date),
        description: row.description,
        account: row.account,
        taken: false,
    }));

    const matched = [];
    const unmatched = [];

    // Oldest first, so the run is deterministic and a re-run after new imports arrive
    // pairs the same rows the preview showed.
    const ordered = [...logged].sort((a, b) => asDate(a.date) - asDate(b.date) || a.id - b.id);

    for (const row of ordered) {
        const amount = toAgorot(row.amount);
        const date = asDate(row.date);

        let best = null;
        let bestGap = Infinity;
        for (const candidate of candidates) {
            if (candidate.taken || candidate.amount !== amount) continue;
            const gap = dayDiff(candidate.date, date);
            if (gap <= windowDays && gap < bestGap) {
                best = candidate;
                bestGap = gap;
            }
        }

        if (best) {
            best.taken = true;
            matched.push({
                ...row,
                match: {
                    id: best.id,
                    amount: best.amount / 100,
                    date: best.date,
                    description: best.description,
                    account: best.account,
                },
            });
        } else {
            unmatched.push(row);
        }
    }

    return { matched, unmatched };
}

module.exports = {
    matchDuplicates,
    MATCH_WINDOW_DAYS,
    USER_ENTERED_SOURCES,
};
