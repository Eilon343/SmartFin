// Multi-tenancy guarantees.
//
// SmartFin is a shared instance: several people use one deployment and one
// database. These tests pin the invariants that keep their data apart. They
// exist because a real bug shipped — the Apple Pay webhook resolved the acting
// user from an env var instead of from the request, so a second user's expenses
// were written to the owner's account.
//
// Two distinct users are used throughout: ATTACKER is the caller, VICTIM owns
// the data the caller must never reach.

const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { authHeader, TEST_USER } = require('./setup/authHelper');

const ATTACKER = TEST_USER;                                  // user_id 42
const VICTIM = { user_id: 99, username: 'victim' };
const VICTIM_CATEGORY_ID = 87;                               // private to VICTIM

function authOk(user = ATTACKER) {
    db.query.mockResolvedValueOnce([[{ user_id: user.user_id }]]);
}

/** The ownership pre-check in categoryAllowed() finding nothing. */
function categoryDenied() {
    db.query.mockResolvedValueOnce([[]]);
}

/** Every SQL string the controller issued, for predicate assertions. */
function sqlCalls() {
    return db.query.mock.calls.map(([sql]) => sql);
}

// ── Writes may not reference another user's category ─────────────────────────
//
// The FK on category_id only proves the category exists. Without an ownership
// check a user could attach their own row to a victim's private category and
// then read the category NAME back out through the joins in the read paths —
// category names are user-authored and can be sensitive.

describe('cross-user category_id is rejected on write', () => {
    const cases = [
        {
            name: 'POST /api/expenses',
            send: () => request(app).post('/api/expenses').set(authHeader())
                .send({ amount: 50, description: 'x', category_id: VICTIM_CATEGORY_ID }),
        },
        {
            name: 'PUT /api/expenses/:id',
            send: () => request(app).put('/api/expenses/1').set(authHeader())
                .send({ amount: 50, description: 'x', category_id: VICTIM_CATEGORY_ID }),
        },
        {
            name: 'POST /api/budgets',
            send: () => request(app).post('/api/budgets').set(authHeader())
                .send({ category_id: VICTIM_CATEGORY_ID, monthly_limit: 500 }),
        },
        {
            name: 'POST /api/subscriptions',
            send: () => request(app).post('/api/subscriptions').set(authHeader())
                .send({ name: 'Netflix', amount: 39.9, day_of_month: 5, category_id: VICTIM_CATEGORY_ID }),
        },
        {
            name: 'PUT /api/subscriptions/:id',
            send: () => request(app).put('/api/subscriptions/1').set(authHeader())
                .send({ name: 'Netflix', amount: 39.9, day_of_month: 5, category_id: VICTIM_CATEGORY_ID }),
        },
    ];

    it.each(cases)('$name rejects a category the caller does not own', async ({ send }) => {
        authOk();
        categoryDenied();

        const res = await send();

        expect(res.status).toBe(400);
        // and crucially: no row was written
        expect(sqlCalls().some(s => /INSERT INTO|UPDATE (expenses|budgets|subscriptions)/.test(s))).toBe(false);
    });

    it('scopes the ownership check to base categories OR the caller', async () => {
        authOk();
        categoryDenied();

        await request(app).post('/api/expenses').set(authHeader())
            .send({ amount: 50, category_id: VICTIM_CATEGORY_ID });

        const check = db.query.mock.calls.find(([sql]) => sql.includes('FROM categories'));
        expect(check[0]).toMatch(/user_id IS NULL OR user_id = \?/);
        expect(check[1]).toEqual([VICTIM_CATEGORY_ID, ATTACKER.user_id]);
    });

    it('still allows a shared base category', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[{ 1: 1 }]]);   // category allowed
        db.query.mockResolvedValueOnce([{ insertId: 7 }]);

        const res = await request(app).post('/api/expenses').set(authHeader())
            .send({ amount: 50, category_id: 3 });

        expect(res.status).toBe(200);
        expect(res.body.expense_id).toBe(7);
    });

    it('allows an absent category_id without a lookup', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ insertId: 8 }]);

        const res = await request(app).post('/api/expenses').set(authHeader())
            .send({ amount: 50 });

        expect(res.status).toBe(200);
        expect(sqlCalls().some(s => s.includes('FROM categories'))).toBe(false);
    });
});

