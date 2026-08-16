// Companies supported by israeli-bank-scrapers that SmartFin exposes for connection.
// Keys and loginFields must exactly match the library's CompanyTypes / SCRAPERS
// definitions — they are passed straight through to createScraper().
//
// `kind` drives how imported transactions are interpreted:
//   'bank' — a current account. Negative = expense, positive = income (salary etc.).
//            Its credit-card settlement rows are skipped when the matching card is
//            also connected, so card purchases aren't counted twice.
//   'card' — a credit card. Every row is spending on that card; there is no income,
//            so a positive amount is a refund and becomes a negative expense.
//
// Deliberately omitted: `oneZero`. Its loginFields include `otpCodeRetriever`, a
// callback function the scraper invokes to obtain a 2FA code, plus a long-term OTP
// token. Those cannot be collected through a credentials form, so exposing One Zero
// here would render a login form that can never succeed. Supporting it needs a real
// two-factor enrolment flow.
module.exports = {
    // ── Banks ────────────────────────────────────────────────────────────────
    hapoalim: { name: 'Bank Hapoalim', kind: 'bank', loginFields: ['userCode', 'password'] },
    leumi: { name: 'Bank Leumi', kind: 'bank', loginFields: ['username', 'password'] },
    mizrahi: { name: 'Mizrahi Bank', kind: 'bank', loginFields: ['username', 'password'] },
    discount: { name: 'Discount Bank', kind: 'bank', loginFields: ['id', 'password', 'num'] },
    mercantile: { name: 'Mercantile Bank', kind: 'bank', loginFields: ['id', 'password', 'num'] },
    otsarHahayal: { name: 'Bank Otsar Hahayal', kind: 'bank', loginFields: ['username', 'password'] },
    beinleumi: { name: 'Beinleumi', kind: 'bank', loginFields: ['username', 'password'] },
    union: { name: 'Union', kind: 'bank', loginFields: ['username', 'password'] },
    massad: { name: 'Massad', kind: 'bank', loginFields: ['username', 'password'] },
    yahav: { name: 'Bank Yahav', kind: 'bank', loginFields: ['username', 'nationalID', 'password'] },
    pagi: { name: 'Pagi', kind: 'bank', loginFields: ['username', 'password'] },

    // ── Credit cards ─────────────────────────────────────────────────────────
    isracard: { name: 'Isracard', kind: 'card', loginFields: ['id', 'card6Digits', 'password'] },
    max: { name: 'Max', kind: 'card', loginFields: ['username', 'password'] },
    visaCal: { name: 'Visa Cal', kind: 'card', loginFields: ['username', 'password'] },
    amex: { name: 'Amex', kind: 'card', loginFields: ['id', 'card6Digits', 'password'] },
    behatsdaa: { name: 'Behatsdaa', kind: 'card', loginFields: ['id', 'password'] },
    beyahadBishvilha: { name: 'Beyahad Bishvilha', kind: 'card', loginFields: ['id', 'password'] },
};
