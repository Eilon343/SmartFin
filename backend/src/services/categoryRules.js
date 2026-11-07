/**
 * Deterministic categorization for imported bank and card rows. Pure — no DB, no network.
 *
 * Gemini sees only a merchant string and guesses. For a handful of payees the answer is not
 * a guess at all — "פרעון הלוואה" is a loan repayment, "ריבית אשראים" is a bank fee,
 * "הראל ביטוח" is insurance — and Gemini got exactly those wrong on a real account (Harel
 * life insurance filed under Savings, loan repayments left uncategorized). These rules run
 * FIRST; only rows no rule claims go to Gemini.
 *
 * Every pattern here must be precise enough that a false match is implausible. When in
 * doubt, leave it to Gemini — a wrong deterministic rule is wrong on every future import.
 * Names must exist as categories (base categories from init.sql / migration 016).
 */

const RULES = [
    // ── Loans ────────────────────────────────────────────────────────────────
    // Repayment of a bank loan, and the disbursement itself (handled in classifyRow).
    { category: 'Loans', pattern: /פרעון הלו?ואה|פירעון הלו?ואה|החזר הלו?ואה|העמדת הלו?ואה|תשלום הלו?ואה|הלוואה\s*-?\s*ריבית/ },
    { category: 'Loans', pattern: /משכנתא/ },

    // ── Bank & card fees ─────────────────────────────────────────────────────
    { category: 'Fees', pattern: /ריבית אשראי|ריבית חובה|עמ\.?\s*הקצאת אשראי|עמלת|עמלה|דמי כרטיס|דמי ניהול חשבון/ },

    // ── Insurance ────────────────────────────────────────────────────────────
    // "ביטוח" itself is distinctive; insurers are listed for descriptors that omit it.
    { category: 'Insurance', pattern: /ביטוח|מגדל חברה|הפניקס|כלל חברה|מנורה מבטחים|הכשרה חברה|AIG|שירביט|מרכז הסליקה של חברות ביטוח/i },

    // ── Long-term savings (pension, provident, study funds) ─────────────────
    { category: 'Savings', pattern: /גמל|פנסיה|השתלמות|מיטב דש|אלטשולר|מור גמל|אנליסט/ },

    // ── Health ───────────────────────────────────────────────────────────────
    { category: 'Health', pattern: /מכבי|כללית|מאוחדת|לאומית שירותי|בית מרקחת|רופא|מרפאה|קופת חולים|אופטיק/ },

    // ── Recurring digital subscriptions ─────────────────────────────────────
    {
        category: 'Subscriptions',
        pattern: /ANTHROPIC|CLAUDE\.AI|OPENAI|CHATGPT|NETFLIX|SPOTIFY|DISNEY|PRIME VIDEO|YOUTUBE ?PREMIUM|GOOGLE ?ONE|APPLE\.COM\/BILL|ICLOUD|DROPBOX|MICROSOFT\*|ADOBE|PATREON|REAL-DEBRID|EXITLAG/i,
    },

    // ── Telecom & utilities ──────────────────────────────────────────────────
    { category: 'Utilities', pattern: /פלאפון|סלקום|פרטנר|הוט מובייל|הוט טלקום|בזק|גולן טלקום|רמי לוי תקשורת|012 סמייל|חברת החשמל|תאגיד מים|ארנונה|עירית|עיריית|סופרגז|אמישראגז|פזגז/ },

    // ── Transport ────────────────────────────────────────────────────────────
    { category: 'Transport', pattern: /דלק|(?<![א-ת])פז(?![א-ת]|גז)|סונול|YELLOW|דור אלון|(?<![א-ת])טן(?![א-ת])|מנהרות הכרמל|כביש 6|כבישתיש|פנגו|מוביט|רב[- ]קו|GETT|YANGO|רכבת ישראל|אגד|משרד התחבורה|ביטוח חובה|חניון|אחוזת החוף/i },

    // ── Personal care ────────────────────────────────────────────────────────
    { category: 'Personal Care', pattern: /עיצוב שיער|מספרה|קוסמטיקה|ציפורניים|מניקור/ },

    // ── Money moved to people / cash — not consumption of a category ─────────
    { category: 'Transfers', pattern: /^BIT$|העברה ב ?BIT|^PAYBOX|PAYBOX$|תשלום מיידי|משיכת מזומן|משיכה מכספומט|העברה לחשבון|העברה דיגיטל|העברה בנקאית/i },
];

/**
 * The category a rule assigns to this description, or null when no rule applies.
 * @param {string} description
 * @param {string} [memo]
 */
function ruleCategoryOf(description, memo = '') {
    const text = `${description || ''} ${memo || ''}`.trim();
    if (!text) return null;
    const hit = RULES.find((r) => r.pattern.test(text));
    return hit ? hit.category : null;
}

/**
 * The extra context sent to Gemini for a row. Card issuers (Max, Visa Cal) classify every
 * purchase themselves and the scraper passes that label through as `category`; it is a
 * far better signal than a truncated merchant name, and was being thrown away.
 */
function geminiHintOf(row) {
    let raw = row.raw_json;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { raw = null; }
    }
    const parts = [];
    if (raw?.category) parts.push(`issuer category: ${raw.category}`);
    if (row.memo) parts.push(`memo: ${row.memo}`);
    return parts.length ? `${row.description || ''} (${parts.join('; ')})` : (row.description || '');
}

module.exports = { ruleCategoryOf, geminiHintOf, RULES };
