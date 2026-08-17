const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { authHeader, TEST_USER } = require('./setup/authHelper');

/**
 * Mock all 9 DB calls for getPnL (1 auth + 8 business queries in Promise.all).
 *
 * The two history queries return one row PER MONTH now, not a pre-averaged total: the
 * decay weighting and the standard deviation behind the forecast range both need the
 * individual months. `history(n, v)` builds n months of value v ending last month.
 */
const MONTH_NOW = new Date().toISOString().slice(0, 7);

function history(months, perMonth, anchor = MONTH_NOW) {
    const [y, m] = anchor.split('-').map(Number);
    const rows = [];
    for (let i = 1; i <= months; i++) {
        let yy = y, mm = m - i;
        while (mm <= 0) { mm += 12; yy--; }
        rows.push({ month: `${yy}-${String(mm).padStart(2, '0')}`, total: String(perMonth) });
    }
    return rows;
}

function mockPnL({
    expenses = '0', subscriptions = '0', savings = '0',
    fixedIncome = '0', variableActual = '0',
    incomeHistory = [], expenseHistory = [], dow = [],
} = {}) {
    db.query
        .mockResolvedValueOnce([[{ user_id: TEST_USER.user_id }]])   // auth
        .mockResolvedValueOnce([[{ total: expenses }]])              // expenses this month
        .mockResolvedValueOnce([[{ total: subscriptions }]])         // subscriptions
        .mockResolvedValueOnce([[{ total: savings }]])               // savings allocations
        .mockResolvedValueOnce([[{ total: fixedIncome }]])           // fixed income
        .mockResolvedValueOnce([[{ total: variableActual }]])        // variable income actual
        .mockResolvedValueOnce([incomeHistory])                      // variable income per month
        .mockResolvedValueOnce([expenseHistory])                     // variable expenses per month
        .mockResolvedValueOnce([dow]);                               // day-of-week shape
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
        expect(body).toHaveProperty('forecast_low');
        expect(body).toHaveProperty('forecast_high');
        expect(body).toHaveProperty('safe_to_spend_per_day');
        expect(body).toHaveProperty('days_left');
        expect(body).toHaveProperty('history_months');
    });

    it('every money field is a finite number or an explicit null', () => {
        mockPnL({ fixedIncome: '5000', expenses: '1000' });

        return request(app).get('/api/pnl').set(authHeader()).then(res => {
            for (const [k, v] of Object.entries(res.body)) {
                if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
                expect(v === undefined).toBe(false);
                expect(Number.isNaN(v)).toBe(false);
                void k;
            }
        });
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
        mockPnL({ variableActual: '1100', incomeHistory: [] });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.variable_income_avg).toBe(0);
        expect(Number.isFinite(res.body.forecasted_net_pnl)).toBe(true);
    });

    it('1 month of history → divides by 1', async () => {
        mockPnL({ incomeHistory: history(1, 900) });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.variable_income_avg).toBe(900);
    });

    it('2 months of history in a 6-month lookback → divides by 2, not by 6', async () => {
        // The bug this has always guarded: 1800 over two months read as 300 if the
        // denominator were the window length rather than the months that hold data.
        mockPnL({ incomeHistory: history(2, 900) });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.variable_income_avg).toBe(900);
    });

    it('a full 6 months of equal history averages to that value', async () => {
        mockPnL({ incomeHistory: history(6, 900) });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.variable_income_avg).toBe(900);
    });

    it('weights recent months more heavily than old ones', async () => {
        // Same six totals, opposite order. A flat mean would score these identically.
        const rising = history(6, 0).map((r, i) => ({ ...r, total: String(i === 0 ? 2000 : 1000) }));
        const falling = history(6, 0).map((r, i) => ({ ...r, total: String(i === 5 ? 2000 : 1000) }));

        mockPnL({ incomeHistory: rising });
        const a = await request(app).get('/api/pnl').set(authHeader());
        mockPnL({ incomeHistory: falling });
        const b = await request(app).get('/api/pnl').set(authHeader());

        expect(a.body.variable_income_avg).toBeGreaterThan(b.body.variable_income_avg);
    });

    it('reports how many months of history it actually had', async () => {
        mockPnL({ incomeHistory: history(4, 900), expenseHistory: history(2, 500) });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.history_months).toBe(4);
    });
});

// ── projected_income: the unbiased expectation, not a floor ───────────────────

