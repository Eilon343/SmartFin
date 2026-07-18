const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');

// Extend timeout: the 503 retry path sleeps 2s + 4s before giving up.
jest.setTimeout(12000);

const VALID_SECRET = 'test-webhook-secret';

beforeEach(() => {
    global.fetch = jest.fn();
    // Speed up retry delays so tests don't actually sleep 6 seconds
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
});

afterEach(() => {
    delete global.fetch;
    jest.restoreAllMocks();
});

function mockGeminiSuccess(parsed) {
    global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify(parsed) }] } }],
        }),
    });
}

function mockGemini503() {
    global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: { message: 'Service unavailable', code: 503 } }),
    });
}

function mockTelegram() {
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
}

// ── Auth / secret validation ──────────────────────────────────────────────────

describe('POST /webhook/apple-pay - secret validation', () => {
    it('returns 401 with no secret header', async () => {
        const res = await request(app)
            .post('/webhook/apple-pay')
            .send({ text: 'Apple Pay 55 ILS at Cafe' });

        expect(res.status).toBe(401);
    });

    it('returns 401 with wrong secret', async () => {
        const res = await request(app)
            .post('/webhook/apple-pay')
            .set('X-Webhook-Secret', 'wrong-secret')
            .send({ text: 'Apple Pay 55 ILS at Cafe' });

        expect(res.status).toBe(401);
    });

    it('returns 400 when text body missing', async () => {
        const res = await request(app)
            .post('/webhook/apple-pay')
            .set('X-Webhook-Secret', VALID_SECRET)
            .send({});

        expect(res.status).toBe(400);
    });
});

// ── Per-user token routing ───────────────────────────────────────────────────

describe('POST /webhook/apple-pay - per-user token routing', () => {
    it('attributes the expense and the notification to the token owner, not the instance owner', async () => {
        const SECOND_USER = 555000111;
        mockGeminiSuccess({ amount: 42, currency: 'ILS', merchant: 'Bakery', category: 'Food', source: 'apple_pay' });
        db.query
            .mockResolvedValueOnce([[{ user_id: SECOND_USER, telegram_chat_id: String(SECOND_USER) }]]) // token lookup
            .mockResolvedValueOnce([[{ category_id: 1 }]])   // category lookup
            .mockResolvedValueOnce([{ insertId: 200 }]);     // insert expense
        mockTelegram();

        const res = await request(app)
            .post('/webhook/apple-pay')
            .set('X-Webhook-Token', 'second-user-token')
            .send({ text: 'Apple Pay 42 ILS at Bakery' });

        expect(res.status).toBe(200);

        // Expense rows must carry the second user's id
        const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO expenses'));
        expect(insertCall[1][0]).toBe(SECOND_USER);

        // Telegram notification must go to the second user's chat
        const telegramCall = global.fetch.mock.calls.find(([url]) => url.includes('api.telegram.org'));
        expect(JSON.parse(telegramCall[1].body).chat_id).toBe(String(SECOND_USER));
    });

    it('returns 401 for an unrecognized token', async () => {
        db.query.mockResolvedValueOnce([[]]); // no user matches the token

        const res = await request(app)
            .post('/webhook/apple-pay')
            .set('X-Webhook-Token', 'bogus-token')
            .send({ text: 'Apple Pay 42 ILS at Bakery' });

        expect(res.status).toBe(401);
    });
});

// ── Successful parse → expense inserted ──────────────────────────────────────

function mockOwner() {
    db.query.mockResolvedValueOnce([[{ user_id: 123456789 }]]); // owner telegram_chat_id lookup
}

describe('POST /webhook/apple-pay - successful Gemini parse', () => {
    it('parses transaction, inserts expense, notifies Telegram', async () => {
        mockGeminiSuccess({ amount: 55, currency: 'ILS', merchant: 'Cafe', category: 'Food', source: 'apple_pay' });
        mockOwner();
        db.query
            .mockResolvedValueOnce([[{ category_id: 1 }]])  // category lookup
            .mockResolvedValueOnce([{ insertId: 100 }]);     // insert expense
        mockTelegram();

        const res = await request(app)
            .post('/webhook/apple-pay')
            .set('X-Webhook-Secret', VALID_SECRET)
            .send({ text: 'Apple Pay transaction: 55 ILS at Cafe' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.parsed[0].amount).toBe(55);
    });

    it('creates category when not found then inserts expense', async () => {
        mockGeminiSuccess({ amount: 120, currency: 'ILS', merchant: 'NewPlace', category: 'Shopping', source: 'apple_pay' });
        mockOwner();
        db.query
            .mockResolvedValueOnce([[]])                     // category not found
            .mockResolvedValueOnce([{ insertId: 50 }])       // category created
            .mockResolvedValueOnce([{ insertId: 101 }]);     // expense inserted
        mockTelegram();

        const res = await request(app)
            .post('/webhook/apple-pay')
            .set('X-Webhook-Secret', VALID_SECRET)
            .send({ text: 'Apple Pay 120 ILS at NewPlace' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('handles null merchant — uses "Unknown merchant" in notification', async () => {
        mockGeminiSuccess({ amount: 55, currency: 'ILS', merchant: null, category: 'Other', source: 'apple_pay' });
        mockOwner();
        db.query
            .mockResolvedValueOnce([[{ category_id: 8 }]])
            .mockResolvedValueOnce([{ insertId: 102 }]);
        mockTelegram();

        const res = await request(app)
            .post('/webhook/apple-pay')
            .set('X-Webhook-Secret', VALID_SECRET)
            .send({ text: 'Apple Pay 55' });

        expect(res.status).toBe(200);
    });
});

// ── Gemini returns no amount ───────────────────────────────────────────────────

describe('POST /webhook/apple-pay - Gemini parse edge cases', () => {
    it('returns 500 when Gemini returns null amount', async () => {
        mockGeminiSuccess({ amount: null, currency: 'ILS', merchant: 'Cafe', category: 'Food', source: 'apple_pay' });
        mockOwner();

        const res = await request(app)
            .post('/webhook/apple-pay')
            .set('X-Webhook-Secret', VALID_SECRET)
            .send({ text: 'Apple Pay transaction: ???' });

        expect(res.status).toBe(500);
    });
});

// ── Gemini 503 → queue ────────────────────────────────────────────────────────

describe('POST /webhook/apple-pay - Gemini unavailable', () => {
    it('queues transaction when all 3 Gemini attempts fail with 503', async () => {
        // 3 attempts × 503
        mockGemini503();
        mockGemini503();
        mockGemini503();
        mockOwner();
        // queue insert
        db.query.mockResolvedValueOnce([{ insertId: 1 }]);
        // Telegram notification
        mockTelegram();

        const res = await request(app)
            .post('/webhook/apple-pay')
            .set('X-Webhook-Secret', VALID_SECRET)
            .send({ text: 'Apple Pay 55 ILS at Cafe' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.queued).toBe(true);

        // Verify exactly 3 Gemini calls were made (retried twice)
        const geminiCalls = global.fetch.mock.calls.filter(
            ([url]) => url && url.includes('generativelanguage')
        );
        expect(geminiCalls).toHaveLength(3);
    });
});
