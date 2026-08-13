const {
    classifyRow, settlementIssuerOf, isRefund, hashTxn, txnDateOf, bankDateOf,
    syncWindowStart, DUE_CONNECTIONS_QUERY,
} = require('../../backend/src/services/bankSyncScheduler');
const { encrypt, decrypt } = require('../../backend/src/utils/cryptoUtil');
const bankCompanies = require('../../backend/src/config/bankCompanies');

const bankRow = (over = {}) => ({ company_id: 'otsarHahayal', charged_amount: -100, description: 'קניות', ...over });
const cardRow = (over = {}) => ({ company_id: 'isracard', charged_amount: -50, description: 'שופרסל', ...over });

describe('classifyRow — bank account', () => {
    test('negative amount becomes an expense with a positive amount', () => {
        expect(classifyRow(bankRow({ charged_amount: -250.5 }))).toEqual({
            action: 'expense', amount: 250.5, reason: 'bank_debit',
        });
    });

    test('positive amount becomes income', () => {
        expect(classifyRow(bankRow({ charged_amount: 15000, description: 'משכורת' }))).toEqual({
            action: 'income', amount: 15000, reason: 'bank_credit',
        });
    });
});

describe('classifyRow — credit card', () => {
    test('purchase becomes an expense', () => {
        expect(classifyRow(cardRow({ charged_amount: -89.9 }))).toEqual({
            action: 'expense', amount: 89.9, reason: 'card_purchase',
        });
    });

    // A refund has no representation in the app, so it must reduce spending rather
    // than be dropped or counted as income.
    test('refund becomes a negative expense so it nets out', () => {
        expect(classifyRow(cardRow({ charged_amount: 120 }))).toEqual({
            action: 'expense', amount: -120, reason: 'card_refund',
        });
    });

    test('card rows are never classified as income', () => {
        for (const amount of [-500, -1, 0, 1, 500]) {
            expect(classifyRow(cardRow({ charged_amount: amount })).action).toBe('expense');
        }
    });
});

describe('classifyRow — no double counting', () => {
    const settlement = bankRow({ charged_amount: -7892, description: '2624 - ישראכרט בע"מ' });

    test('bank settlement is skipped when that card is connected', () => {
        const result = classifyRow(settlement, new Set(['isracard']));
        expect(result.action).toBe('skip');
        expect(result.reason).toBe('settlement_of_isracard');
    });

    test('bank settlement is IMPORTED when the card is not connected, so money never vanishes', () => {
        expect(classifyRow(settlement, new Set()).action).toBe('expense');
    });

    test('a different connected card does not cause a skip', () => {
        expect(classifyRow(settlement, new Set(['max'])).action).toBe('expense');
    });
});

describe('reimbursements are not income', () => {
    // You pay ₪200 for a shared meal, friends send ₪50 each via Bit. That money
    // reverses spending — booking it as income inflates earnings and, via
    // max(variable_actual, variable_avg), inflates future P&L forecasts too.
    test('a Bit credit becomes a negative expense', () => {
        const row = { company_id: 'otsarHahayal', charged_amount: 150, description: 'זיכוי מביט מאילון גרינברג' };
        expect(classifyRow(row)).toEqual({ action: 'expense', amount: -150, reason: 'reimbursement' });
    });

    test('a bounced transfer credited back becomes a negative expense', () => {
        const row = { company_id: 'otsarHahayal', charged_amount: 2100, description: 'החזר זיכוי' };
        expect(classifyRow(row).reason).toBe('reimbursement');
        expect(classifyRow(row).amount).toBe(-2100);
    });

    test('genuine income is still income', () => {
        const row = { company_id: 'otsarHahayal', charged_amount: 2687.6, description: 'אי-טייפ אומניטק' };
        expect(classifyRow(row).action).toBe('income');
    });

    // Regression: "ביט" is a substring of "ביטוח" (insurance). Matching the bare word
    // would turn a ₪1,000 insurance payment into a reimbursement.
    test.each([
        'מגדל חברה לביטוח',
        'מגדל חברה לביטו',
        'כלל חיים/בריאות',
    ])('%s is not a refund', (description) => {
        expect(isRefund(description)).toBe(false);
    });

    test('insurance debits are unaffected', () => {
        const row = { company_id: 'otsarHahayal', charged_amount: -1000, description: 'מגדל חברה לביטו' };
        expect(classifyRow(row)).toEqual({ action: 'expense', amount: 1000, reason: 'bank_debit' });
    });

    test('card rows are unaffected by refund patterns', () => {
        const row = { company_id: 'isracard', charged_amount: -50, description: 'זיכוי מביט' };
        expect(classifyRow(row).reason).toBe('card_purchase');
    });

    test('handles a missing description', () => {
        expect(isRefund(undefined)).toBe(false);
    });
});

