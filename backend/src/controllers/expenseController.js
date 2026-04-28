const db = require('../config/db');

exports.getAllExpenses = async (req, res) => {
    const user_id = req.user.user_id;
    const { month } = req.query; // optional: "2025-04"
    if (month && !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month format' });

    try {
        let query = 'SELECT e.*, c.name AS category_name, e.source FROM expenses e LEFT JOIN categories c ON e.category_id = c.category_id WHERE e.user_id = ?';
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
    if (month && !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month format' });

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

exports.getBudgets = async (req, res) => {
    const user_id = req.user.user_id;
    const month = req.query.month || new Date().toISOString().slice(0, 7); // 'YYYY-MM'
    if (month && !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month format' });

    try {
        const [budgetRows] = await db.query(
            `SELECT b.budget_id, b.category_id, c.name AS category,
                    b.monthly_limit, b.carry_over,
                    DATE_FORMAT(b.created_at, '%Y-%m') AS start_month
             FROM budgets b JOIN categories c ON b.category_id = c.category_id
             WHERE b.user_id = ?`,
            [user_id]
        );

        // Fetch all expense totals per category per month in one query
        const earliestStart = budgetRows.reduce((min, b) => {
            const s = b.start_month <= month ? b.start_month : month;
            return s < min ? s : min;
        }, month);
        const [expenseRows] = await db.query(
            `SELECT category_id, DATE_FORMAT(created_at, '%Y-%m') AS mo, COALESCE(SUM(amount), 0) AS total
             FROM expenses
             WHERE user_id = ?
               AND created_at >= CONCAT(?, '-01')
               AND created_at < DATE_ADD(CONCAT(?, '-01'), INTERVAL 1 MONTH)
             GROUP BY category_id, mo`,
            [user_id, earliestStart, month]
        );
        const spentMap = {};
        for (const r of expenseRows) {
            if (!spentMap[r.category_id]) spentMap[r.category_id] = {};
            spentMap[r.category_id][r.mo] = Number(r.total);
        }
        const getSpent = (catId, mo) => (spentMap[catId]?.[mo] || 0);

        const result = [];
        const budgetedCategoryIds = new Set();

        for (const b of budgetRows) {
            budgetedCategoryIds.add(b.category_id);
            const limit = Number(b.monthly_limit);
            const startMonth = b.start_month <= month ? b.start_month : month;

            let carry = 0;
            if (b.carry_over) {
                const months = monthsBetween(startMonth, month);
                for (const m of months.slice(0, -1)) {
                    const leftover = (limit + carry) - getSpent(b.category_id, m);
                    carry = leftover > 0 ? leftover : 0;
                }
            }

            const spent_this_month = getSpent(b.category_id, month);
            const effective_limit = limit + carry;
            const remaining = effective_limit - spent_this_month;

            result.push({
                budget_id: b.budget_id,
                category_id: b.category_id,
                category: b.category,
                monthly_limit: limit,
                carry_over: !!b.carry_over,
                carried_in: Math.round(carry * 100) / 100,
                spent: Math.round(spent_this_month * 100) / 100,
                effective_limit: Math.round(effective_limit * 100) / 100,
                remaining: Math.round(remaining * 100) / 100,
                pct_used: effective_limit > 0 ? Math.round((spent_this_month / effective_limit) * 100) : 0,
                no_budget: false,
            });
        }

        // Also include all base/user categories not already covered by a budget entry
        const [allCatRows] = await db.query(
            `SELECT category_id, name AS category
             FROM categories
             WHERE user_id IS NULL OR user_id = ?
             ORDER BY is_base DESC, name`,
            [user_id]
        );

        for (const c of allCatRows) {
            if (!budgetedCategoryIds.has(c.category_id)) {
                result.push({
                    budget_id: null,
                    category_id: c.category_id,
                    category: c.category,
                    monthly_limit: null,
                    carry_over: false,
                    carried_in: 0,
                    spent: getSpent(c.category_id, month),
                    effective_limit: null,
                    remaining: null,
                    pct_used: null,
                    no_budget: true,
                });
            }
        }

        res.json({ month, budgets: result });
    } catch (err) {
        console.error('getBudgets error:', err);
        res.status(500).json({ error: 'Failed to fetch budgets' });
    }
};


function monthsBetween(start, end) {
    // start, end as 'YYYY-MM'; returns inclusive list
    const [sy, sm] = start.split('-').map(Number);
    const [ey, em] = end.split('-').map(Number);
    const months = [];
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
        months.push(`${y}-${String(m).padStart(2, '0')}`);
        m++;
        if (m > 12) { m = 1; y++; }
    }
    return months;
}

exports.getSubscriptions = async (req, res) => {
    const user_id = req.user.user_id;
    try {
        const [rows] = await db.query(
            `SELECT s.subscription_id, s.name, s.amount, s.currency,
                    s.day_of_month, s.active, s.last_charged_month,
                    s.category_id, c.name AS category
             FROM subscriptions s
             LEFT JOIN categories c ON s.category_id = c.category_id
             WHERE s.user_id = ? AND s.active = TRUE
             ORDER BY s.day_of_month`,
            [user_id]
        );
        res.json(rows.map(r => ({ ...r, amount: Number(r.amount) })));
    } catch (err) {
        console.error('getSubscriptions error:', err);
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
};

exports.addSubscription = async (req, res) => {
    const user_id = req.user.user_id;
    const { name, amount, currency = 'ILS', category_id, day_of_month } = req.body;
    if (!name || amount == null || !day_of_month) {
        return res.status(400).json({ error: 'name, amount, day_of_month required' });
    }
    const day = parseInt(day_of_month, 10);
    if (day < 1 || day > 28) return res.status(400).json({ error: 'day_of_month must be 1–28' });
    try {
        const [result] = await db.query(
            `INSERT INTO subscriptions (user_id, name, amount, currency, category_id, day_of_month)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [user_id, name.trim(), Number(amount), currency, category_id || null, day]
        );
        res.json({ subscription_id: result.insertId });
    } catch (err) {
        console.error('addSubscription error:', err);
        res.status(500).json({ error: 'Failed to add subscription' });
    }
};

exports.updateSubscription = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    const { name, amount, currency, category_id, day_of_month } = req.body;
    if (!name || amount == null || !day_of_month) {
        return res.status(400).json({ error: 'name, amount, day_of_month required' });
    }
    const day = parseInt(day_of_month, 10);
    if (day < 1 || day > 28) return res.status(400).json({ error: 'day_of_month must be 1–28' });
    try {
        const [result] = await db.query(
            `UPDATE subscriptions SET name=?, amount=?, currency=?, category_id=?, day_of_month=?
             WHERE subscription_id=? AND user_id=?`,
            [name.trim(), Number(amount), currency || 'ILS', category_id || null, day, id, user_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('updateSubscription error:', err);
        res.status(500).json({ error: 'Failed to update subscription' });
    }
};

exports.deleteSubscription = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    try {
        const [result] = await db.query(
            `UPDATE subscriptions SET active=FALSE WHERE subscription_id=? AND user_id=?`,
            [id, user_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('deleteSubscription error:', err);
        res.status(500).json({ error: 'Failed to delete subscription' });
    }
};

// P&L = fixed_income + avg_variable_income - expenses - subscription_total - savings_allocations
exports.getPnL = async (req, res) => {
    const user_id = req.user.user_id;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    if (month && !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month format' });

    try {
        const past3 = getPast3MonthsStr(month);
        const [[expRows], [subRows], [savRows], [fixedRows], [varRows]] = await Promise.all([
            db.query(
                "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE user_id = ? AND created_at >= CONCAT(?, '-01') AND created_at < DATE_ADD(CONCAT(?, '-01'), INTERVAL 1 MONTH)",
                [user_id, month, month]
            ),
            db.query(
                "SELECT COALESCE(SUM(amount), 0) AS total FROM subscriptions WHERE user_id = ? AND active = TRUE AND created_at < DATE_ADD(CONCAT(?, '-01'), INTERVAL 1 MONTH)",
                [user_id, month]
            ),
            db.query(
                "SELECT COALESCE(SUM(monthly_allocation), 0) AS total FROM savings_goals WHERE user_id = ? AND active = TRUE",
                [user_id]
            ),
            db.query(
                "SELECT COALESCE(SUM(amount), 0) AS total FROM income WHERE user_id = ? AND type = 'fixed' AND month = ?",
                [user_id, month]
            ),
            db.query(
                "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(DISTINCT month) AS cnt FROM income WHERE user_id = ? AND type = 'variable' AND month IN (?, ?, ?)",
                [user_id, ...past3]
            ),
        ]);
        const total_expenses = Number(expRows[0].total);
        const subscription_total = Number(subRows[0].total);
        const savings_allocation = Number(savRows[0].total);
        const fixed_income = Number(fixedRows[0].total);
        const variable_avg = Number(varRows[0].total) / Math.max(Number(varRows[0].cnt), 1);

        const total_income = fixed_income + variable_avg;
        const net_pnl = total_income - total_expenses - subscription_total - savings_allocation;

        res.json({
            month,
            fixed_income: Math.round(fixed_income * 100) / 100,
            variable_income_avg: Math.round(variable_avg * 100) / 100,
            total_income: Math.round(total_income * 100) / 100,
            total_expenses: Math.round(total_expenses * 100) / 100,
            subscription_total: Math.round(subscription_total * 100) / 100,
            savings_allocation: Math.round(savings_allocation * 100) / 100,
            net_pnl: Math.round(net_pnl * 100) / 100,
        });
    } catch (err) {
        console.error('getPnL error:', err);
        res.status(500).json({ error: 'Failed to calculate P&L' });
    }
};

function getPast3MonthsStr(month) {
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

exports.upsertBudget = async (req, res) => {
    const user_id = req.user.user_id;
    const { category_id, monthly_limit, carry_over } = req.body;
    if (!category_id || monthly_limit == null) {
        return res.status(400).json({ error: 'category_id and monthly_limit required' });
    }
    try {
        await db.query(
            `INSERT INTO budgets (user_id, category_id, monthly_limit, carry_over)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE monthly_limit = VALUES(monthly_limit), carry_over = VALUES(carry_over)`,
            [user_id, category_id, Number(monthly_limit), carry_over ? 1 : 0]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('upsertBudget error:', err);
        res.status(500).json({ error: 'Failed to save budget' });
    }
};

exports.addExpense = async (req, res) => {
    const user_id = req.user.user_id;
    const { amount, currency = 'ILS', description, category_id } = req.body;
    if (amount == null || isNaN(Number(amount)) || Number(amount) <= 0) return res.status(400).json({ error: 'Valid amount required' });
    try {
        const [result] = await db.query(
            'INSERT INTO expenses (user_id, amount, currency, description, category_id, source) VALUES (?, ?, ?, ?, ?, ?)',
            [user_id, Number(amount), currency, description?.trim() || null, category_id || null, 'web']
        );
        res.json({ expense_id: result.insertId });
    } catch (err) {
        console.error('addExpense error:', err);
        res.status(500).json({ error: 'Failed to add expense' });
    }
};

exports.deleteExpense = async (req, res) => {
    const user_id = req.user.user_id;
    const { id } = req.params;
    try {
        const [result] = await db.query(
            'DELETE FROM expenses WHERE expense_id = ? AND user_id = ?',
            [id, user_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('deleteExpense error:', err);
        res.status(500).json({ error: 'Failed to delete expense' });
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
