const request = require('supertest');
const bcrypt = require('bcryptjs');

// Mocked before testApp pulls the controller in, so no real Google call is ever made.
const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { makeToken, makeExpiredToken, authHeader, TEST_USER } = require('./setup/authHelper');

// First entry of the positional mock queue satisfies authMiddleware's
// `SELECT user_id FROM users WHERE user_id = ?`.
function authOk() {
    db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]);
}

function googleTicket(payload) {
    mockVerifyIdToken.mockResolvedValueOnce({ getPayload: () => payload });
}

// ── Sign-up ──────────────────────────────────────────────────────────────────

describe('POST /api/auth/signup', () => {
    it('creates an account and returns a JWT', async () => {
        db.query
            .mockResolvedValueOnce([[]])                 // email not taken
            .mockResolvedValueOnce([{ insertId: 10000000000001 }]);

        const res = await request(app)
            .post('/api/auth/signup')
            .send({ email: 'New@Example.com', password: 'correct horse battery' });

        expect(res.status).toBe(201);
        expect(typeof res.body.token).toBe('string');

        // Stored lowercased — one canonical identity, so Google sign-in finds the same row.
        const insert = db.query.mock.calls[1];
        expect(insert[0]).toMatch(/INSERT INTO users/i);
        expect(insert[1]).toContain('new@example.com');
    });

    it('never returns or stores the password in clear', async () => {
        db.query
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([{ insertId: 10000000000002 }]);

        const res = await request(app)
            .post('/api/auth/signup')
            .send({ email: 'a@b.com', password: 'supersecret1' });

        expect(JSON.stringify(res.body)).not.toContain('supersecret1');
        const stored = db.query.mock.calls[1][1][2];
        expect(stored).not.toBe('supersecret1');
        expect(stored).toMatch(/^\$2[aby]\$/); // bcrypt
    });

    it('defaults the display name to the email local-part', async () => {
        db.query
            .mockResolvedValueOnce([[]])
            .mockResolvedValueOnce([{ insertId: 3 }]);

        await request(app).post('/api/auth/signup').send({ email: 'dana@example.com', password: 'password123' });

        expect(db.query.mock.calls[1][1][0]).toBe('dana');
    });

    /**
     * The whole point of the uniform response: a taken address must not be distinguishable
     * from any other rejection, or the endpoint becomes an email-existence oracle that an
     * attacker can walk a list against.
     */
    it('does not reveal that an email is already registered', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: 1 }]]); // email taken

        const taken = await request(app)
            .post('/api/auth/signup')
            .send({ email: 'known@example.com', password: 'password123' });

        db.query.mockResolvedValueOnce([[{ user_id: 2 }]]);
        const alsoTaken = await request(app)
            .post('/api/auth/signup')
            .send({ email: 'other@example.com', password: 'password123' });

        expect(taken.status).toBe(409);
        expect(taken.body).toEqual(alsoTaken.body);
        expect(JSON.stringify(taken.body)).not.toMatch(/known@example\.com/);
        expect(JSON.stringify(taken.body)).not.toMatch(/exists|taken|registered/i);
    });

    it('answers a UNIQUE-key race exactly as the pre-check does', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: 1 }]]);
        const viaCheck = await request(app)
            .post('/api/auth/signup')
            .send({ email: 'race@example.com', password: 'password123' });

        const dup = new Error('duplicate');
        dup.code = 'ER_DUP_ENTRY';
        db.query.mockResolvedValueOnce([[]]).mockRejectedValueOnce(dup);
        const viaRace = await request(app)
            .post('/api/auth/signup')
            .send({ email: 'race@example.com', password: 'password123' });

        expect(viaRace.status).toBe(viaCheck.status);
        expect(viaRace.body).toEqual(viaCheck.body);
    });

    it('rejects a password under 8 characters', async () => {
        const res = await request(app)
            .post('/api/auth/signup')
            .send({ email: 'a@b.com', password: 'short' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('weak_password');
        expect(db.query).not.toHaveBeenCalled();
    });

    it('rejects a malformed email', async () => {
        const res = await request(app)
            .post('/api/auth/signup')
            .send({ email: 'not-an-email', password: 'password123' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_email');
    });

    it('rejects missing fields', async () => {
        expect((await request(app).post('/api/auth/signup').send({ password: 'password123' })).status).toBe(400);
        expect((await request(app).post('/api/auth/signup').send({ email: 'a@b.com' })).status).toBe(400);
    });
});

// ── Sign-in ──────────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
    const PASSWORD = 'correct horse battery';
    let hash;

    beforeAll(async () => {
        hash = await bcrypt.hash(PASSWORD, 10);
    });

    it('returns a JWT on correct credentials', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: 7, username: 'eilon', password_hash: hash }]]);

        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: 'eilon@example.com', password: PASSWORD });

        expect(res.status).toBe(200);
        expect(typeof res.body.token).toBe('string');
    });

    it('matches the email case-insensitively', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: 7, username: 'eilon', password_hash: hash }]]);

        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: '  Eilon@Example.COM ', password: PASSWORD });

        expect(res.status).toBe(200);
        expect(db.query.mock.calls[0][1]).toEqual(['eilon@example.com']);
    });

    /**
     * Sign-in must not reveal whether an email exists. Wrong password, unknown address and
     * a Google-only account (password_hash IS NULL) all have to be one indistinguishable
     * answer — otherwise the login form enumerates the user table.
     */
    it('answers identically for wrong password, unknown email and a Google-only account', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: 7, username: 'eilon', password_hash: hash }]]);
        const wrongPassword = await request(app)
            .post('/api/auth/login')
            .send({ email: 'eilon@example.com', password: 'not the password' });

        db.query.mockResolvedValueOnce([[]]);
        const unknownEmail = await request(app)
            .post('/api/auth/login')
            .send({ email: 'nobody@example.com', password: PASSWORD });

        db.query.mockResolvedValueOnce([[{ user_id: 8, username: 'g', password_hash: null }]]);
        const googleOnly = await request(app)
            .post('/api/auth/login')
            .send({ email: 'google@example.com', password: PASSWORD });

        expect(wrongPassword.status).toBe(401);
        expect(unknownEmail.status).toBe(401);
        expect(googleOnly.status).toBe(401);
        expect(unknownEmail.body).toEqual(wrongPassword.body);
        expect(googleOnly.body).toEqual(wrongPassword.body);
    });

    it('returns 400 when a field is missing', async () => {
        expect((await request(app).post('/api/auth/login').send({ email: 'a@b.com' })).status).toBe(400);
        expect((await request(app).post('/api/auth/login').send({ password: 'x' })).status).toBe(400);
    });

    it('returns 500 on DB error', async () => {
        db.query.mockRejectedValueOnce(new Error('DB down'));

        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: 'a@b.com', password: PASSWORD });

        expect(res.status).toBe(500);
    });
});

