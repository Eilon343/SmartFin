const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { authHeader, TEST_USER } = require('./setup/authHelper');

/**
 * `/api/insights` had no test file at all, which is how two counting bugs survived long
 * enough to be documented as "known inconsistencies" rather than fixed:
 *
 *   1. Not one of its expense queries filtered `is_virtual`, so savings-goal transfers
 *      were counted as spending on the donut, the momentum line, the trend bars and all
 *      three insight cards. The page could exceed the dashboard by exactly the month's
 *      savings.
 *   2. `by_category` walked the `categories` table while the spend map was keyed by
 *      category_id, so NULL-category rows matched nothing and vanished from total_spent —
 *      while `daily[]`, grouped by DAY rather than category, always included them. One
 *      response contradicted itself.
 *   3. The momentum chart paced ALL spending against a target of only the categories the
 *      user had budgeted, so anyone who budgets groceries but not rent was charged for
 *      their rent against a target that never contained it.
 *
 * All three are pinned below.
 */

const MONTH = '2025-03'; // a past month, so today_day is deterministic (= days_in_month)

function mockInsights({
    categories = [{ category_id: 1, name: 'Groceries', is_fixed: 0 }],
    current = [],
    previous = [],
    lookback = [],
    daily = [],
    budgets = [],
    dow = [],
    fixedDom = [],
} = {}) {
    db.query
        .mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]) // auth
        .mockResolvedValueOnce([categories])
        .mockResolvedValueOnce([current])
        .mockResolvedValueOnce([previous])
        .mockResolvedValueOnce([lookback])
        .mockResolvedValueOnce([daily])
        .mockResolvedValueOnce([budgets])
        .mockResolvedValueOnce([dow])
        .mockResolvedValueOnce([fixedDom]);
}

/** Every expense query the endpoint issues, for clause assertions. */
async function expenseQueries() {
    await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());
    return db.query.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => /FROM\s+expenses/i.test(sql));
}

// ── The is_virtual bug ────────────────────────────────────────────────────────

describe('GET /api/insights - savings transfers are not spending', () => {
    it('every expense query excludes is_virtual rows', async () => {
        mockInsights();
        const queries = await expenseQueries();

        expect(queries.length).toBeGreaterThanOrEqual(4);
        for (const sql of queries) {
            expect(sql).toMatch(/is_virtual\s*=\s*FALSE/i);
        }
    });

    it('does not silently drop the filter from the day-of-week query', async () => {
        // Added later than the rest, and the easiest one to forget.
        mockInsights();
        const queries = await expenseQueries();
        const dowQuery = queries.find((sql) => /DAYOFWEEK/i.test(sql));

        expect(dowQuery).toBeDefined();
        expect(dowQuery).toMatch(/is_virtual\s*=\s*FALSE/i);
    });
});

// ── The uncategorized bug ─────────────────────────────────────────────────────

describe('GET /api/insights - uncategorized spend', () => {
    it('surfaces null-category spend instead of dropping it', async () => {
        mockInsights({
            current: [
                { category_id: 1, total: '600' },
                { category_id: null, total: '250' },
            ],
        });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        const uncat = res.body.by_category.find((c) => c.category_id === null);
        expect(uncat).toBeDefined();
        expect(uncat.name).toBe('Uncategorized');
        expect(uncat.spent).toBe(250);
    });

    it('total_spent now agrees with the sum of daily[] in the same response', async () => {
        // This is the contradiction the bug produced: daily[] counted the ₪250, the
        // per-category total did not, and the momentum line ran above the burn-rate card.
        mockInsights({
            current: [
                { category_id: 1, total: '600' },
                { category_id: null, total: '250' },
            ],
            daily: [{ d: 3, total: '600' }, { d: 9, total: '250' }],
        });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        const dailySum = res.body.daily.reduce((s, v) => s + (v || 0), 0);
        expect(res.body.total_spent).toBe(850);
        expect(res.body.total_spent).toBeCloseTo(dailySum, 2);
    });

    it('omits the Uncategorized row entirely when there is no such spend', async () => {
        mockInsights({ current: [{ category_id: 1, total: '600' }] });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        expect(res.body.by_category.some((c) => c.category_id === null)).toBe(false);
    });

    it('carries the uncategorized previous month and 3-month average too', async () => {
        mockInsights({
            current: [{ category_id: null, total: '100' }],
            previous: [{ category_id: null, total: '400' }],
            lookback: [
                { category_id: null, mo: '2025-01', total: '300' },
                { category_id: null, mo: '2025-02', total: '500' },
            ],
        });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        const uncat = res.body.by_category.find((c) => c.category_id === null);
        expect(uncat.prev_spent).toBe(400);
        expect(uncat.three_mo_avg).toBe(400); // 800 over the 2 months that have data
    });
});

// ── Averaging denominator ─────────────────────────────────────────────────────