describe('settlementIssuerOf', () => {
    test.each([
        ['2624 - ישראכרט בע"מ', 'isracard'],
        ['מקס איט פיננסים', 'max'],
        ['ויזה כאל', 'visaCal'],
        ['אמריקן אקספרס', 'amex'],
    ])('%s → %s', (description, expected) => {
        expect(settlementIssuerOf(description)).toBe(expected);
    });

    // Regression: "כאל" is a substring of ordinary Hebrew words such as מיכאל.
    // A false match here would silently delete a real transaction.
    test.each([
        'העברה למיכאל כהן',
        'מגדל חברה לביטוח',
        'כלל פנסיה וגמל',
        'משכורת',
    ])('%s is not a settlement', (description) => {
        expect(settlementIssuerOf(description)).toBeNull();
    });

    test('handles missing description', () => {
        expect(settlementIssuerOf(undefined)).toBeNull();
        expect(settlementIssuerOf('')).toBeNull();
    });
});

describe('hashTxn — deduplication identity', () => {
    const base = {
        accountNumber: '123', date: '2026-05-16',
        chargedAmount: -1000, description: 'מגדל', occurrence: 0,
    };

    test('same transaction hashes identically across syncs', () => {
        expect(hashTxn(base)).toBe(hashTxn({ ...base }));
    });

    test.each([
        ['account', { accountNumber: '999' }],
        ['date', { date: '2026-05-17' }],
        ['amount', { chargedAmount: -1001 }],
        ['description', { description: 'אחר' }],
    ])('a different %s is a different transaction', (_label, diff) => {
        expect(hashTxn({ ...base, ...diff })).not.toBe(hashTxn(base));
    });

    test('two identical same-day purchases stay separate rows', () => {
        // Two ₪19.90 coffees at the same shop on the same day are two expenses.
        expect(hashTxn({ ...base, occurrence: 0 })).not.toBe(hashTxn({ ...base, occurrence: 1 }));
    });

    test('re-syncing the same list reproduces the same hashes', () => {
        expect(hashTxn({ ...base, occurrence: 1 })).toBe(hashTxn({ ...base, occurrence: 1 }));
    });

    test('occurrence defaults to 0', () => {
        const { occurrence, ...withoutOccurrence } = base;
        expect(hashTxn(withoutOccurrence)).toBe(hashTxn(base));
    });

    // Regression: txn.identifier is NOT a transaction id on Otsar HaHayal — it identifies
    // the counterparty, so 51 real transactions shared just 11 identifiers. Keying dedup
    // on it merged distinct transactions. Identity must not depend on it.
    test('ignores the provider identifier entirely', () => {
        expect(hashTxn({ ...base, identifier: 602 })).toBe(hashTxn({ ...base, identifier: 99999 }));
    });

    test('transactions sharing an identifier remain distinct', () => {
        const may = { ...base, identifier: 13795, date: '2026-05-16', chargedAmount: -145.85 };
        const june = { ...base, identifier: 13795, date: '2026-06-16', chargedAmount: -25.9 };
        expect(hashTxn(may)).not.toBe(hashTxn(june));
    });
});

describe('txnDateOf — rows land on the real bank date', () => {
    test('accepts a Date', () => {
        expect(txnDateOf({ txn_date: new Date('2026-06-14T00:00:00Z') })).toBe('2026-06-14');
    });

    test('accepts a string', () => {
        expect(txnDateOf({ txn_date: '2026-06-14' })).toBe('2026-06-14');
    });

    // mysql2 hands a DATE column back as midnight in the PROCESS timezone. Reading it
    // with toISOString() re-interprets that midnight as UTC, so on any container east
    // of UTC the date slipped back a day.
    test('reads a DATE column by local components, not UTC', () => {
        const midnightLocal = new Date(2026, 5, 14, 0, 0, 0);
        expect(txnDateOf({ txn_date: midnightLocal })).toBe('2026-06-14');
    });
});

