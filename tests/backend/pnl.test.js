const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { authHeader, TEST_USER } = require('./setup/authHelper');

// Helper: mock all 7 DB calls for getPnL (1 auth + 6 business queries in Promise.all)
function mockPnL({ expenses = '0', subscriptions = '0', savings = '0', fixedIncome = '0', variableActual = '0', variablePastTotal = '0', variablePastMonths = '0' } = {}) {
    db.query
        .mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]])              // auth
        .mockResolvedValueOnce([[{ total: expenses }]])                          // expenses this month
        .mockResolvedValueOnce([[{ total: subscriptions }]])                    // subscriptions
        .mockResolvedValueOnce([[{ total: savings }]])                           // savings allocations
        .mockResolvedValueOnce([[{ total: fixedIncome }]])                      // fixed income
        .mockResolvedValueOnce([[{ total: variableActual }]])                   // variable income actual
        .mockResolvedValueOnce([[{ total: variablePastTotal, months_with_data: variablePastMonths }]]); // variable past avg
}

// ── Response shape ────────────────────────────────────────────────────────────

describe('GET /api/pnl - response shape', () => {
    it('returns all required fields', async () => {
        mockPnL({ fixedIncome: '5000', variableActual: '500', expenses: '1000', subscriptions: '200', savings: '300' });

        const res = await request(app)
            .get('/api/pnl')
            .set(authHeader());

        expect(res.status).toBe(200);
        const body = res.body;
        expect(body).toHaveProperty('month');
        expect(body).toHaveProperty('fixed_income');
        expect(body).toHaveProperty('variable_income_actual');
        expect(body).toHaveProperty('variable_income_avg');
        expect(body).toHaveProperty('total_income_actual');
        expect(body).toHaveProperty('total_income_projected');
        expect(body).toHaveProperty('total_expenses');
        expect(body).toHaveProperty('projected_expenses');
        expect(body).toHaveProperty('subscription_total');
        expect(body).toHaveProperty('savings_allocation');
        expect(body).toHaveProperty('current_net_pnl');
        expect(body).toHaveProperty('forecasted_net_pnl');
    });
});

// ── current_net_pnl math ──────────────────────────────────────────────────────