// ── Google ───────────────────────────────────────────────────────────────────

describe('POST /api/auth/google', () => {
    it('creates an account on first sign-in instead of 404-ing', async () => {
        googleTicket({ email: 'fresh@gmail.com', email_verified: true, given_name: 'Fresh' });
        db.query
            .mockResolvedValueOnce([[]])                       // no existing row
            .mockResolvedValueOnce([{ insertId: 10000000000005 }]);

        const res = await request(app).post('/api/auth/google').send({ id_token: 'tok' });

        expect(res.status).toBe(200);
        expect(typeof res.body.token).toBe('string');
        expect(db.query.mock.calls[1][0]).toMatch(/INSERT INTO users/i);
    });

    /**
     * Requirement: signing up with a password and later using Google with the same address
     * must reach ONE account, not create a second.
     */
    it('merges into an existing password account when Google verified the email', async () => {
        googleTicket({ email: 'both@gmail.com', email_verified: true });
        db.query.mockResolvedValueOnce([[{ user_id: 55, username: 'both', password_hash: '$2b$12$abc' }]]);

        const res = await request(app).post('/api/auth/google').send({ id_token: 'tok' });

        expect(res.status).toBe(200);
        // No INSERT — the existing row is reused.
        expect(db.query).toHaveBeenCalledTimes(1);

        const payload = JSON.parse(Buffer.from(res.body.token.split('.')[1], 'base64').toString());
        expect(payload.user_id).toBe(55);
    });

    /**
     * Merging on an unverified claim would be an account-takeover path of its own: anyone
     * who can attach an arbitrary address to a Google account could walk into the password
     * account that owns it.
     */
    it('refuses to merge into a password account when email_verified is false', async () => {
        googleTicket({ email: 'both@gmail.com', email_verified: false });
        db.query.mockResolvedValueOnce([[{ user_id: 55, username: 'both', password_hash: '$2b$12$abc' }]]);

        const res = await request(app).post('/api/auth/google').send({ id_token: 'tok' });

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('email_unverified');
        expect(db.query).toHaveBeenCalledTimes(1); // nothing written
    });

    it('signs in an existing passwordless account', async () => {
        googleTicket({ email: 'g@gmail.com', email_verified: true });
        db.query.mockResolvedValueOnce([[{ user_id: 60, username: 'g', password_hash: null }]]);

        const res = await request(app).post('/api/auth/google').send({ id_token: 'tok' });

        expect(res.status).toBe(200);
    });

    it('rejects an invalid Google token', async () => {
        mockVerifyIdToken.mockRejectedValueOnce(new Error('bad token'));

        const res = await request(app).post('/api/auth/google').send({ id_token: 'nope' });

        expect(res.status).toBe(401);
        expect(db.query).not.toHaveBeenCalled();
    });

    it('requires an id_token', async () => {
        const res = await request(app).post('/api/auth/google').send({});
        expect(res.status).toBe(400);
    });
});

