const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function issueToken(user) {
    return jwt.sign(
        { user_id: user.user_id, username: user.username },
        process.env.JWT_SECRET,
        { expiresIn: '365d' }
    );
}

exports.login = async (req, res) => {
    const { user_id, pin } = req.body;
    if (!user_id || !pin) {
        return res.status(400).json({ error: 'user_id and pin are required' });
    }
    try {
        const [rows] = await db.query(
            'SELECT user_id, username, pin_hash FROM users WHERE user_id = ?',
            [user_id]
        );
        if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

        const user = rows[0];
        const valid = await bcrypt.compare(String(pin), user.pin_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        res.json({ token: issueToken(user) });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.googleLogin = async (req, res) => {
    const { id_token } = req.body;
    if (!id_token) return res.status(400).json({ error: 'id_token is required' });

    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: id_token,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const { email } = ticket.getPayload();

        const [rows] = await db.query(
            'SELECT user_id, username FROM users WHERE google_email = ?',
            [email]
        );

        if (!rows.length) {
            return res.status(404).json({
                error: 'not_linked',
                message: `No Telegram account linked to ${email}. Send /link_google ${email} to the bot first.`,
            });
        }

        res.json({ token: issueToken(rows[0]) });
    } catch (err) {
        console.error('Google login error:', err);
        res.status(401).json({ error: 'Invalid Google token' });
    }
};
