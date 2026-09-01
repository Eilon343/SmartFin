const db = require('../config/db');
const cycle = require('../services/cycle');

/**
 * User preferences that change what a "period" means. Read once by the frontend at start-up
 * and held in SettingsContext, because every screen's month picker is built from them.
 *
 * The response carries the resolved current cycle alongside the raw days so the client never
 * has to agree with the server about where a boundary falls — it is told.
 */
exports.getSettings = async (req, res) => {
    const user_id = req.user.user_id;
    try {
        const [rows] = await db.query(
            'SELECT cycle_anchor_day, salary_day FROM users WHERE user_id = ?',
            [user_id]
        );
        if (!rows || rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const settings = rows[0];
        const key = cycle.currentCycleKey(settings);
        res.json({
            cycle_anchor_day: Number(settings.cycle_anchor_day),
            salary_day: Number(settings.salary_day),
            min_day: cycle.MIN_DAY,
            max_day: cycle.MAX_DAY,
            current_cycle: cycle.resolveCycle(key, settings),
        });
    } catch (err) {
        console.error('getSettings error:', err);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
};

/**
 * Partial update — either day may be sent alone.
 *
 * Both are rejected outside 1..28 rather than clamped: 31 is a plausible thing for a user to
 * type, and silently storing 28 would mean their dashboard quietly disagrees with the number
 * on screen. The DB CHECK constraint says the same thing; this is the readable half.
 */
exports.updateSettings = async (req, res) => {
    const user_id = req.user.user_id;
    const { cycle_anchor_day, salary_day } = req.body || {};

    const updates = [];
    const params = [];
    for (const [column, value] of [['cycle_anchor_day', cycle_anchor_day], ['salary_day', salary_day]]) {
        if (value === undefined) continue;
        if (!cycle.isValidDay(value)) {
            return res.status(400).json({
                error: `${column} must be a whole number between ${cycle.MIN_DAY} and ${cycle.MAX_DAY}`,
            });
        }
        updates.push(`${column} = ?`);
        params.push(Number(value));
    }
    if (updates.length === 0) {
        return res.status(400).json({ error: 'Nothing to update' });
    }

    try {
        await db.query(`UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`, [...params, user_id]);
        return exports.getSettings(req, res);
    } catch (err) {
        console.error('updateSettings error:', err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
};
