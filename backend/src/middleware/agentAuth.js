const crypto = require('crypto');
const db = require('../config/db');

// Authenticates the external AI agent by a read-only API key (agent_api_keys), never by
// the dashboard JWT. Sets the same `req.user` / `req.cycleSettings` the JWT middleware
// does, so the agent controller can reuse the dashboard's own controllers unchanged.
//
// Keys are "sfa_" + 48 hex chars; only their SHA-256 is stored.
const KEY_PATTERN = /^sfa_[0-9a-f]{48}$/;

function hashKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

async function agentAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!KEY_PATTERN.test(key)) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const [rows] = await db.query(
            `SELECT k.key_id, u.user_id, u.cycle_anchor_day, u.salary_day
             FROM agent_api_keys k JOIN users u ON u.user_id = k.user_id
             WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
            [hashKey(key)]
        );
        if (!rows || rows.length === 0) return res.status(401).json({ error: 'Unauthorized' });

        const row = rows[0];
        req.user = { user_id: row.user_id, agent_key_id: row.key_id };
        req.cycleSettings = {
            cycle_anchor_day: row.cycle_anchor_day,
            salary_day: row.salary_day,
        };
        // Bookkeeping only; a failure here must not fail the read.
        db.query('UPDATE agent_api_keys SET last_used_at = NOW() WHERE key_id = ?', [row.key_id])
            .catch(err => console.error('agentAuth last_used_at error:', err));
        next();
    } catch (err) {
        console.error('agentAuth db error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = agentAuth;
module.exports.hashKey = hashKey;
module.exports.KEY_PATTERN = KEY_PATTERN;
