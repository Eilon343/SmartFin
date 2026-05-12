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

exports.updateSavingsGoal = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    const { name, target_amount, monthly_allocation, currency } = req.body;

    if (!name || target_amount == null || isNaN(Number(target_amount)) || Number(target_amount) <= 0) {
        return res.status(400).json({ error: 'name and a valid positive target_amount are required' });
    }
    if (monthly_allocation != null && (isNaN(Number(monthly_allocation)) || Number(monthly_allocation) < 0)) {
        return res.status(400).json({ error: 'monthly_allocation must be a non-negative number' });
    }
    try {
        const [result] = await db.query(
            'UPDATE savings_goals SET name = ?, target_amount = ?, monthly_allocation = ?, currency = ? WHERE goal_id = ? AND user_id = ?',
            [name, Number(target_amount), Number(monthly_allocation) || 0, currency || 'ILS', id, user_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('updateSavingsGoal error:', err);
        res.status(500).json({ error: 'Failed to update savings goal' });
    }
};

exports.depositToGoal = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    const { amount } = req.body;
    if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ error: 'amount must be positive' });
    }

    const [[goal]] = await db.query(
        'SELECT name, currency FROM savings_goals WHERE goal_id = ? AND user_id = ?',
        [id, user_id]
    ).catch(() => [[]]);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });

    const [[savingsCat]] = await db.query(
        "SELECT category_id FROM categories WHERE name = 'Savings' AND (user_id IS NULL OR user_id = ?) ORDER BY user_id IS NULL DESC LIMIT 1",
        [user_id]
    ).catch(() => [[]]);

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [result] = await conn.query(
            'UPDATE savings_goals SET saved_amount = saved_amount + ? WHERE goal_id = ? AND user_id = ?',
            [Number(amount), id, user_id]
        );
        if (result.affectedRows === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({ error: 'Goal not found' });
        }

        await conn.query(
            'INSERT INTO expenses (user_id, amount, currency, description, category_id, source, is_virtual, goal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [user_id, Number(amount), goal.currency || 'ILS', `Transfer → ${goal.name}`, savingsCat?.category_id || null, 'web', true, Number(id)]
        );

        await conn.commit();
        res.json({ success: true });
    } catch (err) {
        await conn.rollback();
        console.error('depositToGoal error:', err);
        res.status(500).json({ error: 'Failed to deposit to goal' });
    } finally {
        conn.release();
    }
};

exports.getGoalHistory = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    try {
        const [rows] = await db.query(
            `SELECT expense_id, amount, currency, description, created_at
             FROM expenses
             WHERE user_id = ? AND goal_id = ? AND is_virtual = TRUE
             ORDER BY created_at DESC
             LIMIT 100`,
            [user_id, id]
        );
        res.json(rows.map(r => ({ ...r, amount: Number(r.amount) })));
    } catch (err) {
        console.error('getGoalHistory error:', err);
        res.status(500).json({ error: 'Failed to fetch goal history' });
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
