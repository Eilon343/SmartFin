const db = require('../config/db');

// Returns deep analytics for a single month — used by the Insights page.
// month=YYYY-MM (defaults to current). Returns:
//  - per-category totals (current, previous, 3-mo avg)
//  - daily totals for the requested month (1..days_in_month)
//  - weekend vs weekday averages (computed from daily)
//  - budget_total (sum of all category monthly_limits) used as the pacing target
exports.getInsights = async (req, res) => {
    const user_id = req.user.user_id;
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month format' });

    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();

    // previous month
    let py = y, pm = m - 1;
    if (pm === 0) { pm = 12; py--; }
    const prevMonth = `${py}-${String(pm).padStart(2, '0')}`;

    // 3-month avg window: months [m-3, m-2, m-1]
    const lookback = [];
    for (let i = 1; i <= 3; i++) {
        let yy = y, mm = m - i;
        while (mm <= 0) { mm += 12; yy--; }
        lookback.push(`${yy}-${String(mm).padStart(2, '0')}`);
    }

    try {
        const [catRows, curBuckets, prevBuckets, avgBuckets, dailyRows, budgetSumRow] = await Promise.all([
            db.query(
                `SELECT category_id, name, COALESCE(is_fixed, FALSE) AS is_fixed
                 FROM categories WHERE user_id IS NULL OR user_id = ?
                 ORDER BY is_base DESC, name`,
                [user_id]
            ),
            db.query(
                `SELECT category_id, COALESCE(SUM(amount), 0) AS total
                 FROM expenses
                 WHERE user_id = ?

                   AND created_at >= CONCAT(?, '-01')
                   AND created_at < DATE_ADD(CONCAT(?, '-01'), INTERVAL 1 MONTH)
                 GROUP BY category_id`,
                [user_id, month, month]
            ),
            db.query(
                `SELECT category_id, COALESCE(SUM(amount), 0) AS total
                 FROM expenses
                 WHERE user_id = ?

                   AND created_at >= CONCAT(?, '-01')
                   AND created_at < DATE_ADD(CONCAT(?, '-01'), INTERVAL 1 MONTH)
                 GROUP BY category_id`,
                [user_id, prevMonth, prevMonth]
            ),
            db.query(
                `SELECT category_id, DATE_FORMAT(created_at, '%Y-%m') AS mo, COALESCE(SUM(amount), 0) AS total
                 FROM expenses
                 WHERE user_id = ?

                   AND created_at >= CONCAT(?, '-01')
                   AND created_at < CONCAT(?, '-01')
                 GROUP BY category_id, mo`,
                [user_id, lookback[2], month]
            ),
            db.query(
                `SELECT DAY(created_at) AS d, COALESCE(SUM(amount), 0) AS total
                 FROM expenses
                 WHERE user_id = ?

                   AND created_at >= CONCAT(?, '-01')
                   AND created_at < DATE_ADD(CONCAT(?, '-01'), INTERVAL 1 MONTH)
                 GROUP BY DAY(created_at)
                 ORDER BY d`,
                [user_id, month, month]
            ),
            db.query(
                `SELECT COALESCE(SUM(monthly_limit), 0) AS total FROM budgets WHERE user_id = ?`,
                [user_id]
            ),
        ]);

        const categories = catRows[0];
        const curMap = Object.fromEntries(curBuckets[0].map(r => [r.category_id, Number(r.total)]));
        const prevMap = Object.fromEntries(prevBuckets[0].map(r => [r.category_id, Number(r.total)]));

        // 3-month avg per category — denom = months_with_data so partial history isn't unfairly low
        const avgAccum = {}; // {cat_id: { sum, monthsSet }}
        for (const r of avgBuckets[0]) {
            const cid = r.category_id;
            if (!avgAccum[cid]) avgAccum[cid] = { sum: 0, months: new Set() };
            avgAccum[cid].sum += Number(r.total);
            avgAccum[cid].months.add(r.mo);
        }

        const by_category = categories.map(c => {
            const a = avgAccum[c.category_id];
            const months_with_data = a ? a.months.size : 0;
            return {
                category_id: c.category_id,
                name: c.name,
                is_fixed: !!c.is_fixed,
                spent: Math.round((curMap[c.category_id] || 0) * 100) / 100,
                prev_spent: Math.round((prevMap[c.category_id] || 0) * 100) / 100,
                three_mo_avg: months_with_data > 0
                    ? Math.round((a.sum / months_with_data) * 100) / 100
                    : 0,
            };
        });

        // Daily array — index 0..daysInMonth-1; only past/today days are non-null for current month
        const today = new Date();
        const isCurrentMonth = today.getFullYear() === y && today.getMonth() === m - 1;
        const todayDay = isCurrentMonth ? today.getDate() : daysInMonth;

        const dayMap = {};
        for (const r of dailyRows[0]) dayMap[Number(r.d)] = Number(r.total);
        const daily = [];
        for (let d = 1; d <= daysInMonth; d++) {
            if (d > todayDay) daily.push(null);
            else daily.push(Math.round((dayMap[d] || 0) * 100) / 100);
        }

        // weekend vs weekday daily averages — use real day-of-week
        let weStot = 0, wdStot = 0, weDays = 0, wdDays = 0;
        for (let d = 1; d <= todayDay; d++) {
            const dow = new Date(y, m - 1, d).getDay(); // 0=Sun..6=Sat — Fri/Sat = weekend in IL
            const v = daily[d - 1] || 0;
            if (dow === 5 || dow === 6) { weStot += v; weDays++; } else { wdStot += v; wdDays++; }
        }
        const weekend_daily_avg = weDays ? Math.round((weStot / weDays) * 100) / 100 : 0;
        const weekday_daily_avg = wdDays ? Math.round((wdStot / wdDays) * 100) / 100 : 0;

        const total_spent = Math.round(by_category.reduce((s, c) => s + c.spent, 0) * 100) / 100;
        const three_mo_avg_total = Math.round(by_category.reduce((s, c) => s + c.three_mo_avg, 0) * 100) / 100;
        const budget_total = Math.round(Number(budgetSumRow[0][0]?.total || 0) * 100) / 100;

        res.json({
            month,
            prev_month: prevMonth,
            days_in_month: daysInMonth,
            today_day: todayDay,
            is_current_month: isCurrentMonth,
            budget_total,
            total_spent,
            three_mo_avg_total,
            by_category,
            daily,
            weekend_daily_avg,
            weekday_daily_avg,
        });
    } catch (err) {
        console.error('getInsights error:', err);
        res.status(500).json({ error: 'Failed to fetch insights' });
    }
};
