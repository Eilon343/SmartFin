const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { authHeader, TEST_USER } = require('./setup/authHelper');

function authOk() {
    db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]);
}

// getBudgets makes 3 DB queries: budgetRows → expenseRows → allCatRows
function mockBudgetsEmpty() {
    authOk();
    db.query
        .mockResolvedValueOnce([[]])   // budgetRows: no budgets
        .mockResolvedValueOnce([[]])   // expenseRows: no expenses
        .mockResolvedValueOnce([[]]); // allCatRows: no categories
}

// ── GET /budgets ──────────────────────────────────────────────────────────────

describe('GET /api/budgets', () => {
    it('returns budget list with spent/remaining for current month', async () => {
        authOk();
        db.query
            .mockResolvedValueOnce([[{
                budget_id: 1, category_id: 3, category: 'Food',
                monthly_limit: 1500, carry_over: 1, start_month: '2026-04',
            }]])
            .mockResolvedValueOnce([[{ category_id: 3, mo: '2026-04', total: 450 }]])
            .mockResolvedValueOnce([[{ category_id: 3, category: 'Food' }]]);

        const res = await request(app)
            .get('/api/budgets')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('budgets');
        expect(Array.isArray(res.body.budgets)).toBe(true);
        const budget = res.body.budgets.find(b => b.category === 'Food');
        expect(budget.spent).toBe(450);
        expect(budget.remaining).toBe(1050);
    });

    it('returns empty budgets array when none set', async () => {
        mockBudgetsEmpty();

        const res = await request(app)
            .get('/api/budgets')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('budgets');
        expect(res.body.budgets).toEqual([]);
    });

    it('categories without budgets appear with no_budget: true', async () => {
        authOk();
        db.query
            .mockResolvedValueOnce([[]])  // no budgets
            .mockResolvedValueOnce([[]])  // no expenses
            .mockResolvedValueOnce([[
                { category_id: 1, category: 'Food' },
                { category_id: 2, category: 'Transport' },
            ]]);

        const res = await request(app)
            .get('/api/budgets')
            .set(authHeader());

        expect(res.status).toBe(200);
        const unbud = res.body.budgets.find(b => b.category === 'Food');
        expect(unbud.no_budget).toBe(true);
        expect(unbud.monthly_limit).toBeNull();
    });

    it('rejects invalid month format', async () => {
        authOk();

        // '2026-1' has only 1 digit for month — fails \d{4}-\d{2}$ regex
        const res = await request(app)
            .get('/api/budgets?month=2026-1')
            .set(authHeader());

        expect(res.status).toBe(400);
    });
});

// ── POST /budgets ─────────────────────────────────────────────────────────────

describe('POST /api/budgets', () => {
    it('creates budget and returns success', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ insertId: 1, affectedRows: 1 }]);

        const res = await request(app)
            .post('/api/budgets')
            .set(authHeader())
            .send({ category_id: 3, monthly_limit: 1500, carry_over: true });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('updates existing budget (upsert)', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ insertId: 0, affectedRows: 2 }]);

        const res = await request(app)
            .post('/api/budgets')
            .set(authHeader())
            .send({ category_id: 3, monthly_limit: 2000, carry_over: false });

        expect(res.status).toBe(200);
    });

    it('returns 400 when category_id missing', async () => {
        authOk();

        const res = await request(app)
            .post('/api/budgets')
            .set(authHeader())
            .send({ monthly_limit: 1500 });

        expect(res.status).toBe(400);
    });

    it('returns 400 when monthly_limit missing', async () => {
        authOk();

        const res = await request(app)
            .post('/api/budgets')
            .set(authHeader())
            .send({ category_id: 3 });

        expect(res.status).toBe(400);
    });
});

// ── GET /categories ───────────────────────────────────────────────────────────

describe('GET /api/categories', () => {
    it('returns base and user categories', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[
            { category_id: 1, name: 'Food', is_base: 1 },
            { category_id: 2, name: 'Transport', is_base: 1 },
            { category_id: 10, name: 'Gym', is_base: 0 },
        ]]);

        const res = await request(app)
            .get('/api/categories')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBe(3);
    });
});

// ── POST /categories ──────────────────────────────────────────────────────────

describe('POST /api/categories', () => {
    // addCategory does: SELECT existing + INSERT (2 DB queries)
    it('creates custom category and returns category_id', async () => {
        authOk();
        db.query
            .mockResolvedValueOnce([[]])               // SELECT: not existing
            .mockResolvedValueOnce([{ insertId: 20 }]); // INSERT

        const res = await request(app)
            .post('/api/categories')
            .set(authHeader())
            .send({ name: 'Gym' });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('category_id');
    });

    it('returns 400 when name missing', async () => {
        authOk();

        const res = await request(app)
            .post('/api/categories')
            .set(authHeader())
            .send({});

        expect(res.status).toBe(400);
    });

    it('returns 400 for empty name', async () => {
        authOk();

        const res = await request(app)
            .post('/api/categories')
            .set(authHeader())
            .send({ name: '' });

        expect(res.status).toBe(400);
    });

    it('returns 400 when category already exists', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[{ category_id: 5 }]]); // existing found

        const res = await request(app)
            .post('/api/categories')
            .set(authHeader())
            .send({ name: 'Food' });

        expect(res.status).toBe(400);
    });
});
