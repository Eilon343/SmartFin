const db = require('../config/db');

exports.getAllExpenses = async (req, res) => {
    const user_id = req.user.user_id;
    const { month } = req.query; // optional: "2025-04"

    try {
        let query = 'SELECT e.*, c.name AS category_name FROM expenses e LEFT JOIN categories c ON e.category_id = c.category_id WHERE e.user_id = ?';
        const params = [user_id];

        if (month) {
            query += ' AND DATE_FORMAT(e.created_at, "%Y-%m") = ?';
            params.push(month);
        }

        query += ' ORDER BY e.created_at DESC';
        const [rows] = await db.query(query, params);
        res.json(rows);
    } catch (err) {
        console.error('getAllExpenses error:', err);
        res.status(500).json({ error: 'Failed to fetch expenses' });
    }
};

exports.getSummary = async (req, res) => {
    const user_id = req.user.user_id;
    const month = req.query.month || new Date().toISOString().slice(0, 7); // default current month

    try {
        const [rows] = await db.query(
            `SELECT c.name AS category, SUM(e.amount) AS total
             FROM expenses e
             LEFT JOIN categories c ON e.category_id = c.category_id
             WHERE e.user_id = ? AND DATE_FORMAT(e.created_at, '%Y-%m') = ?
             GROUP BY e.category_id
             ORDER BY total DESC`,
            [user_id, month]
        );
        const grand_total = rows.reduce((sum, r) => sum + Number(r.total), 0);
        res.json({ month, grand_total, by_category: rows });
    } catch (err) {
        console.error('getSummary error:', err);
        res.status(500).json({ error: 'Failed to fetch summary' });
    }
};

exports.getCategories = async (req, res) => {
    const user_id = req.user.user_id;
    try {
        const [rows] = await db.query(
            'SELECT category_id, name, is_base FROM categories WHERE user_id IS NULL OR user_id = ? ORDER BY is_base DESC, name',
            [user_id]
        );
        res.json(rows);
    } catch (err) {
        console.error('getCategories error:', err);
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
};