describe('GET /api/pnl - current_net_pnl is always based on actual data', () => {
    it('computes: fixed + variable_actual - expenses - savings, excluding subs', async () => {
        // Subscriptions are money still ahead of us, not money that has moved, so they
        // stay out of current_net_pnl: 5000 + 500 - 1000 - 300 = 4200.
        mockPnL({ fixedIncome: '5000', variableActual: '500', expenses: '1000', subscriptions: '200', savings: '300' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.current_net_pnl).toBe(4200);
        expect(res.body.total_income_actual).toBe(5500);
    });

    it('user scenario: 1100 income, 30 expenses, 200 savings → 870', async () => {
        mockPnL({ variableActual: '1100', expenses: '30', savings: '200' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.current_net_pnl).toBe(870);
    });

    it('zero everything → zero net', async () => {
        mockPnL();

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.current_net_pnl).toBe(0);
    });

    it('more expenses than income → negative net', async () => {
        // 1000 - 1500 - 0 - 0 = -500
        mockPnL({ fixedIncome: '1000', expenses: '1500' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.current_net_pnl).toBe(-500);
    });
});

// ── variable_avg denominator fix ──────────────────────────────────────────────

describe('GET /api/pnl - variable_avg uses actual months with data', () => {
    it('new user (0 months history) → avg = 0, not NaN', async () => {
        mockPnL({ variableActual: '1100', variablePastTotal: '0', variablePastMonths: '0' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.variable_income_avg).toBe(0);
        expect(Number.isFinite(res.body.forecasted_net_pnl)).toBe(true);
    });

    it('1 month of history → divides by 1', async () => {
        mockPnL({ variablePastTotal: '900', variablePastMonths: '1' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.variable_income_avg).toBe(900);
    });

    it('2 months of history in a 3-month lookback → divides by 2 not 3', async () => {
        // Old bug: 1800/3 = 600. Fix: 1800/2 = 900
        mockPnL({ variablePastTotal: '1800', variablePastMonths: '2' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.variable_income_avg).toBe(900);
    });

    it('3 months of history → divides by 3', async () => {
        mockPnL({ variablePastTotal: '2700', variablePastMonths: '3' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.variable_income_avg).toBe(900);
    });
});

// ── projected_income uses max(actual, avg) ────────────────────────────────────

describe('GET /api/pnl - forecasted income uses max(actual, avg)', () => {
    it('actual > avg → uses actual (windfall month)', async () => {
        // actual=1100, avg=300 → projected uses 1100
        mockPnL({ fixedIncome: '5000', variableActual: '1100', variablePastTotal: '900', variablePastMonths: '3' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.total_income_projected).toBe(6100); // 5000 + max(1100, 300)
    });

    it('avg > actual → uses avg (income not received yet this month)', async () => {
        // actual=0, avg=900 → projected uses 900
        mockPnL({ fixedIncome: '5000', variableActual: '0', variablePastTotal: '2700', variablePastMonths: '3' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.total_income_projected).toBe(5900); // 5000 + max(0, 900)
    });

    it('original bug: new user with variable income stays positive in forecast', async () => {
        // Before fix: projected_income = 0 + 0 = 0 → forecast goes negative
        // After fix:  projected_income = 0 + max(1100, 0) = 1100 → forecast stays positive
        mockPnL({ variableActual: '1100', expenses: '30', savings: '200', variablePastMonths: '0' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.forecasted_net_pnl).toBeGreaterThan(0);
        expect(res.body.total_income_projected).toBe(1100);
    });
});

// ── projected_expenses scaling ─────────────────────────────────────────────────

describe('GET /api/pnl - projected_expenses only scales current month', () => {
    it('past month query returns actual expenses unchanged', async () => {
        // When querying a past month, projected_expenses === total_expenses
        mockPnL({ expenses: '1500' });

        const res = await request(app)
            .get('/api/pnl?month=2025-01')
            .set(authHeader());

        expect(res.body.projected_expenses).toBe(1500);
        expect(res.body.total_expenses).toBe(1500);
    });

    it('zero expenses → zero projected regardless of day', async () => {
        mockPnL({ expenses: '0' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.projected_expenses).toBe(0);
    });
});

// ── Invalid month format ──────────────────────────────────────────────────────

describe('GET /api/pnl - validation', () => {
    it('rejects invalid month format', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]); // auth

        const res = await request(app)
            .get('/api/pnl?month=not-a-month')
            .set(authHeader());

        expect(res.status).toBe(400);
    });

    it('requires auth', async () => {
        const res = await request(app).get('/api/pnl');
        expect(res.status).toBe(401);
    });
});

// ── subscriptions are a forecast, not a second record of the same money ───────

describe('GET /api/pnl - subscription double-counting', () => {
    /**
     * Bank/card sync imports the real subscription charge into `expenses`. Counting the
     * `subscriptions` row on top subtracted the same money twice, understating P&L by
     * the full subscription bill every month.
     */
    // The billing-day gate lives in SQL because it compares against the DB's CURDATE(),
    // which a mocked pool cannot evaluate. Asserting the clause is the only way to pin
    // the rule from here; the arithmetic it feeds is covered behaviourally below.
    it('gates subscriptions on the billing day, per month direction', async () => {
        db.query.mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]]);
        db.query.mockResolvedValue([[{ total: '0', months_with_data: '0' }]]);

        await request(app).get('/api/pnl').set(authHeader());

        const subQuery = db.query.mock.calls
            .map(([sql]) => sql)
            .find((sql) => /FROM subscriptions/i.test(sql));

        // future month → all subs; current month → only days still ahead; past → none.
        expect(subQuery).toContain("? > DATE_FORMAT(CURDATE(), '%Y-%m')");
        expect(subQuery).toContain('day_of_month > DAY(CURDATE())');
    });

    it('keeps an upcoming subscription out of current_net_pnl', async () => {
        // It has not been paid yet, so it cannot reduce where the user stands today.
        mockPnL({ fixedIncome: '10000', expenses: '2000', subscriptions: '91' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.subscription_total).toBe(91);
        expect(res.body.current_net_pnl).toBe(10000 - 2000);
    });

    it('subtracts an upcoming subscription exactly once, in the forecast', async () => {
        // as_of_day pins the forecast to actuals, so the only gap between the two
        // figures is the subscription itself — subtracted once, and only here.
        mockPnL({ fixedIncome: '10000', expenses: '2000', subscriptions: '91' });

        const res = await request(app).get('/api/pnl?as_of_day=15').set(authHeader());

        // Absolute figures move with the MTD income pro-rate; the gap between them
        // is what this test pins.
        expect(res.body.forecasted_net_pnl).toBe(res.body.current_net_pnl - 91);
    });

    it('is not pro-rated by the MTD clamp', async () => {
        // Already forward-only, so halving it for a half-elapsed month would understate
        // what is still to be paid.
        mockPnL({ fixedIncome: '10000', expenses: '2000', subscriptions: '91' });

        const res = await request(app).get('/api/pnl?as_of_day=15').set(authHeader());

        expect(res.body.subscription_total).toBe(91);
    });
});
