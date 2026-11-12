const cy = require('../../backend/src/services/cycle');
const { evaluate, SEVERITY } = require('../../backend/src/services/spendingAlerts');

/**
 * The rules are pure given a context, so they are tested directly rather than through the
 * scheduler. What matters is that each one fires on its own condition and stays silent
 * otherwise: a false positive here teaches the user to ignore the channel, which costs more
 * than a missed alert.
 */

const NOW = new Date('2026-11-12T10:00:00Z');
const SETTINGS = cy.normalizeSettings({ cycle_anchor_day: 1, salary_day: 10 });
const CYCLE_KEY = '2026-11';

// A healthy mid-cycle month: ₪12,000 in, ₪4,000 spent, comfortably positive.
const BASE_PNL = {
    cycle_day: 12,
    days_in_cycle: 30,
    days_left: 18,
    total_income_actual: 12000,
    total_income_projected: 12000,
    total_expenses: 4000,
    fixed_expenses: 0,
    variable_expenses: 4000,
    projected_expenses: 10000,
    subscription_total: 600,
    savings_allocation: 0,
    forecasted_net_pnl: 2000,
    safe_to_spend_headroom: 2000,
    safe_to_spend_per_day: 111,
};

function ctx(over = {}) {
    return {
        user: { user_id: 1 },
        settings: SETTINGS,
        cycleKey: CYCLE_KEY,
        cycle: cy.resolveCycle(CYCLE_KEY, SETTINGS),
        today: '2026-11-12',
        now: NOW,
        pnl: { ...BASE_PNL, ...(over.pnl || {}) },
        // The cycle-to-date clamp. Unless a test sets it, spending to date is all the
        // spending there is, which is the case for any cycle with no future-dated charges.
        pnlToDate: { ...BASE_PNL, ...(over.pnl || {}), ...(over.pnlToDate || {}) },
        recent: over.recent || [],
        sync: over.sync !== undefined ? over.sync : { connections: 1, failing: 0, last_ok: NOW },
    };
}

const rules = (c) => evaluate(c).map((a) => a.rule);
const find = (c, rule) => evaluate(c).find((a) => a.rule === rule);

describe('a healthy cycle', () => {
    it('raises nothing but the salary landing, which is once per cycle', () => {
        expect(rules(ctx())).toEqual(['salary_arrived']);
    });

    it('raises nothing once the salary has already been reported', () => {
        // salary_arrived is deduped on the cycle key, so the second tick writes nothing.
        const c = ctx();
        expect(evaluate(c).filter((a) => a.rule !== 'salary_arrived')).toEqual([]);
    });
});

describe('data_stale', () => {
    it('fires when a sync is in error', () => {
        expect(rules(ctx({ sync: { connections: 1, failing: 1, last_ok: NOW } }))).toContain('data_stale');
    });

    it('fires when nothing has synced for two days, even with no error reported', () => {
        const old = new Date('2026-11-09T10:00:00Z');
        expect(rules(ctx({ sync: { connections: 1, failing: 0, last_ok: old } }))).toContain('data_stale');
    });

    it('stays quiet for a user with no connections at all', () => {
        expect(rules(ctx({ sync: { connections: 0, failing: 0, last_ok: null } }))).not.toContain('data_stale');
    });

    it('never reveals anything about the bank behind the sync', () => {
        const alert = find(ctx({ sync: { connections: 2, failing: 1, last_ok: NOW } }), 'data_stale');
        expect(Object.keys(alert.payload).sort()).toEqual(
            ['healthy', 'hours_since_last_sync', 'last_successful_sync']
        );
        expect(JSON.stringify(alert.payload)).not.toMatch(/bank|account|connection/i);
    });
});

describe('salary rules', () => {
    it('reports an arrival once income exists', () => {
        expect(rules(ctx())).not.toContain('salary_missing');
        expect(find(ctx({ pnl: { total_income_actual: 0, forecasted_net_pnl: 100 } }), 'salary_arrived')).toBeUndefined();
    });

    it('reports a salary that never arrived, after the grace days', () => {
        const c = ctx({ pnl: { total_income_actual: 0, forecasted_net_pnl: 100 } });
        expect(rules(c)).toContain('salary_missing');
    });

    it('waits out the grace period before calling it missing', () => {
        const c = ctx({ pnl: { total_income_actual: 0, forecasted_net_pnl: 100 } });
        c.today = '2026-11-11'; // salary day 10 + 2 grace = 12
        expect(rules(c)).not.toContain('salary_missing');
    });
});

