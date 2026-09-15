const push = require('../utils/push');

exports.subscribe = async (req, res) => {
    if (!push.isValidSubscription(req.body)) {
        return res.status(400).json({ error: 'Invalid push subscription' });
    }
    try {
        await push.saveSubscription(req.user.user_id, req.body);
        return res.status(201).json({ ok: true });
    } catch (err) {
        console.error('Save push subscription error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

// Unauthenticated on purpose: logout clears the token before the browser unsubscribes, and
// the endpoint URL itself is an unguessable capability issued by the push service.
exports.unsubscribe = async (req, res) => {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== 'string' || !endpoint) {
        return res.status(400).json({ error: 'endpoint is required' });
    }
    try {
        await push.removeSubscription(endpoint);
        return res.json({ ok: true });
    } catch (err) {
        console.error('Remove push subscription error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

exports.sendTest = async (req, res) => {
    if (!push.isPushConfigured()) {
        return res.status(503).json({ error: 'Push notifications are not configured on the server' });
    }
    try {
        const { sent, gone, failed } = await push.pushToUser(req.user.user_id, {
            title: 'SmartFin test notification',
            body: 'Push notifications are working 🎉',
            url: '/settings',
            tag: 'test',
            renotify: true,
        });
        if (sent > 0) return res.json({ ok: true, devices: sent });
        if (failed > 0) return res.status(502).json({ error: 'Push service rejected the notification' });
        // Every stored subscription had expired (and was just removed), or there were none.
        return res.status(404).json({
            error: gone > 0
                ? 'This device\'s subscription expired. Turn push notifications off and on again.'
                : 'No devices subscribed',
        });
    } catch (err) {
        console.error('Test push error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};
