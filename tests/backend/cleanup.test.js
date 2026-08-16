const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { authHeader, TEST_USER } = require('./setup/authHelper');

const d = (iso) => { const [y, m, day] = iso.split('-').map(Number); return new Date(y, m - 1, day); };

// clearMocks wipes the resolution dbMock sets at module load, so re-arm it per test.
beforeEach(() => {
    db.getConnection.mockResolvedValue(db._conn);
});

/**
 * getDuplicates issues: auth, then four loaders in a Promise.all —
 * logged expenses, synced expenses, logged income, synced income.
 */
function mockScan({ loggedExp = [], syncedExp = [], loggedInc = [], syncedInc = [] } = {}) {
    db.query
        .mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]])   // auth
        .mockResolvedValueOnce([loggedExp])
        .mockResolvedValueOnce([syncedExp])
        .mockResolvedValueOnce([loggedInc])
        .mockResolvedValueOnce([syncedInc]);
}

const loggedRow = (id, amount, date, extra = {}) => ({
    id, amount, date: d(date), description: `logged ${id}`, source: 'bot', category_id: null, ...extra,
});
const syncedRow = (id, amount, date, extra = {}) => ({
    id, amount, date: d(date), description: `synced ${id}`, account: '2624', ...extra,
});

describe('GET /api/cleanup/duplicates', () => {
    it('requires auth', async () => {
        const res = await request(app).get('/api/cleanup/duplicates');
        expect(res.status).toBe(401);
    });

    it('returns the pairs, not just a count', async () => {
        // The user is approving irreversible deletions, so the evidence for each one has
        // to reach the UI.
        mockScan({
            loggedExp: [loggedRow(1, '55.00', '2026-06-12')],
            syncedExp: [syncedRow(90, '55.00', '2026-06-13', { description: 'שווארמה הקסם' })],
        });

        const res = await request(app).get('/api/cleanup/duplicates').set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body.expenses.matched_count).toBe(1);
        expect(res.body.expenses.matched[0].id).toBe(1);
        expect(res.body.expenses.matched[0].match.description).toBe('שווארמה הקסם');
    });

    it('reports rows with no counterpart as kept', async () => {
        mockScan({
            loggedExp: [loggedRow(1, '55.00', '2026-06-12'), loggedRow(2, '80.00', '2026-06-12')],
            syncedExp: [syncedRow(90, '55.00', '2026-06-12')],
        });

        const res = await request(app).get('/api/cleanup/duplicates').set(authHeader());

        expect(res.body.expenses.matched_count).toBe(1);
        expect(res.body.expenses.unmatched_count).toBe(1);
        expect(res.body.expenses.unmatched_amount).toBe(80);
    });

    it('flags when nothing has been imported, so an empty result can be explained', async () => {
        mockScan({ loggedExp: [loggedRow(1, '55.00', '2026-06-12')] });

        const res = await request(app).get('/api/cleanup/duplicates').set(authHeader());

        expect(res.body.has_synced_data).toBe(false);
        expect(res.body.expenses.matched_count).toBe(0);
    });

    it('matches income as well as expenses', async () => {
        // A double-counted salary distorts P&L far more than a double-counted coffee.
        mockScan({
            loggedInc: [loggedRow(7, '15000.00', '2026-06-01')],
            syncedInc: [syncedRow(95, '15000.00', '2026-06-01')],
        });

        const res = await request(app).get('/api/cleanup/duplicates').set(authHeader());

        expect(res.body.income.matched_count).toBe(1);
        expect(res.body.income.matched[0].match.id).toBe(95);
    });
});

