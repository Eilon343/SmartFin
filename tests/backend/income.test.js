const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { authHeader, TEST_USER } = require('./setup/authHelper');

function authOk() {
    db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]);
}

// ── GET /income ───────────────────────────────────────────────────────────────

describe('GET /api/income', () => {
    it('returns income list for month', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[
            { income_id: 1, source: 'Salary', amount: 15000, type: 'fixed', month: '2026-04', currency: 'ILS' },
            { income_id: 2, source: 'Table sale', amount: 800, type: 'variable', month: '2026-04', currency: 'ILS' },
        ]]);

        const res = await request(app)
            .get('/api/income?month=2026-04')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(2);
    });

    it('returns empty array when no income', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[]]);

        const res = await request(app).get('/api/income').set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it('rejects invalid month format', async () => {
        authOk();

        const res = await request(app)
            .get('/api/income?month=bad')
            .set(authHeader());

        expect(res.status).toBe(400);
    });
});

// ── POST /income ──────────────────────────────────────────────────────────────

describe('POST /api/income', () => {
    it('creates income and returns 200 with income_id', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ insertId: 5 }]);

        const res = await request(app)
            .post('/api/income')
            .set(authHeader())
            .send({ source: 'Salary', amount: 15000, type: 'fixed', month: '2026-04' });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('income_id');
    });

    it('creates variable income (table sale scenario)', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ insertId: 6 }]);

        const res = await request(app)
            .post('/api/income')
            .set(authHeader())
            .send({ source: 'Table sale', amount: 800, type: 'variable', month: '2026-04' });

        expect(res.status).toBe(200);
    });

    it('defaults type to fixed when omitted', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ insertId: 7 }]);

        const res = await request(app)
            .post('/api/income')
            .set(authHeader())
            .send({ source: 'Salary', amount: 5000, month: '2026-04' });

        expect(res.status).toBe(200);
    });

    it('returns 400 when source missing', async () => {
        authOk();

        const res = await request(app)
            .post('/api/income')
            .set(authHeader())
            .send({ amount: 500, type: 'fixed', month: '2026-04' });

        expect(res.status).toBe(400);
    });

    it('returns 400 when amount missing', async () => {
        authOk();

        const res = await request(app)
            .post('/api/income')
            .set(authHeader())
            .send({ source: 'Salary', type: 'fixed', month: '2026-04' });

        expect(res.status).toBe(400);
    });

    it('returns 400 when amount is zero', async () => {
        authOk();

        const res = await request(app)
            .post('/api/income')
            .set(authHeader())
            .send({ source: 'Salary', amount: 0, month: '2026-04' });

        expect(res.status).toBe(400);
    });

    it('returns 400 for invalid type', async () => {
        authOk();

        const res = await request(app)
            .post('/api/income')
            .set(authHeader())
            .send({ source: 'Salary', amount: 5000, type: 'lottery', month: '2026-04' });

        expect(res.status).toBe(400);
    });

    it('returns 400 when month missing', async () => {
        authOk();

        const res = await request(app)
            .post('/api/income')
            .set(authHeader())
            .send({ source: 'Salary', amount: 5000, type: 'fixed' });

        expect(res.status).toBe(400);
    });
});

// ── PUT /income/:id ───────────────────────────────────────────────────────────

describe('PUT /api/income/:id', () => {
    it('updates income and returns 200', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

        const res = await request(app)
            .put('/api/income/1')
            .set(authHeader())
            .send({ source: 'Salary', amount: 16000, month: '2026-04' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('returns 404 when record not owned by user', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

        const res = await request(app)
            .put('/api/income/999')
            .set(authHeader())
            .send({ source: 'Salary', amount: 100, month: '2026-04' });

        expect(res.status).toBe(404);
    });

    it('returns 400 when required fields missing', async () => {
        authOk();

        const res = await request(app)
            .put('/api/income/1')
            .set(authHeader())
            .send({ amount: 100 }); // missing source and month

        expect(res.status).toBe(400);
    });
});

// ── DELETE /income/:id ────────────────────────────────────────────────────────

describe('DELETE /api/income/:id', () => {
    it('deletes and returns 200', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

        const res = await request(app)
            .delete('/api/income/1')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('returns 404 for non-existent record', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

        const res = await request(app)
            .delete('/api/income/999')
            .set(authHeader());

        expect(res.status).toBe(404);
    });
});

// ── GET /income/summary ───────────────────────────────────────────────────────

describe('GET /api/income/summary', () => {
    it('returns summary with fixed and variable totals', async () => {
        authOk();
        db.query
            .mockResolvedValueOnce([[{ source: 'Salary', amount: 15000 }]])  // fixed
            .mockResolvedValueOnce([[{ source: 'Table sale', amount: 800 }]]); // variable

        const res = await request(app)
            .get('/api/income/summary?month=2026-04')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('fixed_total');
        expect(res.body).toHaveProperty('variable_total');
        expect(res.body).toHaveProperty('total');
        expect(res.body.total).toBe(15800);
    });

    it('returns zero totals for empty month', async () => {
        authOk();
        db.query
            .mockResolvedValueOnce([[]])  // fixed: none
            .mockResolvedValueOnce([[]]); // variable: none

        const res = await request(app)
            .get('/api/income/summary')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body.fixed_total).toBe(0);
        expect(res.body.variable_total).toBe(0);
        expect(res.body.total).toBe(0);
    });
});
