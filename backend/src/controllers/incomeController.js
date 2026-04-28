const db = require('../config/db');

exports.getIncome = async (req, res) => {
    const user_id = req.user.user_id;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'Invalid month format. Expected YYYY-MM.' });
    }
    try {
        const [rows] = await db.query(
            'SELECT * FROM income WHERE user_id = ? AND month = ? ORDER BY created_at DESC',
            [user_id, month]
        );
        res.json(rows.map(r => ({ ...r, amount: Number(r.amount) })));
    } catch (err) {
        console.error('getIncome error:', err);
        res.status(500).json({ error: 'Failed to fetch income' });
    }
};

exports.addIncome = async (req, res) => {
    const user_id = req.user.user_id;
    const { source, amount, type, month, currency, description } = req.body;
    if (!source || amount == null || isNaN(Number(amount)) || Number(amount) <= 0) {
        return res.status(400).json({ error: 'source and a valid positive amount are required' });
    }
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'month is required and must be in YYYY-MM format' });
    }
    if (type && type !== 'fixed' && type !== 'variable') {
        return res.status(400).json({ error: 'type must be "fixed" or "variable"' });
    }
    try {
        const [result] = await db.query(
            'INSERT INTO income (user_id, source, amount, currency, type, month, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user_id, source, Number(amount), currency || 'ILS', type || 'fixed', month, description || null]
        );
        res.json({ income_id: result.insertId });
    } catch (err) {
        console.error('addIncome error:', err);
        res.status(500).json({ error: 'Failed to add income' });
    }
};

exports.updateIncome = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    const { source, amount, type, month, currency, description } = req.body;
    
    if (!source || amount == null || Number(amount) <= 0 || !month) {
        return res.status(400).json({ error: 'source, amount (must be positive), and month are required' });
    }
    
    try {
        const [result] = await db.query(
            'UPDATE income SET source = ?, amount = ?, currency = ?, type = ?, month = ?, description = ? WHERE income_id = ? AND user_id = ?',
            [source, Number(amount), currency || 'ILS', type || 'fixed', month, description || null, id, user_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('updateIncome error:', err);
        res.status(500).json({ error: 'Failed to update income' });
    }
};

exports.deleteIncome = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    try {
        const [result] = await db.query('DELETE FROM income WHERE income_id = ? AND user_id = ?', [id, user_id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('deleteIncome error:', err);
        res.status(500).json({ error: 'Failed to delete income' });
    }
};

// Returns fixed income for the month plus averaged variable income (past 3 months).
exports.getIncomeSummary = async (req, res) => {
    const user_id = req.user.user_id;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'Invalid month format. Expected YYYY-MM.' });
    }

    try {
        const [fixedRows] = await db.query(
            "SELECT source, SUM(amount) AS amount FROM income WHERE user_id = ? AND type = 'fixed' AND month = ? GROUP BY source",
            [user_id, month]
        );

        const past3 = getPast3Months(month);
        const [varRows] = await db.query(
            "SELECT source, SUM(amount) AS total, COUNT(DISTINCT month) AS months_count " +
            "FROM income WHERE user_id = ? AND type = 'variable' AND month IN (?, ?, ?) GROUP BY source",
            [user_id, ...past3]
        );

        const variableAveraged = varRows.map(r => ({
            source: r.source,
            amount: Math.round((Number(r.total) / Math.max(Number(r.months_count), 1)) * 100) / 100,
            type: 'variable',
            averaged: true,
        }));

        const fixedTotal = fixedRows.reduce((s, r) => s + Number(r.amount), 0);
        const variableTotal = variableAveraged.reduce((s, r) => s + r.amount, 0);

        res.json({
            month,
            fixed: fixedRows.map(r => ({ source: r.source, amount: Number(r.amount), type: 'fixed' })),
            variable: variableAveraged,
            fixed_total: Math.round(fixedTotal * 100) / 100,
            variable_total: Math.round(variableTotal * 100) / 100,
            total: Math.round((fixedTotal + variableTotal) * 100) / 100,
        });
    } catch (err) {
        console.error('getIncomeSummary error:', err);
        res.status(500).json({ error: 'Failed to fetch income summary' });
    }
};

function getPast3Months(month) {
    const [y, m] = month.split('-').map(Number);
    const result = [];
    let cy = y, cm = m;
    for (let i = 0; i < 3; i++) {
        cm--;
        if (cm <= 0) { cm = 12; cy--; }
        result.push(`${cy}-${String(cm).padStart(2, '0')}`);
    }
    return result;
}