describe('POST /api/cleanup/duplicates', () => {
    it('rejects an empty selection', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]);

        const res = await request(app)
            .post('/api/cleanup/duplicates')
            .set(authHeader())
            .send({ expense_ids: [], income_ids: [] });

        expect(res.status).toBe(400);
    });

    it('archives only the ids the user ticked', async () => {
        // Two rows are duplicates; the user approved one. The other must survive.
        mockScan({
            loggedExp: [loggedRow(1, '55.00', '2026-06-12'), loggedRow(2, '80.00', '2026-06-12')],
            syncedExp: [syncedRow(90, '55.00', '2026-06-12'), syncedRow(91, '80.00', '2026-06-12')],
        });
        db._conn.query.mockResolvedValue([{ affectedRows: 1 }]);
        db.query.mockResolvedValue([[{ COLUMN_NAME: 'expense_id' }, { COLUMN_NAME: 'user_id' }]]);

        const res = await request(app)
            .post('/api/cleanup/duplicates')
            .set(authHeader())
            .send({ expense_ids: [1] });

        expect(res.status).toBe(200);
        expect(res.body.removed_expenses).toBe(1);
        expect(res.body.batch_id).toMatch(/^[0-9a-f-]{36}$/);

        const deletes = db._conn.query.mock.calls.filter(([sql]) => /^\s*DELETE FROM expenses/.test(sql));
        expect(deletes).toHaveLength(1);
        expect(deletes[0][1]).toEqual([1, TEST_USER.user_id]);
    });

    it('refuses an id that is no longer a duplicate', async () => {
        // A stale tab must not be able to delete a row whose counterpart vanished.
        mockScan({
            loggedExp: [loggedRow(1, '55.00', '2026-06-12')],
            syncedExp: [],
        });

        const res = await request(app)
            .post('/api/cleanup/duplicates')
            .set(authHeader())
            .send({ expense_ids: [1] });

        expect(res.status).toBe(409);
        expect(res.body.rejected).toBe(1);
        expect(db._conn.beginTransaction).not.toHaveBeenCalled();
    });

    it('never widens the deletion beyond what was approved', async () => {
        // Sync imported a second duplicate between preview and confirm. Only the
        // approved id may go — consent does not stretch to cover the newcomer.
        mockScan({
            loggedExp: [loggedRow(1, '55.00', '2026-06-12'), loggedRow(2, '80.00', '2026-06-12')],
            syncedExp: [syncedRow(90, '55.00', '2026-06-12'), syncedRow(91, '80.00', '2026-06-12')],
        });
        db._conn.query.mockResolvedValue([{ affectedRows: 1 }]);
        db.query.mockResolvedValue([[{ COLUMN_NAME: 'expense_id' }]]);

        const res = await request(app)
            .post('/api/cleanup/duplicates')
            .set(authHeader())
            .send({ expense_ids: [1] });

        expect(res.body.removed_expenses).toBe(1);
    });

    it("copies the user's category onto the imported row before removing theirs", async () => {
        // The import guesses a category from the merchant name; the user's own choice is
        // better evidence. Without this, cleanup silently undoes months of categorising.
        mockScan({
            loggedExp: [loggedRow(1, '55.00', '2026-06-12', { category_id: 3 })],
            syncedExp: [syncedRow(90, '55.00', '2026-06-12')],
        });
        db._conn.query.mockResolvedValue([{ affectedRows: 1 }]);
        db.query.mockResolvedValue([[{ COLUMN_NAME: 'expense_id' }]]);

        await request(app)
            .post('/api/cleanup/duplicates')
            .set(authHeader())
            .send({ expense_ids: [1] });

        const update = db._conn.query.mock.calls.find(([sql]) => /UPDATE expenses SET category_id/.test(sql));
        expect(update).toBeDefined();
        expect(update[1]).toEqual([3, 90, TEST_USER.user_id]);
        // Only fills a gap — never overwrites a category the import already got right.
        expect(update[0]).toMatch(/category_id IS NULL/);
    });

    it('rolls back and reports failure if archiving throws', async () => {
        mockScan({
            loggedExp: [loggedRow(1, '55.00', '2026-06-12')],
            syncedExp: [syncedRow(90, '55.00', '2026-06-12')],
        });
        db.query.mockResolvedValue([[{ COLUMN_NAME: 'expense_id' }]]);
        db._conn.query.mockRejectedValue(new Error('disk on fire'));

        const res = await request(app)
            .post('/api/cleanup/duplicates')
            .set(authHeader())
            .send({ expense_ids: [1] });

        expect(res.status).toBe(500);
        expect(db._conn.rollback).toHaveBeenCalled();
        expect(db._conn.commit).not.toHaveBeenCalled();
    });
});

describe('POST /api/cleanup/restore', () => {
    // Restore counts rows before and after the insert, so the connection mock has to
    // answer COUNT(*) queries with a real number rather than an affectedRows blob.
    const mockRestore = ({ archived = 3, live = 3 } = {}) => {
        db._conn.query.mockImplementation((sql) => {
            if (/SELECT COUNT\(\*\) AS n FROM deleted_/.test(sql)) return Promise.resolve([[{ n: archived }]]);
            if (/SELECT COUNT\(\*\) AS n FROM/.test(sql)) return Promise.resolve([[{ n: live }]]);
            return Promise.resolve([{ affectedRows: archived }]);
        });
    };

    it('rejects a request naming nothing', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]);

        const res = await request(app).post('/api/cleanup/restore').set(authHeader()).send({});

        expect(res.status).toBe(400);
    });

    it('restores a whole batch', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]);
        db.query.mockResolvedValue([[{ COLUMN_NAME: 'expense_id' }, { COLUMN_NAME: 'user_id' }]]);
        mockRestore({ archived: 3, live: 3 });

        const res = await request(app)
            .post('/api/cleanup/restore')
            .set(authHeader())
            .send({ batch_id: 'b1b2c3d4-0000-0000-0000-000000000000' });

        expect(res.status).toBe(200);
        expect(res.body.restored_expenses).toBe(3);

        // Restore puts rows back under their ORIGINAL ids, so anything that referenced
        // them still points at the same row.
        const insert = db._conn.query.mock.calls.find(([sql]) => /INSERT IGNORE INTO expenses/.test(sql));
        expect(insert[0]).toMatch(/`expense_id`/);
        expect(insert[0]).toMatch(/FROM deleted_expenses/);
    });

    it('scopes the restore to the caller', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]);
        db.query.mockResolvedValue([[{ COLUMN_NAME: 'expense_id' }]]);
        mockRestore({ archived: 1, live: 1 });

        await request(app)
            .post('/api/cleanup/restore')
            .set(authHeader())
            .send({ expense_ids: [1] });

        const insert = db._conn.query.mock.calls.find(([sql]) => /INSERT IGNORE INTO expenses/.test(sql));
        expect(insert[0]).toMatch(/user_id = \?/);
        expect(insert[1][0]).toBe(TEST_USER.user_id);
    });

    it('leaves the archive intact if a row fails to land', async () => {
        // INSERT IGNORE downgrades a foreign-key failure to a warning. Dropping the
        // archive on that basis would destroy the only remaining copy of the row.
        db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]);
        db.query.mockResolvedValue([[{ COLUMN_NAME: 'expense_id' }]]);
        mockRestore({ archived: 3, live: 2 });

        const res = await request(app)
            .post('/api/cleanup/restore')
            .set(authHeader())
            .send({ batch_id: 'b1b2c3d4-0000-0000-0000-000000000000' });

        expect(res.status).toBe(500);
        expect(db._conn.rollback).toHaveBeenCalled();
        const deletes = db._conn.query.mock.calls.filter(([sql]) => /^DELETE FROM deleted_expenses/.test(sql));
        expect(deletes).toHaveLength(0);
    });
});
