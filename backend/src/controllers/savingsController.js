const db = require('../config/db');

exports.getSavingsGoals = async (req, res) => {
    const user_id = req.user.user_id;
    try {
        const [rows] = await db.query(
            'SELECT * FROM savings_goals WHERE user_id = ? AND active = TRUE ORDER BY created_at DESC',
            [user_id]
        );
        res.json(rows.map(r => ({
            ...r,
            target_amount: Number(r.target_amount),
            saved_amount: Number(r.saved_amount),
            monthly_allocation: Number(r.monthly_allocation),
            pct_complete: Number(r.target_amount) > 0
                ? Math.round((Number(r.saved_amount) / Number(r.target_amount)) * 100)
                : 0,
        })));
    } catch (err) {
        console.error('getSavingsGoals error:', err);
        res.status(500).json({ error: 'Failed to fetch savings goals' });
    }
};

exports.addSavingsGoal = async (req, res) => {
    const user_id = req.user.user_id;
    const { name, target_amount, monthly_allocation, currency } = req.body;
    if (!name || !target_amount) {
        return res.status(400).json({ error: 'name and target_amount are required' });
    }
    try {
        const [result] = await db.query(
            'INSERT INTO savings_goals (user_id, name, target_amount, monthly_allocation, currency) VALUES (?, ?, ?, ?, ?)',
            [user_id, name, Number(target_amount), Number(monthly_allocation) || 0, currency || 'ILS']
        );
        res.json({ goal_id: result.insertId });
    } catch (err) {
        console.error('addSavingsGoal error:', err);
        res.status(500).json({ error: 'Failed to add savings goal' });
    }
};

exports.depositToGoal = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    const { amount } = req.body;
    if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ error: 'amount must be positive' });
    }
    try {
        const [result] = await db.query(
            'UPDATE savings_goals SET saved_amount = saved_amount + ? WHERE goal_id = ? AND user_id = ?',
            [Number(amount), id, user_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Goal not found' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('depositToGoal error:', err);
        res.status(500).json({ error: 'Failed to deposit to goal' });
    }
};

exports.deleteGoal = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    try {
        await db.query(
            'UPDATE savings_goals SET active = FALSE WHERE goal_id = ? AND user_id = ?',
            [id, user_id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('deleteGoal error:', err);
        res.status(500).json({ error: 'Failed to delete goal' });
    }
};
