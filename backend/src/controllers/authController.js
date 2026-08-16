const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { issueLinkCode } = require('../services/telegramLink');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 8;

// Compared against when the email is unknown or the account has no password, so that path
// costs the same wall-clock time as a real wrong-password check. Without it, a fast 401
// means "no such account" and a slow one means "wrong password" — the response bodies being
// identical would not matter. Real cost-12 hash of 32 random bytes nobody can present.
const DUMMY_HASH = '$2b$12$GhrdBDaOTqq.SqUaSfkiyOAOdtgXemhGN0fW0tSUhyez3piD930/.';

// Deliberately identical for "email already taken" and every other sign-up rejection. A
// distinct 409 would turn the endpoint into an email-existence oracle: an attacker could
// walk a list of addresses and learn which ones have SmartFin accounts.
const SIGNUP_REJECTED = {
    error: 'signup_unavailable',
    message: 'Could not create an account with those details. If you already have one, sign in instead.',
};

const LOGIN_REJECTED = { error: 'invalid_credentials', message: 'Incorrect email or password.' };

function issueToken(user) {
    return jwt.sign(
        { user_id: user.user_id, username: user.username },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
    );
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

// Deliberately permissive: the goal is to reject obvious typos, not to adjudicate RFC 5322.
// Nothing downstream trusts this beyond it being a plausible address.
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 255;
}

function displayNameFor(name, email) {
    const trimmed = String(name || '').trim();
    if (trimmed) return trimmed.slice(0, 100);
    return email.split('@')[0].slice(0, 100);
}