describe('GET /api/insights - per-category averages', () => {
    it('divides by months_with_data, not by the window length', async () => {
        mockInsights({
            lookback: [
                { category_id: 1, mo: '2025-01', total: '900' },
                { category_id: 1, mo: '2025-02', total: '900' },
            ],
        });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        const cat = res.body.by_category.find((c) => c.category_id === 1);
        expect(cat.three_mo_avg).toBe(900); // not 600
    });

    it('reports zero, not NaN, for a category with no history', async () => {
        mockInsights({ current: [{ category_id: 1, total: '50' }] });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        const cat = res.body.by_category.find((c) => c.category_id === 1);
        expect(cat.three_mo_avg).toBe(0);
        expect(Number.isFinite(res.body.three_mo_avg_total)).toBe(true);
    });
});

// ── Day-of-week weights for the momentum curve ────────────────────────────────

describe('GET /api/insights - day-of-week weights', () => {
    it('returns seven weights that sum to 1', async () => {
        mockInsights({ dow: [{ dow: 5, total: '900' }, { dow: 6, total: '900' }] });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        expect(res.body.dow_weights).toHaveLength(7);
        expect(res.body.dow_weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    });

    it('falls back to a flat week with no spending history', async () => {
        mockInsights({ dow: [] });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        for (const w of res.body.dow_weights) expect(w).toBeCloseTo(1 / 7, 10);
    });

    it('excludes fixed costs, which are day-of-MONTH events not day-of-week ones', async () => {
        // Rent is charged on the 1st. Over a 6-month window that lands on two Sundays and
        // two Wednesdays, and without this filter a ₪4,200 rent made those the "heavy"
        // weekdays and buried the real Fri/Sat signal entirely. Caught on live seed data.
        mockInsights();
        const queries = await expenseQueries();
        const dowQuery = queries.find((sql) => /DAYOFWEEK/i.test(sql));

        expect(dowQuery).toMatch(/is_fixed.*=\s*FALSE/is);
    });

    it('weights the Israeli weekend higher when that is where the money goes', async () => {
        mockInsights({
            dow: [
                { dow: 0, total: '100' }, { dow: 1, total: '100' }, { dow: 2, total: '100' },
                { dow: 3, total: '100' }, { dow: 4, total: '100' },
                { dow: 5, total: '600' }, { dow: 6, total: '600' },
            ],
        });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        const w = res.body.dow_weights;
        expect(w[5]).toBeGreaterThan(w[2]); // Friday over Tuesday
        expect(w[6]).toBeGreaterThan(w[2]); // Saturday over Tuesday
    });
});

// ── Weekend metric reliability counts ─────────────────────────────────────────

describe('GET /api/insights - weekend habit inputs', () => {
    it('reports how many of each kind of day have elapsed', async () => {
        // March 2025 is a full past month: 31 days, 4 Fridays and 5 Saturdays.
        mockInsights();

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        expect(res.body.weekend_days_elapsed + res.body.weekday_days_elapsed).toBe(31);
        expect(res.body.weekend_days_elapsed).toBe(9);
    });

    it('averages per day of that kind, not per day of the month', async () => {
        // 1 Mar 2025 is a Saturday. ₪900 there, across 9 weekend days → ₪100/day.
        mockInsights({ daily: [{ d: 1, is_fixed: 0, total: '900' }] });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        expect(res.body.weekend_daily_avg).toBe(100);
        expect(res.body.weekday_daily_avg).toBe(0);
    });

    it('ignores fixed costs, so rent falling on a Saturday is not a weekend habit', async () => {
        // The artefact this removes: rent is charged on the 1st, and when the 1st is a
        // Saturday it made the weekend look five times heavier than the week. daily[]
        // must still include it — it is real money — but the habit metric must not.
        mockInsights({
            daily: [
                { d: 1, is_fixed: 1, total: '4200' },  // rent, a Saturday
                { d: 3, is_fixed: 0, total: '180' },   // a Monday
            ],
        });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        expect(res.body.weekend_daily_avg).toBe(0);
        expect(res.body.daily[0]).toBe(4200);   // still counted as spending in daily[]
        expect(res.body.weekday_daily_avg).toBeGreaterThan(0); // the Monday still counts
    });
});

// ── Momentum pacing target ────────────────────────────────────────────────────

/**
 * The third counting bug, and the one that was documented as structural rather than
 * fixed: the momentum line summed every category while the target summed only the
 * budgets the user happened to set. On the demo account that was ₪3,400 of budgets
 * against a line carrying ₪4,200 of rent, and the chip read "over pace by ₪5,837" for a
 * month that was ~₪700 over on the categories the user had actually budgeted.
 */
const CATS = [
    { category_id: 1, name: 'Food', is_fixed: 0 },
    { category_id: 2, name: 'Transport', is_fixed: 0 },
    { category_id: 3, name: 'Housing', is_fixed: 1 },
    { category_id: 4, name: 'Utilities', is_fixed: 1 },
];

/** Three months of identical history, so each category's 3-month average is obvious. */
const HISTORY = ['2024-12', '2025-01', '2025-02'].flatMap((mo) => [
    { category_id: 1, mo, total: '1800' },
    { category_id: 2, mo, total: '700' },
    { category_id: 3, mo, total: '4200' },
    { category_id: 4, mo, total: '600' },
]);

const BUDGETS = [
    { category_id: 1, monthly_limit: '1600' },
    { category_id: 2, monthly_limit: '600' },
];

describe('GET /api/insights - momentum pacing target', () => {
    it('covers unbudgeted categories rather than pacing all spend against ₪2,200 of budgets', async () => {
        mockInsights({ categories: CATS, lookback: HISTORY, budgets: BUDGETS });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        expect(res.body.budget_total).toBe(2200);
        // Budgets where the user set them, habit where they did not.
        expect(res.body.pacing_target.budgeted).toBe(2200);
        expect(res.body.pacing_target.habit).toBe(4800); // Housing 4200 + Utilities 600
        expect(res.body.pacing_target.total).toBe(7000);
    });

    it('splits the target the same way the ideal curve paces it', async () => {
        mockInsights({ categories: CATS, lookback: HISTORY, budgets: BUDGETS });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());
        const p = res.body.pacing_target;

        expect(p.fixed).toBe(4800);
        expect(p.variable).toBe(2200);
        expect(p.fixed + p.variable).toBeCloseTo(p.total, 2);
        expect(p.budgeted_categories).toBe(2);
    });

    it('falls back to typical spending, unchanged, for a user with no budgets', async () => {
        // The path that was never broken. `three_mo_avg_total` is now reached by the
        // general rule instead of a separate branch, and must still produce the same
        // number — a budget-less user is the majority case.
        mockInsights({ categories: CATS, lookback: HISTORY, budgets: [] });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        expect(res.body.budget_total).toBe(0);
        expect(res.body.pacing_target.total).toBe(res.body.three_mo_avg_total);
        expect(res.body.pacing_target.budgeted_categories).toBe(0);
        expect(res.body.ideal[res.body.days_in_month - 1])
            .toBeCloseTo(res.body.three_mo_avg_total, 2);
    });

    it('counts uncategorized spend toward the target, since the line counts it too', async () => {
        mockInsights({
            categories: CATS,
            lookback: [...HISTORY, { category_id: null, mo: '2025-01', total: '400' }],
            budgets: BUDGETS,
        });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        // 7,000 + the ₪400 uncategorized average, in the variable half.
        expect(res.body.pacing_target.total).toBe(7400);
        expect(res.body.pacing_target.variable).toBe(2600);
    });
});