// ── Profile ──────────────────────────────────────────────────────────────────

describe('GET /api/me', () => {
    it('reports link state without ever exposing the password hash', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[{
            user_id: TEST_USER.user_id,
            username: 'eilon',
            email: 'eilon@example.com',
            telegram_chat_id: '12345',
            password_hash: '$2b$12$secret',
            onboarded_at: '2026-08-01 10:00:00',
        }]]);

        const res = await request(app).get('/api/me').set(authHeader());

        expect(res.status).toBe(200);
        // Exact shape, not a subset: this is the assertion that catches a hash or any other
        // internal column being added to the payload by accident.
        expect(res.body).toEqual({
            user_id: TEST_USER.user_id,
            username: 'eilon',
            email: 'eilon@example.com',
            telegram_linked: true,
            has_password: true,
            onboarded: true,
        });
        expect(JSON.stringify(res.body)).not.toContain('$2b$');
    });

    it('requires authentication', async () => {
        expect((await request(app).get('/api/me')).status).toBe(401);
    });

    it('reports onboarded false for an account that has never been welcomed', async () => {
        authOk();
        db.query.mockResolvedValueOnce([[{
            user_id: TEST_USER.user_id,
            username: 'new',
            email: 'new@example.com',
            telegram_chat_id: null,
            password_hash: '$2b$12$x',
            onboarded_at: null,
        }]]);

        const res = await request(app).get('/api/me').set(authHeader());

        expect(res.body.onboarded).toBe(false);
    });
});

describe('POST /api/me/onboarded', () => {
    it('records that the welcome tour was finished', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

        const res = await request(app).post('/api/me/onboarded').set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ onboarded: true });
        expect(db.query.mock.calls[1][0]).toMatch(/SET onboarded_at = NOW\(\)/i);
        expect(db.query.mock.calls[1][1]).toEqual([TEST_USER.user_id]);
    });

    /**
     * Write-once. Replaying the tour from Settings must not move the date, so onboarded_at
     * keeps meaning "when this user started" rather than "when they last opened the tour".
     */
    it('does not overwrite an existing onboarded date', async () => {
        authOk();
        db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

        const res = await request(app).post('/api/me/onboarded').set(authHeader());

        expect(res.status).toBe(200);
        expect(db.query.mock.calls[1][0]).toMatch(/onboarded_at IS NULL/i);
    });

    it('requires authentication', async () => {
        expect((await request(app).post('/api/me/onboarded')).status).toBe(401);
    });
});

// ── Telegram link codes ──────────────────────────────────────────────────────

describe('POST /api/auth/telegram/link-code', () => {
    it('issues a code and invalidates any outstanding one', async () => {
        authOk();
        db.query
            .mockResolvedValueOnce([{ affectedRows: 1 }])  // invalidate previous
            .mockResolvedValueOnce([{ insertId: 1 }]);     // insert new

        const res = await request(app).post('/api/auth/telegram/link-code').set(authHeader());

        expect(res.status).toBe(201);
        expect(res.body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/); // Crockford base32
        expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(Date.now());

        expect(db.query.mock.calls[1][0]).toMatch(/UPDATE telegram_link_codes SET used_at/i);
        // Only the hash is persisted, never the code itself.
        const inserted = db.query.mock.calls[2][1];
        expect(inserted[1]).toMatch(/^[a-f0-9]{64}$/);
        expect(inserted).not.toContain(res.body.code);
    });

    it('requires authentication', async () => {
        expect((await request(app).post('/api/auth/telegram/link-code')).status).toBe(401);
    });
});

describe('DELETE /api/auth/telegram/link', () => {
    it('clears the chat id and burns outstanding codes', async () => {
        authOk();
        db.query
            .mockResolvedValueOnce([{ affectedRows: 1 }])
            .mockResolvedValueOnce([{ affectedRows: 1 }]);

        const res = await request(app).delete('/api/auth/telegram/link').set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body.telegram_linked).toBe(false);
        expect(db.query.mock.calls[1][0]).toMatch(/SET telegram_chat_id = NULL/i);
    });
});

// ── Auth middleware (unchanged contract) ─────────────────────────────────────

describe('Auth middleware', () => {
    it('passes with valid token and existing user', async () => {
        db.query
            .mockResolvedValueOnce([[{ user_id: 42 }]])
            .mockResolvedValueOnce([[]]);

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
        db.query.mockResolvedValueOnce([[]]);

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
