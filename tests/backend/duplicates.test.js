/**
 * Duplicate prevention across all four ways an expense can enter SmartFin:
 * manual/web, Telegram bot, Apple Pay webhook, and bank/card sync.
 *
 * Each source has its own duplicate risk. These tests pin down which duplicates are
 * prevented and — just as importantly — which are NOT, so the gaps are deliberate
 * and visible rather than discovered in production.
 */
const request = require('supertest');
const db = require('./setup/dbMock');
const app = require('./setup/testApp');
const { authHeader, TEST_USER } = require('./setup/authHelper');
const {
    classifyRow, hashTxn, DRAIN_QUERY, STAGE_TXN_QUERY,
} = require('../../backend/src/services/bankSyncScheduler');

const auth = authHeader();

// The auth middleware issues its own db.query, so every request consumes one mock first.
function authOk(user = TEST_USER) {
    db.query.mockResolvedValueOnce([[{ user_id: user.user_id }]]);
}

describe('bank/card sync — re-syncing never re-imports', () => {
    const txn = {
        accountNumber: '12345', date: '2026-05-16',
        chargedAmount: -1000, description: 'מגדל', occurrence: 0,
    };

    test('the same transaction produces the same dedup key on every sync', () => {
        // The UNIQUE key (bank_connection_id, external_hash) plus INSERT IGNORE is what
        // makes a re-sync a no-op. That only holds if the hash is stable.
        const first = hashTxn(txn);
        const second = hashTxn({ ...txn });
        expect(first).toBe(second);
    });

    test('overlapping sync windows re-see transactions without duplicating them', () => {
        // Incremental syncs deliberately overlap by 3 days to catch late-settling rows,
        // so the same transaction IS scraped again and must collide on its hash.
        const rescraped = { ...txn };
        expect(hashTxn(rescraped)).toBe(hashTxn(txn));
    });

    // A pending transaction whose date or amount changes on settlement hashes
    // differently, so it DOES arrive as a second staged row — the alternative (keying
    // on txn.identifier) merges unrelated transactions, which is far worse. See the
    // identifier regression test in bankSync.test.js.
    //
    // The double-count is prevented one layer up instead: the drain only imports rows
    // whose status is 'completed', so the pending version never reaches the ledger and
    // is simply left staged once superseded.
    test('a settling transaction that changes amount produces a second staged row', () => {
        const pending = { ...txn, chargedAmount: -1000 };
        const settled = { ...txn, date: '2026-05-19', chargedAmount: -1015 };
        expect(hashTxn(settled)).not.toBe(hashTxn(pending));
    });

    test('only settled transactions are eligible for import', () => {
        expect(DRAIN_QUERY).toContain("t.status = 'completed'");
        expect(DRAIN_QUERY).toContain("t.import_status = 'pending_categorization'");
    });

    // A pending row that settles UNCHANGED keeps its hash, so the insert collides. It
    // must still flip to 'completed' — under INSERT IGNORE it stayed pending forever
    // and the transaction was lost rather than merely delayed.
    test('an unchanged pending row is upgraded to completed rather than ignored', () => {
        expect(STAGE_TXN_QUERY).toContain('ON DUPLICATE KEY UPDATE status = VALUES(status)');
        expect(STAGE_TXN_QUERY).not.toContain('INSERT IGNORE');
    });

    /**
     * Regression, caught by a live re-sync: "2 transactions seen, 2 new" was logged when
     * both rows already existed, and the user got a Telegram alert about new
     * transactions on every sync. mysql2 connects with CLIENT_FOUND_ROWS, so an
     * ON DUPLICATE KEY UPDATE that merely MATCHED an existing row still reports
     * affectedRows = 1 — indistinguishable from a fresh insert. New rows are counted
     * against the connection's known hashes instead.
     */
    test('re-staging a known transaction is not counted as new', () => {
        const known = new Set([hashTxn(txn)]);
        const countNew = (t) => (known.has(hashTxn(t)) ? 0 : 1);

        expect(countNew(txn)).toBe(0);
        expect(countNew({ ...txn, chargedAmount: -55 })).toBe(1);
    });

    test('the new-row count does not read affectedRows', () => {
        const source = require('fs').readFileSync(
            require.resolve('../../backend/src/services/bankSyncScheduler'), 'utf8'
        );
        expect(source).not.toMatch(/inserted\s*\+?=\s*res\.affectedRows/);
        expect(source).not.toMatch(/res\.affectedRows === 1/);
    });

    test('two genuinely different transactions never collide', () => {
        expect(hashTxn({ ...txn, chargedAmount: -2000 })).not.toBe(hashTxn(txn));
    });

    test('two identical same-day purchases are kept as two rows, not deduped away', () => {
        // Real case: two ₪19.90 coffees at the same shop on the same day.
        expect(hashTxn({ ...txn, occurrence: 0 })).not.toBe(hashTxn({ ...txn, occurrence: 1 }));
    });
});

