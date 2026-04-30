const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { authHeader, TEST_USER } = require('./setup/authHelper');

function authOk() {
    db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]);
}

// ── GET /subscriptions ────────────────────────────────────────────────────────

describe('GET /api/subscriptions', () => {
    it('returns active subscriptions', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[
            { subscription_id: 1, name: 'Netflix', amount: 39.90, day_of_month: 15, active: 1, paused: 0 },
            { subscription_id: 2, name: 'Spotify', amount: 19.90, day_of_month: 1, active: 1, paused: 0 },
        ]]);

        const res = await request(app)
            .get('/api/subscriptions')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(2);
    });
});

// ── POST /subscriptions ───────────────────────────────────────────────────────

describe('POST /api/subscriptions', () => {
    it('creates subscription and returns 200 with subscription_id', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ insertId: 10 }]);

        const res = await request(app)
            .post('/api/subscriptions')
            .set(authHeader())
            .send({ name: 'Netflix', amount: 39.90, day_of_month: 15 });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('subscription_id');
    });

    it('returns 400 when name missing', async () => {
        authOk();

        const res = await request(app)
            .post('/api/subscriptions')
            .set(authHeader())
            .send({ amount: 39.90, day_of_month: 15 });

        expect(res.status).toBe(400);
    });

    it('returns 400 when day_of_month missing', async () => {
        authOk();

        const res = await request(app)
            .post('/api/subscriptions')
            .set(authHeader())
            .send({ name: 'Netflix', amount: 39.90 });

        expect(res.status).toBe(400);
    });

    it('returns 400 when day_of_month is 0 (below range)', async () => {
        authOk();

        const res = await request(app)
            .post('/api/subscriptions')
            .set(authHeader())
            .send({ name: 'Netflix', amount: 39.90, day_of_month: 0 });

        expect(res.status).toBe(400);
    });

    it('returns 400 when day_of_month is 29 (above range)', async () => {
        authOk();

        const res = await request(app)
            .post('/api/subscriptions')
            .set(authHeader())
            .send({ name: 'Netflix', amount: 39.90, day_of_month: 29 });

        expect(res.status).toBe(400);
    });

    it('accepts day_of_month at lower boundary (1)', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ insertId: 11 }]);

        const res = await request(app)
            .post('/api/subscriptions')
            .set(authHeader())
            .send({ name: 'Netflix', amount: 39.90, day_of_month: 1 });

        expect(res.status).toBe(200);
    });

    it('accepts day_of_month at upper boundary (28)', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ insertId: 12 }]);

        const res = await request(app)
            .post('/api/subscriptions')
            .set(authHeader())
            .send({ name: 'Netflix', amount: 39.90, day_of_month: 28 });

        expect(res.status).toBe(200);
    });
});

// ── PUT /subscriptions/:id/pause ──────────────────────────────────────────────

describe('PUT /api/subscriptions/:id/pause', () => {
    it('pauses an active subscription', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

        const res = await request(app)
            .put('/api/subscriptions/1/pause')
            .set(authHeader())
            .send({ paused: true });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('resumes a paused subscription', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

        const res = await request(app)
            .put('/api/subscriptions/1/pause')
            .set(authHeader())
            .send({ paused: false });

        expect(res.status).toBe(200);
    });

    it('returns 404 for subscription not owned by user', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

        const res = await request(app)
            .put('/api/subscriptions/999/pause')
            .set(authHeader())
            .send({ paused: true });

        expect(res.status).toBe(404);
    });
});

// ── DELETE /subscriptions/:id ─────────────────────────────────────────────────

describe('DELETE /api/subscriptions/:id', () => {
    it('deactivates subscription (soft delete)', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

        const res = await request(app)
            .delete('/api/subscriptions/1')
            .set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('returns 404 for unknown subscription', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

        const res = await request(app)
            .delete('/api/subscriptions/999')
            .set(authHeader());

        expect(res.status).toBe(404);
    });
});
