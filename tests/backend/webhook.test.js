/**
 * The Apple Pay webhook was removed once bank/card sync landed.
 *
 * An Apple Pay purchase IS a credit-card purchase, so the card connection imports the
 * same transaction directly from the issuer — with the real merchant name instead of a
 * notification string. Running both double-counted every purchase, and cross-source
 * deduplication would have meant fuzzy amount/date matching that can corrupt two
 * records at once when it guesses wrong.
 *
 * These tests guard the removal: the endpoint must stay gone, and the Telegram webhook
 * that shares the same controller must keep working.
 */
const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');

describe('POST /webhook/apple-pay — removed', () => {
    test('the endpoint no longer exists', async () => {
        const res = await request(app)
            .post('/webhook/apple-pay')
            .set('X-Webhook-Secret', 'test-webhook-secret')
            .send({ text: 'Cafe 12.00' });

        expect(res.status).toBe(404);
    });

    test('it is not reachable with a per-user token either', async () => {
        const res = await request(app)
            .post('/webhook/apple-pay')
            .set('X-Webhook-Token', 'some-user-token')
            .send({ text: 'Cafe 12.00' });

        expect(res.status).toBe(404);
    });

    test('no expense is written by the attempt', async () => {
        db.query.mockResolvedValue([[]]);
        await request(app).post('/webhook/apple-pay').send({ text: 'Cafe 12.00' });

        const inserts = db.query.mock.calls.filter(([sql]) => /INSERT INTO expenses/i.test(sql));
        expect(inserts).toHaveLength(0);
    });
});

describe('POST /webhook/telegram — still active', () => {
    beforeEach(() => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    });
    afterEach(() => {
        delete global.fetch;
        jest.restoreAllMocks();
    });

    test('acknowledges immediately so Telegram does not retry', async () => {
        db.query.mockResolvedValue([[]]);
        const res = await request(app)
            .post('/webhook/telegram')
            .send({ message: { chat: { id: 123 }, text: '/help' } });

        expect(res.status).toBe(200);
    });

    test('acknowledges even on a malformed update', async () => {
        db.query.mockResolvedValue([[]]);
        const res = await request(app).post('/webhook/telegram').send({});

        expect(res.status).toBe(200);
    });
});

/**
 * The update body carries the chat id it claims to come from, so an unauthenticated
 * endpoint lets anyone forge a message from any chat — logging expenses into a
 * stranger's account, or attaching their SmartFin account to the attacker's Telegram
 * via /link_google. Telegram echoes the secret_token passed to setWebhook on every
 * delivery; that is what proves an update is really from Telegram.
 */
describe('POST /webhook/telegram — secret token', () => {
    const SECRET = 'telegram-webhook-secret';
    let freshApp;
    let freshDb;

    beforeEach(() => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
        // The controller reads the secret at load time, so the module cache is dropped
        // to exercise the configured path. That gives the rebuilt app a NEW db mock
        // instance — assertions must target that one, not the module-level `db`, or
        // they inspect a mock nothing ever called and pass vacuously.
        jest.resetModules();
        process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
        const express = require('express');
        freshApp = express();
        freshApp.use(express.json());
        freshApp.use('/webhook', require('../../backend/src/routes/webhookRoutes'));
        freshDb = require('./setup/dbMock');
        freshDb.query.mockResolvedValue([[]]);
    });

    afterEach(() => {
        delete process.env.TELEGRAM_WEBHOOK_SECRET;
        delete global.fetch;
        jest.resetModules();
        jest.restoreAllMocks();
    });

    const update = { message: { chat: { id: 123 }, text: '/help' } };

    test('an update with the right secret is accepted', async () => {
        const res = await request(freshApp)
            .post('/webhook/telegram')
            .set('X-Telegram-Bot-Api-Secret-Token', SECRET)
            .send(update);

        expect(res.status).toBe(200);
    });

    test('an update with no secret is rejected once one is configured', async () => {
        const res = await request(freshApp).post('/webhook/telegram').send(update);
        expect(res.status).toBe(401);
    });

    test('an update with the wrong secret is rejected', async () => {
        const res = await request(freshApp)
            .post('/webhook/telegram')
            .set('X-Telegram-Bot-Api-Secret-Token', 'guessed')
            .send(update);

        expect(res.status).toBe(401);
    });

    test('a rejected update never reaches the database', async () => {
        freshDb.query.mockClear();
        await request(freshApp).post('/webhook/telegram').send(update);
        expect(freshDb.query).not.toHaveBeenCalled();
    });

    // Positive control for the test above: proves the assertion is watching the mock the
    // rebuilt app actually uses, so "no calls" means rejection and not a mis-wired spy.
    test('an accepted update does reach the database', async () => {
        freshDb.query.mockClear();
        await request(freshApp)
            .post('/webhook/telegram')
            .set('X-Telegram-Bot-Api-Secret-Token', SECRET)
            .send({ message: { chat: { id: 123 }, text: '55 shawarma' } });

        expect(freshDb.query).toHaveBeenCalled();
    });
});