describe('GET /api/insights - the ideal curve', () => {
    it('reaches exactly the target on the last day of the month', async () => {
        mockInsights({ categories: CATS, lookback: HISTORY, budgets: BUDGETS });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        expect(res.body.ideal).toHaveLength(res.body.days_in_month);
        expect(res.body.ideal[res.body.days_in_month - 1])
            .toBeCloseTo(res.body.pacing_target.total, 2);
    });

    it('charges rent on the day it lands instead of smearing it across the month', async () => {
        // Every fixed shekel in the history was charged on the 1st, so by day 1 the ideal
        // already carries the whole ₪4,800 fixed half. Without this the chart spread the
        // rent evenly and reported a rent payer as ~₪4,600 over pace on the 1st.
        mockInsights({
            categories: CATS,
            lookback: HISTORY,
            budgets: BUDGETS,
            fixedDom: [{ dom: 1, total: '14400' }],
        });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        expect(res.body.ideal[0]).toBeGreaterThan(4800);
        expect(res.body.ideal[0]).toBeLessThan(4900); // 4,800 + one day of the variable half
    });

    it('is monotonically non-decreasing', async () => {
        mockInsights({
            categories: CATS,
            lookback: HISTORY,
            budgets: BUDGETS,
            fixedDom: [{ dom: 1, total: '12600' }, { dom: 10, total: '1800' }],
        });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        for (let i = 1; i < res.body.ideal.length; i++) {
            expect(res.body.ideal[i]).toBeGreaterThanOrEqual(res.body.ideal[i - 1]);
        }
    });

    it('reads the fixed shape from fixed categories only, over the full lookback', async () => {
        mockInsights();
        const queries = await expenseQueries();
        const domQuery = queries.find((sql) => /DAY\(e\.created_at\)\s+AS\s+dom/i.test(sql));

        expect(domQuery).toBeDefined();
        expect(domQuery).toMatch(/is_fixed.*=\s*TRUE/is);
        expect(domQuery).toMatch(/is_virtual\s*=\s*FALSE/i);
    });
});

// ── Shape and validation ──────────────────────────────────────────────────────

describe('GET /api/insights - shape and validation', () => {
    it('daily[] is indexed 1..days_in_month', async () => {
        mockInsights({ daily: [{ d: 5, total: '120' }] });

        const res = await request(app).get(`/api/insights?month=${MONTH}`).set(authHeader());

        expect(res.body.daily).toHaveLength(31);
        expect(res.body.daily[4]).toBe(120);
        expect(res.body.daily[0]).toBe(0);
    });

    it('rejects an invalid month format', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]);

        const res = await request(app).get('/api/insights?month=nope').set(authHeader());

        expect(res.status).toBe(400);
    });

    it('requires auth', async () => {
        const res = await request(app).get('/api/insights');
        expect(res.status).toBe(401);
    });
});
