const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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

        const token = jwt.sign(
            { user_id: user.user_id, username: user.username },
            process.env.JWT_SECRET,
            { expiresIn: '12h' }
        );
        res.json({ token });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};