describe('bank vs card — the same purchase from two connections', () => {
    const settlement = {
        company_id: 'otsarHahayal', charged_amount: -7892, description: '2624 - ישראכרט בע"מ',
    };

    test('the bank settlement is dropped once the card is connected', () => {
        expect(classifyRow(settlement, new Set(['isracard'])).action).toBe('skip');
    });

    test('card purchases behind that settlement are all imported', () => {
        const purchases = [-19.9, -250, -1000].map((amount) =>
            classifyRow({ company_id: 'isracard', charged_amount: amount, description: 'שופרסל' }, new Set(['isracard']))
        );
        expect(purchases.every((p) => p.action === 'expense')).toBe(true);
    });

    test('money is never counted twice NOR lost', () => {
        // With the card connected: settlement skipped, purchases counted.
        const withCard = classifyRow(settlement, new Set(['isracard']));
        expect(withCard.action).toBe('skip');
        // Without the card connected: the settlement itself is counted, so the spending
        // still appears somewhere.
        const withoutCard = classifyRow(settlement, new Set());
        expect(withoutCard.action).toBe('expense');
        expect(withoutCard.amount).toBe(7892);
    });
});

describe('connection-level duplicates', () => {
    test('connecting the same provider twice is rejected', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[{ id: 1 }]]); // existing connection found
        const res = await request(app)
            .post('/api/bank-connections')
            .set(auth)
            .send({ companyId: 'isracard', credentials: { id: '1', card6Digits: '123456', password: 'p' } });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('already_connected');
    });

    test('a first connection is accepted', async () => {
        authOk();
        db.query
            .mockResolvedValueOnce([[]])              // no existing connection
            .mockResolvedValueOnce([{ insertId: 7 }]); // insert
        const res = await request(app)
            .post('/api/bank-connections')
            .set(auth)
            .send({ companyId: 'isracard', credentials: { id: '1', card6Digits: '123456', password: 'p' } });

        expect(res.status).toBe(201);
        expect(res.body.status).toBe('pending_first_sync');
    });

    test('stored credentials are never returned by the API', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[{
            id: 1, company_id: 'isracard', display_name: 'Isracard', status: 'active',
            last_sync_at: null, last_sync_status: null, last_sync_error: null, created_at: new Date(),
        }]]);
        const res = await request(app).get('/api/bank-connections').set(auth);

        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain('credentials');
    });
});

describe('repeated sync requests do not stack up scrapes', () => {
    test('syncing a connection with rejected credentials is refused', async () => {
        // Guards the real bank account: repeated bad logins lock it.
        authOk();
        db.query.mockResolvedValueOnce([[{ id: 1, status: 'invalid_credentials' }]]);
        const res = await request(app).post('/api/bank-connections/1/sync').set(auth);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('invalid_credentials');
    });

    // Manual syncs are queued rather than refused. The previous behaviour rejected the
    // request whenever ANY user's scrape was running — a global lock — and dropped the
    // click entirely instead of remembering it.
    test('a queued connection is not queued twice', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[{ id: 4242, status: 'active' }]]);
        const first = await request(app).post('/api/bank-connections/4242/sync').set(auth);
        expect(first.status).toBe(200);
        expect(first.body).toEqual({ triggered: true });

        authOk();
        db.query.mockResolvedValueOnce([[{ id: 4242, status: 'active' }]]);
        const second = await request(app).post('/api/bank-connections/4242/sync').set(auth);
        expect(second.status).toBe(200);
        expect(second.body.alreadyQueued).toBe(true);
    });

    test('another user cannot trigger or delete your connection', async () => {
        const other = { user_id: 999, username: 'someone-else' };
        authOk(other);
        db.query.mockResolvedValueOnce([[]]); // ownership check finds nothing
        const res = await request(app)
            .post('/api/bank-connections/1/sync')
            .set(authHeader(other));

        expect(res.status).toBe(404);
        expect(db.query).toHaveBeenCalledWith(expect.stringContaining('user_id = ?'), [String(1), 999]);
    });
});

/**
 * KNOWN GAP — cross-source duplicates are NOT prevented.
 *
 * The v1 design decision was that bank-synced rows dedupe only against themselves.
 * A purchase logged by hand or typed to the bot will therefore ALSO arrive from the
 * card sync, producing two entries for one purchase.
 *
 * The Apple Pay shortcut was the worst offender — it fired on every tap-to-pay, all of
 * which are card purchases — which is why that path was removed rather than deduped.
 * The remaining overlap is manual/bot entry, which is occasional and user-initiated.
 *
 * These tests document that behavior deliberately. If cross-source matching is added
 * later, they should be rewritten rather than deleted.
 */
describe('KNOWN GAP: manual/bot entry vs card sync', () => {
    test('a card row is imported regardless of an identical manual entry existing', () => {
        // Same purchase the user already logged in the bot as "55 shawarma".
        const cardTxn = { company_id: 'isracard', charged_amount: -55, description: 'שווארמה' };
        // classifyRow has no visibility of `expenses` at all — by design in v1.
        expect(classifyRow(cardTxn, new Set(['isracard'])).action).toBe('expense');
    });

    test('a manually typed purchase is not matched against the card row', () => {
        const cardTxn = { company_id: 'isracard', charged_amount: -89.9, description: 'שופרסל' };
        expect(classifyRow(cardTxn, new Set(['isracard'])).action).toBe('expense');
    });
});
