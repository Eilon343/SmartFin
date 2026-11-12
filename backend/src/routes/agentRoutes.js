const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const agentAuth = require('../middleware/agentAuth');
const agentController = require('../controllers/agentController');

// Read-only endpoints for the external AI agent. This is the ONLY part of the API exposed
// to the internet (nginx :8081 block → Tailscale Funnel on :8443). Authenticated by an
// agent API key, never by the dashboard JWT, and nothing here writes.
const router = express.Router();

// Per key, not per IP: behind Funnel every request arrives from the same proxy.
const agentLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => crypto.createHash('sha256').update(req.headers.authorization || 'none').digest('hex'),
    message: { error: 'Too many requests, please try again later.' },
});

router.use(agentLimiter);
router.get('/snapshot', agentAuth, agentController.getSnapshot);
router.get('/what-if', agentAuth, agentController.whatIf);
// Proactive alerts, written by services/spendingAlerts.js on a timer. Still read-only.
router.get('/alerts', agentAuth, agentController.getAlerts);

module.exports = router;
