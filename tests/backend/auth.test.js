const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { makeToken, makeExpiredToken } = require('./setup/authHelper');

// ── PIN Login ────────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
    const PIN = '1234';
    let pinHash;

    beforeAll(async () => {
        pinHash = await bcrypt.hash(PIN, 10);
    });

    it('returns JWT on correct credentials', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: 1, username: 'eilon', pin_hash: pinHash }]]);

        const res = await request(app)
            .post('/api/auth/login')
            .send({ user_id: 1, pin: PIN });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('token');
        expect(typeof res.body.token).toBe('string');
    });

    it('returns 401 on wrong PIN', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: 1, username: 'eilon', pin_hash: pinHash }]]);

        const res = await request(app)
            .post('/api/auth/login')
            .send({ user_id: 1, pin: '9999' });

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid credentials');
    });

    it('returns 401 on unknown user_id', async () => {
        db.query.mockResolvedValueOnce([[]]); // no rows

        const res = await request(app)
            .post('/api/auth/login')
            .send({ user_id: 999, pin: PIN });

        expect(res.status).toBe(401);
    });

    it('returns 400 when user_id missing', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ pin: PIN });

        expect(res.status).toBe(400);
    });

    it('returns 400 when pin missing', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ user_id: 1 });

        expect(res.status).toBe(400);
    });

    it('returns 500 on DB error', async () => {
        db.query.mockRejectedValueOnce(new Error('DB down'));

        const res = await request(app)
            .post('/api/auth/login')
            .send({ user_id: 1, pin: PIN });

        expect(res.status).toBe(500);
    });
});

// ── Auth Middleware ───────────────────────────────────────────────────────────

describe('Auth middleware', () => {
    it('passes with valid token and existing user', async () => {
        db.query
            .mockResolvedValueOnce([[{ user_id: 42 }]])  // auth middleware user check
            .mockResolvedValueOnce([[]])                   // getAllExpenses result

        const res = await request(app)
            .get('/api/expenses')
            .set('Authorization', `Bearer ${makeToken()}`);

        expect(res.status).not.toBe(401);
    });

    it('returns 401 with no token', async () => {
        const res = await request(app).get('/api/expenses');
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 401 with invalid token', async () => {
        const res = await request(app)
            .get('/api/expenses')
            .set('Authorization', 'Bearer totally.invalid.token');

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid token');
    });

    it('returns 401 with expired token', async () => {
        const res = await request(app)
            .get('/api/expenses')
            .set('Authorization', `Bearer ${makeExpiredToken()}`);

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid token');
    });

    it('returns 401 when user deleted after token issued', async () => {
        db.query.mockResolvedValueOnce([[]]); // user not found in DB

        const res = await request(app)
            .get('/api/expenses')
            .set('Authorization', `Bearer ${makeToken()}`);

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('User no longer exists');
    });

    it('returns 401 with malformed Bearer header', async () => {
        const res = await request(app)
            .get('/api/expenses')
            .set('Authorization', 'NotBearer token');

        expect(res.status).toBe(401);
    });
});
