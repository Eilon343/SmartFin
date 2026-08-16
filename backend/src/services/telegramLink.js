const crypto = require('crypto');
const db = require('../config/db');

// Telegram is linked FROM an authenticated web session: the app issues a short-lived,
// single-use code and the bot redeems it. A Telegram message can never create an account or
// attach itself to one it does not already own — which is what the old /link_google allowed.
//
// The bot (bot/app/database/DatabaseManager.py::redeem_link_code) carries a Python twin of
// redeemLinkCode. The aiogram bot talks to MySQL directly and does not go through this
// backend, so the rule genuinely has two implementations — the same arrangement as the two
// Gemini parsers. Change one, change the other.

const CODE_TTL_MINUTES = 10;
const CODE_LENGTH = 8;

// Crockford base32: no I/L/O/U, so the code survives being read aloud or retyped without
// the 1/I and 0/O confusions. 32^8 ≈ 1.1e12 combinations, single-use and valid 10 minutes.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateCode() {
    // rejection-free: 32 divides 256 evenly, so byte % 32 is uniform over the alphabet
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[bytes[i] % 32];
    return code;
}

function normalizeCode(code) {
    return String(code || '').trim().toUpperCase().replace(/[\s-]/g, '');
}

function hashCode(code) {
    return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

/**
 * Issues a fresh code for a user, invalidating any outstanding one so only a single code is
 * live at a time — a user who clicks "generate" twice should not leave the first code usable.
 */
async function issueLinkCode(userId) {
    await db.query(
        'UPDATE telegram_link_codes SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
        [userId]
    );

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);
    await db.query(
        'INSERT INTO telegram_link_codes (user_id, code_hash, expires_at) VALUES (?, ?, ?)',
        [userId, hashCode(code), expiresAt]
    );

    return { code, expires_at: expiresAt.toISOString() };
}

/**
 * Redeems a code for a Telegram chat id.
 *
 * Returns { ok: true, user_id } or { ok: false, reason } where reason is one of
 * 'invalid' (unknown, expired or already used) and 'chat_taken'.
 *
 * Every failure mode collapses to 'invalid' deliberately: telling the sender whether a code
 * was real-but-expired versus never real at all would help someone guessing at the space.
 */
async function redeemLinkCode(code, chatId) {
    const normalized = normalizeCode(code);
    if (!normalized) return { ok: false, reason: 'invalid' };

    // Claim and validate in one statement. Two concurrent redemptions of the same code both
    // reach this line, but only one can move used_at from NULL, so only one sees
    // affectedRows === 1. Checking first and updating after would let both through.
    //
    // The CLIENT_FOUND_ROWS caveat that applies elsewhere in this codebase does not bite
    // here: used_at genuinely changes value on a successful claim, so a matched-but-unchanged
    // row cannot be miscounted as a win.
    const [claim] = await db.query(
        `UPDATE telegram_link_codes SET used_at = NOW()
          WHERE code_hash = ? AND used_at IS NULL AND expires_at > NOW()`,
        [hashCode(normalized)]
    );
    if (!claim.affectedRows) return { ok: false, reason: 'invalid' };

    const [rows] = await db.query(
        'SELECT user_id FROM telegram_link_codes WHERE code_hash = ?',
        [hashCode(normalized)]
    );
    if (!rows.length) return { ok: false, reason: 'invalid' };
    const userId = rows[0].user_id;

    // telegram_chat_id is UNIQUE, so a chat already bound elsewhere would fail the UPDATE
    // with a duplicate-key error. Check first to return a message the user can act on.
    const [existing] = await db.query(
        'SELECT user_id FROM users WHERE telegram_chat_id = ?',
        [String(chatId)]
    );
    if (existing.length && String(existing[0].user_id) !== String(userId)) {
        return { ok: false, reason: 'chat_taken' };
    }

    await db.query('UPDATE users SET telegram_chat_id = ? WHERE user_id = ?', [String(chatId), userId]);
    return { ok: true, user_id: userId };
}

module.exports = { issueLinkCode, redeemLinkCode, hashCode, generateCode, CODE_TTL_MINUTES, CODE_LENGTH };
