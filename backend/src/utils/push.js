const crypto = require('crypto');
const webpush = require('web-push');
const db = require('../config/db');

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@smartfin.local';

const configured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (configured) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
    console.warn('Web Push disabled: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set');
}

const isPushConfigured = () => configured;

// Endpoints are long URLs, so uniqueness is enforced on a fixed-width hash of them.
const hashEndpoint = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex');

function isValidSubscription(sub) {
    return Boolean(
        sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) &&
        sub.endpoint.length <= 2048 &&
        typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string'
    );
}

async function saveSubscription(userId, sub) {
    // Re-subscribing on a device that another account used moves the endpoint to this user.
    await db.query(
        `INSERT INTO push_subscriptions (user_id, endpoint_hash, endpoint, p256dh, auth)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), endpoint = VALUES(endpoint),
                                 p256dh = VALUES(p256dh), auth = VALUES(auth)`,
        [userId, hashEndpoint(sub.endpoint), sub.endpoint, sub.keys.p256dh, sub.keys.auth]
    );
}

async function removeSubscription(endpoint) {
    await db.query('DELETE FROM push_subscriptions WHERE endpoint_hash = ?', [hashEndpoint(endpoint)]);
}

/**
 * Pushes to every device the user subscribed. Never throws.
 * @returns {Promise<{ sent: number, gone: number, failed: number }>}
 */
async function pushToUser(userId, payload) {
    const tally = { sent: 0, gone: 0, failed: 0 };
    let subs;
    try {
        [subs] = await db.query(
            'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
            [userId]
        );
    } catch (err) {
        console.error('Push: failed to load subscriptions:', err.message);
        tally.failed = 1;
        return tally;
    }

    const body = JSON.stringify(payload);
    const results = await Promise.all(subs.map(async (s) => {
        try {
            await webpush.sendNotification(
                { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
                body,
                { TTL: 24 * 60 * 60 }
            );
            return 'sent';
        } catch (err) {
            // 404/410: the browser dropped this subscription for good.
            if (err.statusCode === 404 || err.statusCode === 410) {
                await removeSubscription(s.endpoint).catch(() => {});
                return 'gone';
            }
            console.error(`Push to user ${userId} failed:`, err.statusCode || '', err.body || err.message);
            return 'failed';
        }
    }));

    for (const r of results) tally[r]++;
    return tally;
}

/**
 * Best-effort notification for background jobs.
 *
 * @returns {Promise<boolean>} false ONLY when nothing was delivered and a send failed
 *          transiently — so a caller holding a tally can retry. No subscriptions (or push
 *          not configured) counts as delivered: that user is owed nothing.
 */
async function sendPush(userId, payload) {
    if (!configured) return true;
    const { sent, failed } = await pushToUser(userId, payload);
    return sent > 0 || failed === 0;
}

module.exports = {
    sendPush, pushToUser, saveSubscription, removeSubscription, isValidSubscription, isPushConfigured, hashEndpoint,
};
