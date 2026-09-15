jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));

process.env.VAPID_PUBLIC_KEY = 'test-public';
process.env.VAPID_PRIVATE_KEY = 'test-private';

const request = require('supertest');
const webpush = require('web-push');
const db = require('./setup/dbMock');
const { authHeader, TEST_USER } = require('./setup/authHelper');
const { sendPush, hashEndpoint, isValidSubscription } = require('../../backend/src/utils/push');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api', require('../../backend/src/routes/pushRoutes'));

const SUB = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: { p256dh: 'p256', auth: 'authkey' },
};
// The auth middleware reads the user row before any controller runs.
const signedIn = () => db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id, cycle_anchor_day: 1, salary_day: 1 }]]);
const row = (endpoint = SUB.endpoint) => ({ endpoint, p256dh: 'p256', auth: 'authkey' });

describe('isValidSubscription', () => {
    it('accepts a browser subscription and rejects malformed ones', () => {
        expect(isValidSubscription(SUB)).toBe(true);
        expect(isValidSubscription({ ...SUB, endpoint: 'http://insecure' })).toBe(false);
        expect(isValidSubscription({ endpoint: SUB.endpoint })).toBe(false);
        expect(isValidSubscription(null)).toBe(false);
    });
});

describe('sendPush', () => {
    it('counts a user with no devices as delivered', async () => {
        db.query.mockResolvedValueOnce([[]]);
        await expect(sendPush(42, { title: 'x' })).resolves.toBe(true);
        expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    it('sends the JSON payload to every device', async () => {
        db.query.mockResolvedValueOnce([[row('https://a'), row('https://b')]]);
        webpush.sendNotification.mockResolvedValue({});

        await expect(sendPush(42, { title: 'Hi', body: 'there' })).resolves.toBe(true);

        expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
        const [sub, body] = webpush.sendNotification.mock.calls[0];
        expect(sub).toEqual({ endpoint: 'https://a', keys: { p256dh: 'p256', auth: 'authkey' } });
        expect(JSON.parse(body)).toEqual({ title: 'Hi', body: 'there' });
    });

    it('prunes subscriptions the push service reports as gone', async () => {
        db.query.mockResolvedValueOnce([[row()]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
        webpush.sendNotification.mockRejectedValue({ statusCode: 410 });

        await expect(sendPush(42, { title: 'x' })).resolves.toBe(true);
        expect(db.query.mock.calls[1][0]).toMatch(/DELETE FROM push_subscriptions/);
        expect(db.query.mock.calls[1][1]).toEqual([hashEndpoint(SUB.endpoint)]);
    });

    it('reports a transient failure so the caller can retry', async () => {
        db.query.mockResolvedValueOnce([[row()]]);
        webpush.sendNotification.mockRejectedValue({ statusCode: 500 });
        jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(sendPush(42, { title: 'x' })).resolves.toBe(false);
    });

    it('never throws when the DB is down', async () => {
        db.query.mockRejectedValueOnce(new Error('down'));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(sendPush(42, { title: 'x' })).resolves.toBe(false);
    });
});

describe('push routes', () => {
    it('stores a subscription for the signed-in user', async () => {
        signedIn();
        db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
        const res = await request(app).post('/api/push/subscriptions').set(authHeader()).send(SUB);

        expect(res.status).toBe(201);
        expect(db.query.mock.calls[1][1]).toEqual([
            TEST_USER.user_id, hashEndpoint(SUB.endpoint), SUB.endpoint, 'p256', 'authkey',
        ]);
    });

    it('requires auth to subscribe', async () => {
        const res = await request(app).post('/api/push/subscriptions').send(SUB);
        expect(res.status).toBe(401);
    });

    it('rejects a malformed subscription', async () => {
        signedIn();
        const res = await request(app).post('/api/push/subscriptions').set(authHeader()).send({ endpoint: 'x' });
        expect(res.status).toBe(400);
    });

    it('unsubscribes by endpoint without a token (logout clears it first)', async () => {
        db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
        const res = await request(app).delete('/api/push/subscriptions').send({ endpoint: SUB.endpoint });
        expect(res.status).toBe(200);
        expect(db.query.mock.calls[0][1]).toEqual([hashEndpoint(SUB.endpoint)]);
    });

    it('sends a test notification to the user\'s devices', async () => {
        signedIn();
        db.query.mockResolvedValueOnce([[row()]]);
        webpush.sendNotification.mockResolvedValue({});

        const res = await request(app).post('/api/push/test').set(authHeader());

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, devices: 1 });
        expect(JSON.parse(webpush.sendNotification.mock.calls[0][1]).title).toMatch(/test/i);
    });

    it('tells the user when no device is subscribed', async () => {
        signedIn();
        db.query.mockResolvedValueOnce([[]]);
        const res = await request(app).post('/api/push/test').set(authHeader());
        expect(res.status).toBe(404);
    });

    // A test that reported success after the push service said the device was gone
    // would tell the user push works when nothing can ever arrive.
    it('does not report success when every subscription has expired', async () => {
        signedIn();
        db.query.mockResolvedValueOnce([[row()]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
        webpush.sendNotification.mockRejectedValue({ statusCode: 410 });

        const res = await request(app).post('/api/push/test').set(authHeader());

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/expired/);
    });
});