/**
 * Regression: the scraper reports each transaction's date as Israel-local midnight
 * expressed in UTC, so `2026-08-09T00:00+03:00` arrives as `2026-08-08T21:00:00.000Z`.
 * Truncating that in UTC dated every single imported transaction one day early — all
 * 177 rows in the first production backfill — and pushed month-boundary transactions
 * into the wrong month's summaries, budgets and P&L.
 */
describe('bankDateOf — the scraper timestamp is read in the bank timezone', () => {
    test('Israel midnight expressed in UTC keeps its own calendar day', () => {
        expect(bankDateOf('2026-08-08T21:00:00.000Z')).toBe('2026-08-09');
    });

    test('a transaction on the 1st does not fall back into the previous month', () => {
        expect(bankDateOf('2026-08-31T21:00:00.000Z')).toBe('2026-09-01');
    });

    test('winter time (UTC+2) resolves too', () => {
        expect(bankDateOf('2026-01-14T22:00:00.000Z')).toBe('2026-01-15');
    });

    test('a mid-day timestamp stays on its own day', () => {
        expect(bankDateOf('2026-06-14T09:30:00.000Z')).toBe('2026-06-14');
    });

    test('output is a MySQL DATE literal', () => {
        expect(bankDateOf('2026-08-08T21:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    // The dedup hash keys on the raw scraper string, not on this formatted date, so
    // correcting the formatting cannot change any existing row's identity.
    test('correcting the date does not disturb dedup identity', () => {
        const raw = '2026-08-08T21:00:00.000Z';
        const txn = { accountNumber: '1', date: raw, chargedAmount: -10, description: 'x' };
        expect(hashTxn(txn)).toBe(hashTxn({ ...txn }));
        expect(hashTxn(txn)).not.toBe(hashTxn({ ...txn, date: bankDateOf(raw) }));
    });
});

/**
 * Regression: a connection that failed once was excluded from the sync cycle forever
 * (the query only accepted 'pending_first_sync' and 'active'), while the failure
 * notification promised "SmartFin will try again on the next scheduled sync". One bank
 * timeout silently stopped that connection until the user pressed Sync now.
 */
describe('which connections are due for a sync', () => {
    test('an errored connection is retried', () => {
        expect(DUE_CONNECTIONS_QUERY).toContain("status = 'error'");
    });

    test('a rejected password is NOT retried — that risks locking the bank account', () => {
        expect(DUE_CONNECTIONS_QUERY).not.toContain('invalid_credentials');
    });

    test('the retry is paced by the last attempt, not the last success', () => {
        // last_sync_at must keep pointing at the last SUCCESS or the incremental window
        // shrinks past a run of failures and transactions are missed.
        expect(DUE_CONNECTIONS_QUERY).toMatch(/status = 'error'\s+AND \(last_attempt_at IS NULL OR last_attempt_at < \?\)/);
    });
});

describe('syncWindowStart — how far back a scrape reaches', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.parse('2026-08-13T12:00:00Z');

    test('a never-synced connection backfills three months', () => {
        const start = syncWindowStart({ last_sync_at: null }, now);
        expect(Math.round((now - start.getTime()) / DAY)).toBe(90);
    });

    test('a synced connection overlaps three days for late-settling rows', () => {
        const lastSync = '2026-08-12T03:00:00Z';
        const start = syncWindowStart({ last_sync_at: lastSync }, now);
        expect(Math.round((Date.parse(lastSync) - start.getTime()) / DAY)).toBe(3);
    });

    // A connection whose FIRST sync failed sits in 'error', not 'pending_first_sync'.
    // Keying the window on status looked back 3 days and skipped the whole backfill.
    test('a connection whose first sync failed still gets the full backfill', () => {
        const errored = { status: 'error', last_sync_at: null, last_attempt_at: new Date(now) };
        const start = syncWindowStart(errored, now);
        expect(Math.round((now - start.getTime()) / DAY)).toBe(90);
    });
});

describe('bankCompanies config', () => {
    test('every company declares a kind and login fields', () => {
        for (const [id, c] of Object.entries(bankCompanies)) {
            expect(['bank', 'card']).toContain(c.kind);
            expect(c.loginFields.length).toBeGreaterThan(0);
            expect(typeof c.name).toBe('string');
            expect(id).toBeTruthy();
        }
    });

    test('card issuers that can appear as a bank settlement are all supported', () => {
        for (const issuer of ['isracard', 'max', 'visaCal', 'amex']) {
            expect(bankCompanies[issuer]?.kind).toBe('card');
        }
    });

    // The config is passed straight to createScraper(), so a mismatch with the library
    // means a login form that collects the wrong fields and a scrape that always fails.
    describe('matches israeli-bank-scrapers definitions', () => {
        const { SCRAPERS } = require('israeli-bank-scrapers/lib/definitions');

        test.each(Object.keys(require('../../backend/src/config/bankCompanies')))(
            '%s exists in the library with identical loginFields',
            (id) => {
                expect(SCRAPERS[id]).toBeDefined();
                expect(bankCompanies[id].loginFields).toEqual(SCRAPERS[id].loginFields);
            }
        );

        // One Zero needs an otpCodeRetriever callback, which a credentials form cannot
        // supply — exposing it would render a login that can never succeed.
        test('omits providers requiring a 2FA callback', () => {
            expect(bankCompanies.oneZero).toBeUndefined();
            expect(SCRAPERS.oneZero.loginFields).toContain('otpCodeRetriever');
        });

        test('every other supported provider is exposed', () => {
            const missing = Object.keys(SCRAPERS).filter(
                (id) => !bankCompanies[id] && !SCRAPERS[id].loginFields?.includes('otpCodeRetriever')
            );
            expect(missing).toEqual([]);
        });
    });
});

/**
 * Regression: bank_transactions_raw.expense_id / income_id were plain foreign keys,
 * which MySQL defaults to ON DELETE RESTRICT — so deleting a bank-imported expense in
 * the web UI failed with a 500 for every row bank sync had ever created. Migration 004
 * re-points both at ON DELETE SET NULL; the staged row survives unlinked, and since it
 * stays import_status='imported' it is never re-imported.
 */
describe('a bank-imported expense can be deleted', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (f) => fs.readFileSync(path.join(__dirname, '../../db', f), 'utf8');

    test('init.sql declares both links ON DELETE SET NULL', () => {
        const schema = read('init.sql');
        expect(schema).toMatch(/fk_btr_expense FOREIGN KEY \(expense_id\).*ON DELETE SET NULL/);
        expect(schema).toMatch(/fk_btr_income\s+FOREIGN KEY \(income_id\).*ON DELETE SET NULL/);
    });

    test('migration 007 exists and is guarded so it can be re-run', () => {
        const migration = read('migrate_007_bank_sync_fixes.sql');
        expect(migration).toContain('ON DELETE SET NULL');
        expect(migration).toContain('INFORMATION_SCHEMA');
    });

    // db/ already contains two different migrate_003_* and two migrate_004_* files,
    // which makes "apply them in order" ambiguous and lets one silently go unapplied.
    // New migrations must claim an unused number.
    test('no two migrations share a number', () => {
        const fs = require('fs');
        const path = require('path');
        const numbers = fs.readdirSync(path.join(__dirname, '../../db'))
            .map((f) => /^migrate_(\d+)_/.exec(f))
            .filter(Boolean)
            .map((m) => m[1]);
        const duplicated = [...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i))];

        // 003 is a pre-existing collision (migrate_003_bank_sync vs
        // migrate_003_telegram_chat_id), recorded here rather than hidden. Anything new
        // showing up in this list is a mistake — pick the next free number.
        expect(duplicated.sort()).toEqual(['003']);
    });

    test('the schema carries the columns the scheduler now writes', () => {
        const schema = read('init.sql');
        expect(schema).toContain('last_attempt_at');
        expect(schema).toContain('import_attempts');
    });
});

describe('credential encryption', () => {
    test('round-trips credentials', () => {
        const creds = JSON.stringify({ username: 'u', password: 'p«ç' });
        expect(decrypt(encrypt(creds))).toBe(creds);
    });

    test('encrypting twice yields different ciphertext (random IV)', () => {
        expect(encrypt('same')).not.toBe(encrypt('same'));
    });

    test('rejects a tampered payload', () => {
        const enc = encrypt('secret');
        const [iv, tag, ct] = enc.split(':');
        expect(() => decrypt([iv, tag, Buffer.from('evil').toString('base64')].join(':'))).toThrow();
    });

    test('rejects a malformed payload', () => {
        expect(() => decrypt('not-valid')).toThrow('Malformed encrypted payload');
    });
});
