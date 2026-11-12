const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { authHeader, TEST_USER } = require('./setup/authHelper');
const { shapeBalances } = require('../../backend/src/controllers/bankConnectionController');
const { BALANCE_SNAPSHOT_QUERY } = require('../../backend/src/services/bankSyncScheduler');

const snap = (date, balance, over = {}) => ({
    bank_connection_id: 9, account_number: '12-345-67890_12', is_savings: 0, snapshot_date: date,
    balance: String(balance), currency: 'ILS', synced_at: `${date}T11:33:00.000Z`, company_id: 'leumi', display_name: null, ...over,
});

describe('shapeBalances', () => {
    test('latest balance per account, change since the previous snapshot, last 4 digits only', () => {
        const out = shapeBalances([snap('2026-11-07', 14250.5), snap('2026-11-06', 14836.53), snap('2026-11-05', 15000)]);
        expect(out.current_total).toBe(14250.5);
        expect(out.accounts[0]).toMatchObject({
            bank: 'Bank Leumi', account: '9012', balance: 14250.5,
            previous: { date: '2026-11-06', balance: 14836.53 }, change: -586.03,
        });
        expect(out.accounts[0].history.map(h => h.date)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07']);
        expect(JSON.stringify(out)).not.toContain('12-345-67890');
    });

    test('savings deposits are reported apart from the current account', () => {
        const out = shapeBalances([snap('2026-11-07', 14000), snap('2026-11-07', 5000, { account_number: '12-345-67890_12-777', is_savings: 1 })]);
        expect(out.current_total).toBe(14000);
        expect(out.savings_total).toBe(5000);
    });

    test('a card balance (Max reports the amount owed) is never added to the bank balance', () => {
        const out = shapeBalances([
            snap('2026-11-07', 1500, { bank_connection_id: 3, company_id: 'otsarHahayal', account_number: '6453' }),
            snap('2026-11-07', -4378, { bank_connection_id: 4, company_id: 'max', account_number: '6924' }),
        ]);
        expect(out.current_total).toBe(1500);
        expect(out.accounts.map(a => a.account)).toEqual(['6453']);
    });

    test('only card snapshots → null total, so the card stays hidden', () => {
        expect(shapeBalances([snap('2026-11-07', -4378, { company_id: 'max' })]).current_total).toBeNull();
    });

    test('no snapshots yet → null total, so the card stays hidden', () => {
        expect(shapeBalances([])).toMatchObject({ current_total: null, accounts: [] });
    });

    test('first snapshot has no change to report', () => {
        expect(shapeBalances([snap('2026-11-07', 100)]).accounts[0]).toMatchObject({ previous: null, change: null });
    });
});

describe('GET /api/bank-connections/balances', () => {
    test('returns the caller\'s balances, scoped by user on both tables', async () => {
        db.query
            .mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]])
            .mockResolvedValueOnce([[snap('2026-11-07', 14250.5)]]);
        const res = await request(app).get('/api/bank-connections/balances').set(authHeader());
        expect(res.status).toBe(200);
        expect(res.body.current_total).toBe(14250.5);
        const [sql, params] = db.query.mock.calls[1];
        expect(sql).toMatch(/s\.user_id = \?/);
        expect(sql).toMatch(/c\.user_id = s\.user_id/);
        expect(params).toEqual([TEST_USER.user_id]);
    });

    test('requires auth', async () => {
        expect((await request(app).get('/api/bank-connections/balances')).status).toBe(401);
    });
});

test('a same-day re-sync overwrites the snapshot instead of adding a row', () => {
    expect(BALANCE_SNAPSHOT_QUERY).toMatch(/ON DUPLICATE KEY UPDATE balance = VALUES\(balance\)/);
});