exports.signup = async (req, res) => {
    const { email: rawEmail, password, name } = req.body || {};
    const email = normalizeEmail(rawEmail);

    if (!email || !password) {
        return res.status(400).json({ error: 'missing_fields', message: 'Email and password are required.' });
    }
    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'invalid_email', message: 'That email address is not valid.' });
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({
            error: 'weak_password',
            message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        });
    }

    try {
        // Hash BEFORE checking whether the email is taken, so both outcomes pay the same
        // ~200ms bcrypt cost. Checking first and hashing only on success would make a taken
        // address answer noticeably faster than a free one.
        const passwordHash = await bcrypt.hash(String(password), BCRYPT_COST);

        const [existing] = await db.query('SELECT user_id FROM users WHERE email = ?', [email]);
        if (existing.length) return res.status(409).json(SIGNUP_REJECTED);

        const username = displayNameFor(name, email);
        // No user_id supplied — AUTO_INCREMENT assigns one above the Telegram chat-id range
        // (migration 010). Base categories are shared at user_id IS NULL and are read via
        // `WHERE user_id IS NULL OR user_id = ?`, so a new account clones nothing.
        const [result] = await db.query(
            'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
            [username, email, passwordHash]
        );

        return res.status(201).json({ token: issueToken({ user_id: result.insertId, username }) });
    } catch (err) {
        // A racing signup for the same address trips the UNIQUE key. Answer exactly as the
        // pre-check does, so the race is not itself an existence oracle.
        if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json(SIGNUP_REJECTED);
        console.error('Signup error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

exports.login = async (req, res) => {
    const { email: rawEmail, password } = req.body || {};
    const email = normalizeEmail(rawEmail);

    if (!email || !password) {
        return res.status(400).json({ error: 'missing_fields', message: 'Email and password are required.' });
    }

    try {
        const [rows] = await db.query(
            'SELECT user_id, username, password_hash FROM users WHERE email = ?',
            [email]
        );

        // An unknown email and a Google-only account (password_hash IS NULL) both still run
        // a full bcrypt comparison against DUMMY_HASH before answering. Same body, same
        // status, same timing as a wrong password — none of the three is distinguishable.
        const user = rows[0];
        const hash = user && user.password_hash ? user.password_hash : DUMMY_HASH;
        const valid = await bcrypt.compare(String(password), hash);

        if (!user || !user.password_hash || !valid) return res.status(401).json(LOGIN_REJECTED);

        return res.json({ token: issueToken(user) });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

exports.googleLogin = async (req, res) => {
    const { id_token } = req.body || {};
    if (!id_token) return res.status(400).json({ error: 'id_token is required' });

    let payload;
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: id_token,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        payload = ticket.getPayload();
    } catch (err) {
        console.error('Google token verification failed:', err.message);
        return res.status(401).json({ error: 'Invalid Google token' });
    }

    const email = normalizeEmail(payload && payload.email);
    const emailVerified = payload && payload.email_verified === true;
    if (!email) return res.status(401).json({ error: 'Invalid Google token' });

    try {
        const [rows] = await db.query(
            'SELECT user_id, username, password_hash FROM users WHERE email = ?',
            [email]
        );

        if (!rows.length) {
            // Sign up with Google in one click. Google is the only party asserting this
            // address, and the account it creates is the first claim on it, so there is
            // nothing here to take over — email_verified is not required to create.
            const username = displayNameFor(payload.given_name || payload.name, email);
            const [result] = await db.query(
                'INSERT INTO users (username, email) VALUES (?, ?)',
                [username, email]
            );
            return res.json({ token: issueToken({ user_id: result.insertId, username }) });
        }

        const user = rows[0];

        // Merging a Google sign-in into an account that already has a password is the one
        // place an unverified claim is dangerous. Google sets email_verified only for
        // addresses it has itself confirmed control of; when it is false, Google is
        // explicitly declining to vouch. Honouring it anyway would let anyone who can attach
        // an arbitrary address to a Google account walk into the password account that owns
        // it — the same class of takeover this whole overhaul exists to close.
        //
        // Accounts with no password have no credential to steal, so they merge freely.
        if (user.password_hash && !emailVerified) {
            return res.status(401).json({
                error: 'email_unverified',
                message: 'Google has not verified this email address. Sign in with your password instead.',
            });
        }

        return res.json({ token: issueToken(user) });
    } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') {
            // Concurrent first-time Google sign-in for the same address; the other request won.
            const [rows] = await db.query('SELECT user_id, username FROM users WHERE email = ?', [email]);
            if (rows.length) return res.json({ token: issueToken(rows[0]) });
        }
        console.error('Google login error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

exports.getMe = async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT user_id, username, email, telegram_chat_id, password_hash, onboarded_at FROM users WHERE user_id = ?',
            [req.user.user_id]
        );
        if (!rows.length) return res.status(404).json({ error: 'not_found' });

        const user = rows[0];
        // password_hash is read only to derive has_password — never returned or logged.
        return res.json({
            user_id: user.user_id,
            username: user.username,
            email: user.email,
            telegram_linked: !!user.telegram_chat_id,
            has_password: !!user.password_hash,
            onboarded: !!user.onboarded_at,
        });
    } catch (err) {
        console.error('getMe error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Marks the welcome tour as finished. Idempotent, and deliberately write-once: the
 * `IS NULL` guard means re-finishing (or replaying it from Settings) keeps the original
 * date rather than resetting it, so onboarded_at stays a fact about when the user
 * actually started rather than the last time they opened the tour.
 */
exports.markOnboarded = async (req, res) => {
    try {
        await db.query(
            'UPDATE users SET onboarded_at = NOW() WHERE user_id = ? AND onboarded_at IS NULL',
            [req.user.user_id]
        );
        return res.json({ onboarded: true });
    } catch (err) {
        console.error('markOnboarded error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

exports.createTelegramLinkCode = async (req, res) => {
    try {
        const { code, expires_at } = await issueLinkCode(req.user.user_id);
        return res.status(201).json({ code, expires_at });
    } catch (err) {
        console.error('Link code error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

exports.unlinkTelegram = async (req, res) => {
    try {
        await db.query('UPDATE users SET telegram_chat_id = NULL WHERE user_id = ?', [req.user.user_id]);
        await db.query(
            'UPDATE telegram_link_codes SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
            [req.user.user_id]
        );
        return res.json({ telegram_linked: false });
    } catch (err) {
        console.error('Unlink Telegram error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};
