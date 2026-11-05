// Creates or revokes a read-only API key for the external AI agent (/api/agent/*).
//
//   docker compose exec backend node scripts/createAgentKey.js create <email> [label]
//   docker compose exec backend node scripts/createAgentKey.js list   <email>
//   docker compose exec backend node scripts/createAgentKey.js revoke <key_id>
//
// The key is printed ONCE; only its SHA-256 is stored.
require('dotenv').config();
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), override: false });
const crypto = require('crypto');
const db = require('../src/config/db');
const { hashKey } = require('../src/middleware/agentAuth');

async function userIdByEmail(email) {
    const [rows] = await db.query('SELECT user_id FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);
    if (!rows.length) throw new Error(`No user with email ${email}`);
    return rows[0].user_id;
}

async function main() {
    const [cmd, arg, label] = process.argv.slice(2);
    if (cmd === 'create' && arg) {
        const userId = await userIdByEmail(arg);
        const key = 'sfa_' + crypto.randomBytes(24).toString('hex');
        const [r] = await db.query(
            'INSERT INTO agent_api_keys (user_id, key_hash, label) VALUES (?, ?, ?)',
            [userId, hashKey(key), label || 'agent']
        );
        console.log(`key_id: ${r.insertId}`);
        console.log(`API key (shown once, store it in the agent): ${key}`);
    } else if (cmd === 'list' && arg) {
        const userId = await userIdByEmail(arg);
        const [rows] = await db.query(
            'SELECT key_id, label, created_at, last_used_at, revoked_at FROM agent_api_keys WHERE user_id = ?',
            [userId]
        );
        console.table(rows);
    } else if (cmd === 'revoke' && arg) {
        const [r] = await db.query('UPDATE agent_api_keys SET revoked_at = NOW() WHERE key_id = ? AND revoked_at IS NULL', [arg]);
        console.log(r.affectedRows ? `Revoked key ${arg}` : `Key ${arg} not found or already revoked`);
    } else {
        console.log('Usage: node scripts/createAgentKey.js create <email> [label] | list <email> | revoke <key_id>');
        process.exitCode = 1;
    }
}

main()
    .catch(err => { console.error(err.message); process.exitCode = 1; })
    .finally(() => db.end && db.end());
