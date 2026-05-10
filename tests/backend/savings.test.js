const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { authHeader, TEST_USER } = require('./setup/authHelper');

function authOk() {
    db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]);
}

// ── GET /savings ──────────────────────────────────────────────────────────────

describe('GET /api/savings', () => {
    it('returns active goals with pct_complete calculated', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[
            { goal_id: 1, name: 'Tokyo flight', target_amount: '8000', saved_amount: '2000', monthly_allocation: '500', currency: 'ILS', active: 1 },
        ]]);

        const res = await request(app)
            .get('/api/savings')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body[0].pct_complete).toBe(25); // 2000/8000 = 25%
    });

    it('returns empty array when no goals', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[]]);

        const res = await request(app).get('/api/savings').set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });
});

// ── POST /savings ─────────────────────────────────────────────────────────────

describe('POST /api/savings', () => {
    it('creates savings goal and returns 200 with goal_id', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ insertId: 7 }]);

        const res = await request(app)
            .post('/api/savings')
            .set(authHeader())
            .send({ name: 'Tokyo flight', target_amount: 8000, monthly_allocation: 500 });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('goal_id');
    });

    it('returns 400 when name missing', async () => {
        authOk();

        const res = await request(app)
            .post('/api/savings')
            .set(authHeader())
            .send({ target_amount: 8000 });

        expect(res.status).toBe(400);
    });

    it('returns 400 when target_amount missing', async () => {
        authOk();

        const res = await request(app)
            .post('/api/savings')
            .set(authHeader())
            .send({ name: 'Tokyo' });

        expect(res.status).toBe(400);
    });

    it('returns 400 for zero target_amount (falsy check)', async () => {
        authOk();

        const res = await request(app)
            .post('/api/savings')
            .set(authHeader())
            .send({ name: 'Tokyo', target_amount: 0 });

        expect(res.status).toBe(400);
    });
});

// ── POST /savings/:id/deposit ─────────────────────────────────────────────────

describe('POST /api/savings/:id/deposit', () => {
    it('adds funds to goal and returns 200', async () => {
        authOk();
        db.query
            .mockResolvedValueOnce([[{ name: 'Tokyo flight' }]])  // SELECT goal
            .mockResolvedValueOnce([{ affectedRows: 1 }])          // UPDATE saved_amount
            .mockResolvedValueOnce([[{ category_id: 7 }]])         // SELECT Savings category
            .mockResolvedValueOnce([{ insertId: 200 }]);           // INSERT virtual expense

        const res = await request(app)
            .post('/api/savings/1/deposit')
            .set(authHeader())
            .send({ amount: 500 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('returns 400 for zero deposit', async () => {
        authOk();

        const res = await request(app)
            .post('/api/savings/1/deposit')
            .set(authHeader())
            .send({ amount: 0 });

        expect(res.status).toBe(400);
    });

    it('returns 400 for negative deposit', async () => {
        authOk();

        const res = await request(app)
            .post('/api/savings/1/deposit')
            .set(authHeader())
            .send({ amount: -100 });

        expect(res.status).toBe(400);
    });

    it('returns 404 when goal not found or not owned by user', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[]]); // SELECT goal returns empty

        const res = await request(app)
            .post('/api/savings/999/deposit')
            .set(authHeader())
            .send({ amount: 100 });

        expect(res.status).toBe(404);
    });
});

// ── PUT /savings/:id ──────────────────────────────────────────────────────────

describe('PUT /api/savings/:id', () => {
    it('updates goal and returns 200', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

        const res = await request(app)
            .put('/api/savings/1')
            .set(authHeader())
            .send({ name: 'Updated goal', target_amount: 10000, monthly_allocation: 600 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('returns 400 for zero target_amount', async () => {
        authOk();

        const res = await request(app)
            .put('/api/savings/1')
            .set(authHeader())
            .send({ name: 'Goal', target_amount: 0 });

        expect(res.status).toBe(400);
    });

    it('returns 400 for negative monthly_allocation', async () => {
        authOk();

        const res = await request(app)
            .put('/api/savings/1')
            .set(authHeader())
            .send({ name: 'Goal', target_amount: 10000, monthly_allocation: -100 });

        expect(res.status).toBe(400);
    });

    it('returns 404 when goal not found', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

        const res = await request(app)
            .put('/api/savings/999')
            .set(authHeader())
            .send({ name: 'Goal', target_amount: 5000 });

        expect(res.status).toBe(404);
    });
});

// ── DELETE /savings/:id ───────────────────────────────────────────────────────

describe('DELETE /api/savings/:id', () => {
    it('deactivates goal (soft delete) and returns 200', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

        const res = await request(app)
            .delete('/api/savings/1')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});