describe('GET /api/pnl - forecasted income', () => {
    /**
     * `max(variable_actual, variable_avg)` was a floor, not an estimator. Late in the
     * month it quietly propped a genuinely bad income month back up to the average, so
     * the forecast could never warn anyone their income had fallen short. It now adds the
     * still-expected remainder to what has actually arrived.
     */
    it('never forecasts less income than has already arrived', async () => {
        mockPnL({ fixedIncome: '5000', variableActual: '1100', incomeHistory: history(6, 300) });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.total_income_projected).toBeGreaterThanOrEqual(6100);
    });

    it('a windfall is never talked back down to the average', async () => {
        mockPnL({ fixedIncome: '5000', variableActual: '1100', incomeHistory: history(6, 300) });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.variable_income_avg).toBe(300);
        expect(res.body.total_income_projected).toBeGreaterThan(5000 + 1100 - 0.01);
    });

    it('still expects the average when nothing has arrived yet', async () => {
        mockPnL({ fixedIncome: '5000', variableActual: '0', incomeHistory: history(6, 900) });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.total_income_projected).toBeGreaterThan(5000);
        expect(res.body.total_income_projected).toBeLessThanOrEqual(5900);
    });

    it('a future month expects the full historical average — nothing has happened yet', async () => {
        // Day 0 of the month: the whole thing is still ahead, so both estimators fall
        // through to the historical expectation exactly.
        const [y, m] = MONTH_NOW.split('-').map(Number);
        const future = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
        mockPnL({ fixedIncome: '5000', incomeHistory: history(6, 900, future) });

        const res = await request(app).get(`/api/pnl?month=${future}`).set(authHeader());

        expect(res.body.total_income_projected).toBeCloseTo(5900, 2);
    });

    it('original bug: new user with variable income stays positive in forecast', async () => {
        // Before: projected_income = 0 + 0 = 0 → forecast goes negative for someone who
        // had actually been paid. The floor at actuals is what keeps this fixed.
        mockPnL({ variableActual: '1100', expenses: '30', savings: '200', incomeHistory: [] });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.forecasted_net_pnl).toBeGreaterThan(0);
        expect(res.body.total_income_projected).toBe(1100);
    });
});

// ── forecast range and safe-to-spend ──────────────────────────────────────────

describe('GET /api/pnl - forecast range', () => {
    it('is null below two months of history rather than a fabricated interval', async () => {
        mockPnL({ expenses: '1000', incomeHistory: history(1, 900), expenseHistory: history(1, 500) });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.forecast_low).toBeNull();
        expect(res.body.forecast_high).toBeNull();
    });

    it('is null for a steady user whose months never differ', async () => {
        mockPnL({ expenses: '1000', incomeHistory: history(6, 900), expenseHistory: history(6, 500) });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.forecast_low).toBeNull();
    });

    it('brackets the point forecast when the months genuinely vary', async () => {
        const varied = history(6, 0).map((r, i) => ({ ...r, total: String(500 + i * 400) }));
        mockPnL({ expenses: '1000', expenseHistory: varied, incomeHistory: history(6, 900) });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.forecast_low).toBeLessThan(res.body.forecasted_net_pnl);
        expect(res.body.forecast_high).toBeGreaterThan(res.body.forecasted_net_pnl);
    });

    it('is suppressed for a past month — a finished month has no uncertainty left', async () => {
        const varied = history(6, 0, '2025-01').map((r, i) => ({ ...r, total: String(500 + i * 400) }));
        mockPnL({ expenses: '1000', expenseHistory: varied });

        const res = await request(app).get('/api/pnl?month=2025-01').set(authHeader());

        expect(res.body.forecast_low).toBeNull();
        expect(res.body.days_left).toBe(0);
    });
});

describe('GET /api/pnl - safe to spend', () => {
    it('is what is left per remaining day after everything committed', async () => {
        mockPnL({ fixedIncome: '10000', expenses: '2000', subscriptions: '300', savings: '500' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.safe_to_spend_headroom).toBeCloseTo(
            res.body.total_income_projected - 2000 - 300 - 500, 2);
        if (res.body.days_left > 0) {
            expect(res.body.safe_to_spend_per_day).toBeCloseTo(
                res.body.safe_to_spend_headroom / res.body.days_left, 2);
        }
    });

    it('goes negative once the month is committed past its income', async () => {
        mockPnL({ fixedIncome: '1000', expenses: '9000' });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.safe_to_spend_headroom).toBeLessThan(0);
    });

    it('is absent for a past month', async () => {
        mockPnL({ fixedIncome: '10000', expenses: '2000' });

        const res = await request(app).get('/api/pnl?month=2025-01').set(authHeader());

        expect(res.body.safe_to_spend_per_day).toBeNull();
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

    it('zero expenses and no history → zero projected', async () => {
        mockPnL({ expenses: '0', expenseHistory: [] });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.projected_expenses).toBe(0);
    });

    it('zero spend so far but a spending history → expects the habit, not ₪0', async () => {
        // The old code short-circuited to 0 whenever variable_sum was 0, telling a user
        // who simply had not spent yet that they were on course for a ₪0 month.
        mockPnL({ expenses: '0', expenseHistory: history(6, 3000) });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.projected_expenses).toBeGreaterThan(0);
        expect(res.body.projected_expenses).toBeLessThanOrEqual(3000);
    });

    it('never projects below what has already been spent', async () => {
        mockPnL({ expenses: '4000', expenseHistory: history(6, 500) });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.projected_expenses).toBeGreaterThanOrEqual(res.body.total_expenses);
    });

    it('an overspending month projects above the historical habit', async () => {
        mockPnL({ expenses: '9000', expenseHistory: history(6, 3000) });

        const res = await request(app).get('/api/pnl').set(authHeader());

        expect(res.body.projected_expenses).toBeGreaterThan(9000);
    });

    it('MTD clamp pins the projection to actuals', async () => {
        mockPnL({ expenses: '1200', expenseHistory: history(6, 3000) });

        const res = await request(app).get('/api/pnl?as_of_day=10').set(authHeader());

        expect(res.body.projected_expenses).toBe(1200);
        expect(res.body.is_mtd).toBe(true);
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
