const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { authHeader, TEST_USER } = require('./setup/authHelper');

function authOk() {
    db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]);
}

// ── GET /expenses ─────────────────────────────────────────────────────────────

describe('GET /api/expenses', () => {
    it('returns expenses array', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[
            { expense_id: 1, amount: 55, description: 'shawarma', category_name: 'Food', source: 'bot', created_at: '2026-04-10' },
        ]]);

        const res = await request(app)
            .get('/api/expenses')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body[0].expense_id).toBe(1);
    });

    it('returns empty array when no expenses', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[]]);

        const res = await request(app).get('/api/expenses').set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it('rejects invalid month format', async () => {
        authOk();

        const res = await request(app)
            .get('/api/expenses?month=not-a-month')
            .set(authHeader());

        expect(res.status).toBe(400);
    });

    it('requires auth', async () => {
        const res = await request(app).get('/api/expenses');
        expect(res.status).toBe(401);
    });
});

// ── POST /expenses ────────────────────────────────────────────────────────────

describe('POST /api/expenses', () => {
    it('creates expense and returns 200 with expense_id', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[{ 1: 1 }]]);  // category ownership check
        db.query.mockResolvedValueOnce([{ insertId: 99 }]);

        const res = await request(app)
            .post('/api/expenses')
            .set(authHeader())
            .send({ amount: 55, description: 'shawarma', category_id: 3, currency: 'ILS' });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('expense_id');
    });

    it('returns 400 when amount missing', async () => {
        authOk();

        const res = await request(app)
            .post('/api/expenses')
            .set(authHeader())
            .send({ description: 'shawarma' });

        expect(res.status).toBe(400);
    });

    it('returns 400 when amount is zero', async () => {
        authOk();

        const res = await request(app)
            .post('/api/expenses')
            .set(authHeader())
            .send({ amount: 0 });

        expect(res.status).toBe(400);
    });

    it('returns 400 when amount is negative', async () => {
        authOk();

        const res = await request(app)
            .post('/api/expenses')
            .set(authHeader())
            .send({ amount: -10 });

        expect(res.status).toBe(400);
    });

    it('accepts expense without category_id', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ insertId: 100 }]);

        const res = await request(app)
            .post('/api/expenses')
            .set(authHeader())
            .send({ amount: 30 });

        expect(res.status).toBe(200);
    });
});

// ── PUT /expenses/:id ─────────────────────────────────────────────────────────

describe('PUT /api/expenses/:id', () => {
    it('updates and returns 200', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

        const res = await request(app)
            .put('/api/expenses/1')
            .set(authHeader())
            .send({ amount: 60, description: 'updated' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('returns 404 for expense not owned by user', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

        const res = await request(app)
            .put('/api/expenses/999')
            .set(authHeader())
            .send({ amount: 60 });

        expect(res.status).toBe(404);
    });

    it('returns 400 for invalid amount', async () => {
        authOk();

        const res = await request(app)
            .put('/api/expenses/1')
            .set(authHeader())
            .send({ amount: 0 });

        expect(res.status).toBe(400);
    });
});

// ── DELETE /expenses/:id ──────────────────────────────────────────────────────

describe('DELETE /api/expenses/:id', () => {
    it('deletes and returns 200', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

        const res = await request(app)
            .delete('/api/expenses/1')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('returns 404 when expense not found', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

        const res = await request(app)
            .delete('/api/expenses/999')
            .set(authHeader());

        expect(res.status).toBe(404);
    });
});

// ── GET /expenses/summary ─────────────────────────────────────────────────────

describe('GET /api/expenses/summary', () => {
    it('returns summary object with by_category and grand_total', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[
            { category: 'Food', total: 450 },
            { category: 'Transport', total: 120 },
        ]]);

        const res = await request(app)
            .get('/api/expenses/summary')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('by_category');
        expect(res.body).toHaveProperty('grand_total');
        expect(res.body.grand_total).toBe(570);
    });

    it('grand_total is 0 for empty month', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[]]);

        const res = await request(app)
            .get('/api/expenses/summary')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body.grand_total).toBe(0);
    });
});