// ── Reads never join in a foreign category ───────────────────────────────────

describe('read paths scope the category join', () => {
    it('GET /api/expenses scopes the join to base-or-own categories', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[]]);

        await request(app).get('/api/expenses').set(authHeader());

        const q = db.query.mock.calls.find(([sql]) => sql.includes('FROM expenses e'));
        expect(q[0]).toMatch(/LEFT JOIN categories c ON .*AND \(c\.user_id IS NULL OR c\.user_id = \?\)/);
        expect(q[1][0]).toBe(ATTACKER.user_id);
    });

    it('GET /api/summary scopes the join', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[]]);

        await request(app).get('/api/expenses/summary?month=2026-04').set(authHeader());

        const q = db.query.mock.calls.find(([sql]) => sql.includes('FROM expenses e'));
        expect(q[0]).toMatch(/\(c\.user_id IS NULL OR c\.user_id = \?\)/);
    });

    it('GET /api/budgets scopes the join', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[]]);
        db.query.mockResolvedValueOnce([[]]);

        await request(app).get('/api/budgets?month=2026-04').set(authHeader());

        const q = db.query.mock.calls.find(([sql]) => sql.includes('FROM budgets b'));
        expect(q[0]).toMatch(/\(c\.user_id IS NULL OR c\.user_id = \?\)/);
    });
});

// ── Row-level ownership on id-taking routes (IDOR) ───────────────────────────
//
// Every route that accepts a row id from the URL must constrain on user_id and
// report 404 — not 403, which would confirm the row exists.

describe('id-taking routes constrain on user_id', () => {
    const routes = [
        { name: 'PUT /api/expenses/:id', method: 'put', path: '/api/expenses/1', table: 'expenses', body: { amount: 10 } },
        { name: 'DELETE /api/expenses/:id', method: 'delete', path: '/api/expenses/1', table: 'expenses', body: {} },
        { name: 'PUT /api/subscriptions/:id', method: 'put', path: '/api/subscriptions/1', table: 'subscriptions', body: { name: 'X', amount: 5, day_of_month: 3 } },
        { name: 'DELETE /api/subscriptions/:id', method: 'delete', path: '/api/subscriptions/1', table: 'subscriptions', body: {} },
    ];

    it.each(routes)('$name returns 404 for a row owned by another user', async ({ method, path, table, body }) => {
        authOk();
        // categoryAllowed() short-circuits (no category_id in body), so the next
        // query is the write itself — matching zero rows, as it would when the
        // row belongs to VICTIM.
        db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

        const res = await request(app)[method](path).set(authHeader()).send(body);

        expect(res.status).toBe(404);
        const write = db.query.mock.calls.find(([sql]) => sql.includes(table) && /UPDATE|DELETE/.test(sql));
        expect(write[0]).toMatch(/user_id\s*=\s*\?/);
        expect(write[1]).toContain(ATTACKER.user_id);
    });
});

// ── Identity comes from the JWT, never the request ───────────────────────────

describe('caller identity is taken from the verified token', () => {
    it('ignores a user_id supplied in the body', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ insertId: 5 }]);

        await request(app).post('/api/expenses').set(authHeader())
            .send({ amount: 50, user_id: VICTIM.user_id });

        const insert = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO expenses'));
        expect(insert[1][0]).toBe(ATTACKER.user_id);
        expect(insert[1]).not.toContain(VICTIM.user_id);
    });

    it('scopes reads to the token subject, not a query param', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[]]);

        await request(app).get(`/api/expenses?user_id=${VICTIM.user_id}`).set(authHeader());

        const q = db.query.mock.calls.find(([sql]) => sql.includes('FROM expenses e'));
        expect(q[1]).not.toContain(VICTIM.user_id);
        expect(q[1]).toContain(ATTACKER.user_id);
    });

    it('rejects an unauthenticated request outright', async () => {
        const res = await request(app).get('/api/expenses');

        expect(res.status).toBe(401);
        expect(db.query).not.toHaveBeenCalled();
    });
});