describe('negative_forecast', () => {
    it('fires and says what the daily cut would have to be', () => {
        const alert = find(ctx({ pnl: { forecasted_net_pnl: -900, days_left: 9 } }), 'negative_forecast');
        expect(alert.severity).toBe('critical');
        expect(alert.payload.daily_cut_needed).toBe(100);
    });
});

describe('pace_ahead', () => {
    it('fires when spending outruns the elapsed share of the cycle', () => {
        // Day 12 of 30 is 40% elapsed; ₪7,200 of a ₪9,400 everyday budget is 77%.
        expect(rules(ctx({ pnl: { total_expenses: 7200, variable_expenses: 7200 } }))).toContain('pace_ahead');
    });

    it('tolerates spending that is only slightly ahead', () => {
        // 46% spent against 40% elapsed is inside the 1.15 factor.
        expect(rules(ctx({ pnl: { total_expenses: 4300, variable_expenses: 4300 } }))).not.toContain('pace_ahead');
    });

    it('stays quiet in the first days, when the elapsed share is unstable', () => {
        const c = ctx({ pnl: { cycle_day: 3, total_expenses: 7200, variable_expenses: 7200 } });
        expect(rules(c)).not.toContain('pace_ahead');
    });
});

describe('spending_burst', () => {
    const burst = [
        { expense_id: 1, amount: 1200, description: 'TV', created_at: '2026-11-11T09:00:00Z', is_fixed: 0 },
        { expense_id: 2, amount: 1100, description: 'Sound bar', created_at: '2026-11-11T10:00:00Z', is_fixed: 0 },
        { expense_id: 3, amount: 900, description: 'Cables', created_at: '2026-11-12T08:00:00Z', is_fixed: 0 },
    ];

    it('fires on a short run far above the normal rate', () => {
        expect(rules(ctx({ recent: burst }))).toContain('spending_burst');
    });

    it('ignores fixed charges, which land in one lump by nature', () => {
        const rent = [{ expense_id: 9, amount: 4000, description: 'Rent', created_at: '2026-11-11T09:00:00Z', is_fixed: 1 }];
        expect(rules(ctx({ recent: rent }))).not.toContain('spending_burst');
    });
});

describe('duplicate_charge', () => {
    it('fires on the same amount and description twice in the window', () => {
        const rows = [
            { expense_id: 20, amount: 89.9, description: 'Spotify', created_at: '2026-11-12T08:00:00Z', is_fixed: 0 },
            { expense_id: 19, amount: 89.9, description: 'spotify', created_at: '2026-11-11T08:00:00Z', is_fixed: 0 },
        ];
        const alert = find(ctx({ recent: rows }), 'duplicate_charge');
        expect(alert.payload.amount).toBe(89.9);
        expect(alert.dedupe_key).toBe('expense:20');
    });

    it('does not fire on the same amount with a different description', () => {
        const rows = [
            { expense_id: 20, amount: 50, description: 'Coffee', created_at: '2026-11-12T08:00:00Z', is_fixed: 0 },
            { expense_id: 19, amount: 50, description: 'Parking', created_at: '2026-11-11T08:00:00Z', is_fixed: 0 },
        ];
        expect(rules(ctx({ recent: rows }))).not.toContain('duplicate_charge');
    });
});

