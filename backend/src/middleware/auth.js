const jwt = require('jsonwebtoken');
const db = require('../config/db');

module.exports = async function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = header.slice(7);
    let decoded;
    
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }

    try {
        // The existence check already reads the row, so the cycle settings ride along on it
        // rather than costing every controller a second round trip. `req.cycleSettings` is
        // the input to services/cycle.js and is present on every authenticated request.
        const [rows] = await db.query(
            'SELECT user_id, cycle_anchor_day, salary_day FROM users WHERE user_id = ?',
            [decoded.user_id]
        );
        if (!rows || rows.length === 0) {
            return res.status(401).json({ error: 'User no longer exists' });
        }
        req.user = decoded;
        req.cycleSettings = {
            cycle_anchor_day: rows[0].cycle_anchor_day,
            salary_day: rows[0].salary_day,
        };
        next();
    } catch (err) {
        console.error('Auth middleware db error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};