describe('unusual_expense', () => {
    it('fires on a charge far above the user own recent average', () => {
        const rows = [
            { expense_id: 31, amount: 1500, description: 'Flight', created_at: '2026-11-12T08:00:00Z', is_fixed: 0 },
            { expense_id: 32, amount: 40, description: 'Coffee', created_at: '2026-11-11T08:00:00Z', is_fixed: 0 },
            { expense_id: 33, amount: 60, description: 'Lunch', created_at: '2026-11-10T08:00:00Z', is_fixed: 0 },
            { expense_id: 34, amount: 50, description: 'Bus', created_at: '2026-11-09T08:00:00Z', is_fixed: 0 },
        ];
        const alert = find(ctx({ recent: rows }), 'unusual_expense');
        expect(alert.payload.amount).toBe(1500);
        // What it was and when, so the alert stands on its own.
        expect(alert.payload.description).toBe('Flight');
        expect(alert.payload.date).toBe('2026-11-12');
        // Median of the OTHER charges (40, 50, 60), not a mean dragged up by the 1500.
        expect(alert.payload.your_typical_charge).toBe(50);
        expect(alert.payload.times_typical).toBe(30);
    });

    it('still catches a large charge that would have hidden inside its own average', () => {
        // Mean of all four is 420, so a x3 mean test would need 1260 and let 1200 through.
        // The median of the other three is 60, so the charge is caught.
        const rows = [
            { expense_id: 51, amount: 1200, description: 'Laptop', created_at: '2026-11-12T08:00:00Z', is_fixed: 0 },
            { expense_id: 52, amount: 40, description: 'Coffee', created_at: '2026-11-11T08:00:00Z', is_fixed: 0 },
            { expense_id: 53, amount: 60, description: 'Lunch', created_at: '2026-11-10T08:00:00Z', is_fixed: 0 },
            { expense_id: 54, amount: 380, description: 'Shoes', created_at: '2026-11-09T08:00:00Z', is_fixed: 0 },
        ];
        expect(rules(ctx({ recent: rows }))).toContain('unusual_expense');
    });

    it('does not fire for a user whose ordinary purchases are large', () => {
        const rows = [800, 900, 1000, 1100].map((amount, i) => ({
            expense_id: 40 + i, amount, description: `Buy ${i}`, created_at: '2026-11-12T08:00:00Z', is_fixed: 0,
        }));
        expect(rules(ctx({ recent: rows }))).not.toContain('unusual_expense');
    });
});

describe('rules that used to misfire', () => {
    it('does not call rent-heavy early spending a pace problem', () => {
        // Day 7 of 30 with the rent already cleared. Measured on total spend this reads
        // 37% spent against 23% elapsed and fired; everyday money is barely touched.
        const c = ctx({ pnl: {
            cycle_day: 7, days_left: 23,
            total_expenses: 4500, fixed_expenses: 4000, variable_expenses: 500,
        } });
        expect(rules(c)).not.toContain('pace_ahead');
    });

    it('does not call a brand new connection stale before its first sync', () => {
        expect(rules(ctx({ sync: { connections: 1, failing: 0, last_ok: null } })))
            .not.toContain('data_stale');
    });

    it('does not let a small refund pass for the salary', () => {
        // ₪200 against ₪12,000 expected. It must not consume the once-per-cycle slot.
        const c = ctx({ pnl: { total_income_actual: 200 } });
        expect(rules(c)).not.toContain('salary_arrived');
        expect(rules(c)).toContain('salary_missing');
    });

    it('never claims a missing salary for someone who tracks no income', () => {
        const c = ctx({ pnl: { total_income_actual: 0, total_income_projected: 0, forecasted_net_pnl: 100 } });
        expect(rules(c)).not.toContain('salary_missing');
    });

    it('does not call a cycle doomed on its first days', () => {
        const c = ctx({ pnl: { cycle_day: 2, forecasted_net_pnl: -900 } });
        expect(rules(c)).not.toContain('negative_forecast');
    });

    it('does not call a daily habit at a fixed price a duplicate', () => {
        const rows = [
            { expense_id: 60, amount: 18, description: 'Coffee', created_at: '2026-11-12T08:00:00Z', is_fixed: 0 },
            { expense_id: 61, amount: 18, description: 'Coffee', created_at: '2026-11-11T08:00:00Z', is_fixed: 0 },
        ];
        expect(rules(ctx({ recent: rows }))).not.toContain('duplicate_charge');
    });
});

describe('cycle_surplus', () => {
    it('offers the surplus only while there is still cycle left to act in', () => {
        expect(rules(ctx({ pnl: { days_left: 3, forecasted_net_pnl: 1500 } }))).toContain('cycle_surplus');
        expect(rules(ctx({ pnl: { days_left: 18, forecasted_net_pnl: 1500 } }))).not.toContain('cycle_surplus');
    });
});

describe('ordering', () => {
    it('puts the worst first, so a polling agent can take the head of the list', () => {
        const c = ctx({
            pnl: { forecasted_net_pnl: -500, total_expenses: 7200 },
            sync: { connections: 1, failing: 1, last_ok: NOW },
        });
        const out = evaluate(c);
        expect(out[0].rule).toBe('data_stale');
        const severities = out.map((a) => SEVERITY[a.severity]);
        expect(severities).toEqual([...severities].sort((a, b) => a - b));
    });
});

describe('the forecast shortfall floor', () => {
    it('stays silent on a shortfall inside the forecast\'s own error bars', () => {
        // Seen in production on the first real tick: a ₪0.27 gap was written as "critical"
        // with a "daily cut needed" of 2 agorot. The number was right; raising it was not.
        const c = ctx({ pnl: { forecasted_net_pnl: -0.27 } });
        expect(rules(c)).not.toContain('negative_forecast');
    });

    it('still fires once the shortfall is real', () => {
        const c = ctx({ pnl: { forecasted_net_pnl: -1200 } });
        expect(find(c, 'negative_forecast').payload.net_forecast).toBe(-1200);
    });
});

describe('the lookback window', () => {
    const db = require('./setup/dbMock');
    const { buildContext } = require('../../backend/src/services/spendingAlerts');

    it('never reaches past today, so a scheduled charge is not reported as spent', async () => {
        // A non-virtual expense may carry a future date. Unbounded, the window pulled it in
        // and the unusual-charge rule announced money the user had not yet spent.
        // getPnL is the dashboard's own controller and has its own suite; here it only has
        // to answer, so the lookback query underneath it is the thing being measured.
        const expenseController = require('../../backend/src/controllers/expenseController');
        jest.spyOn(expenseController, 'getPnL').mockImplementation(async (req, res) => res.json(BASE_PNL));

        let expenseSql = null;
        let expenseParams = null;
        db.query.mockImplementation(async (sql, params = []) => {
            if (sql.includes('FROM expenses e') && sql.includes('is_virtual')) {
                expenseSql = sql;
                expenseParams = params;
                return [[]];
            }
            if (sql.includes('FROM bank_connections')) return [[{ connections: 0, failing: 0, last_ok: null }]];
            return [[]];
        });

        await buildContext({ user_id: 1, cycle_anchor_day: 1, salary_day: 10 }, NOW);

        expect(expenseSql).toMatch(/created_at\s*<\s*\?/);
        // Lower bound, then an upper bound that is tomorrow: today's charges count, later ones do not.
        expect(expenseParams[2]).toBe('2026-11-13');
        expect(new Date(expenseParams[2]) > new Date(expenseParams[1])).toBe(true);
    });
});

describe('pace measured against elapsed spending only', () => {
    it('does not call a future-dated charge overspending', () => {
        // Bank sync imports pending and scheduled charges dated later in the cycle, and
        // getPnL's unclamped window runs to the cycle's end, so they land in
        // variable_expenses. Day 12 of 30: 6,000 of a 9,400 budget reads as 64% spent
        // against 40% elapsed and fired, while only 3,000 has actually left the account.
        const c = ctx({
            pnl: { variable_expenses: 6000 },
            pnlToDate: { variable_expenses: 3000 },
        });
        expect(rules(c)).not.toContain('pace_ahead');
    });

    it('still fires, and quotes the clamped figure, once real spending runs ahead', () => {
        const c = ctx({
            pnl: { variable_expenses: 8000 },
            pnlToDate: { variable_expenses: 7000 },
        });
        const hit = find(c, 'pace_ahead');
        expect(hit.payload.everyday_spent).toBe(7000);
    });
});

describe('who the tick runs for', () => {
    const db = require('./setup/dbMock');
    const { runSpendingAlerts } = require('../../backend/src/services/spendingAlerts');

    it('skips users with no live agent key, and counts a user with two keys once', async () => {
        // The agent API is the only delivery channel, so an alert for a keyless user is a
        // row nobody can read. Keys are issued per use, and a user may hold several.
        let userSql = null;
        db.query.mockImplementation(async (sql) => {
            if (sql.includes('FROM users u') && sql.includes('agent_api_keys')) {
                userSql = sql;
                return [[]];
            }
            return [[]];
        });

        await runSpendingAlerts(NOW);

        expect(userSql).toMatch(/JOIN\s+agent_api_keys/);
        expect(userSql).toMatch(/revoked_at IS NULL/);
        expect(userSql).toMatch(/SELECT DISTINCT/);
    });
});
