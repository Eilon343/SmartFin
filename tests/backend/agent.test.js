const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { authHeader } = require('./setup/authHelper');
const { hashKey } = require('../../backend/src/middleware/agentAuth');

// Read-only agent API (/api/agent/*). Besides the numbers, this suite enforces the privacy
// rule: the agent must never touch, or learn of, the bank-connection tables.

const KEY = 'sfa_' + 'ab'.repeat(24);
const MONTH_NOW = new Date().toISOString().slice(0, 7);
const [_Y, _M] = MONTH_NOW.split('-').map(Number);
const MID_CYCLE = new Date(Date.UTC(_Y, _M - 1, 15, 12));

let sqlSeen;
let keyRevoked;

function route(sql, params = []) {
    sqlSeen.push(sql);
    if (sql.includes('FROM agent_api_keys k')) {
        return (!keyRevoked && params[0] === hashKey(KEY))
            ? [[{ key_id: 1, user_id: 42, cycle_anchor_day: 1, salary_day: 1 }]]
            : [[]];
    }
    if (sql.startsWith('UPDATE agent_api_keys')) return [{ affectedRows: 1 }];
    if (sql.includes('GROUP BY COALESCE(c.is_fixed')) {
        return [[{ is_fixed: 0, total: '1200' }, { is_fixed: 1, total: '4000' }]];
    }
    if (sql.includes('is_virtual = TRUE')) return [[{ total: '0' }]];
    if (sql.includes("type = 'fixed'")) return [[{ total: '10000' }]];
    if (sql.includes("type = 'variable' AND month = ?")) return [[{ total: '0' }]];
    if (sql.includes('FROM budgets b JOIN')) {
        return [[
            { budget_id: 1, category_id: 5, category: 'Shopping', monthly_limit: '1000', carry_over: 0, start_month: MONTH_NOW },
            { budget_id: 2, category_id: 3, category: 'Housing', monthly_limit: '5000', carry_over: 0, start_month: MONTH_NOW },
        ]];
    }
    if (sql.includes('GROUP BY category_id, mo')) {
        return [[{ category_id: 5, mo: MONTH_NOW, total: '400' }, { category_id: 3, mo: MONTH_NOW, total: '4000' }]];
    }
    if (sql.includes('FROM categories') && sql.includes('user_id IS NULL OR user_id = ?') && !sql.includes('JOIN')) {
        return [[
            { category_id: 1, name: 'Food', category: 'Food', is_fixed: 0 },
            { category_id: 3, name: 'Housing', category: 'Housing', is_fixed: 1 },
            { category_id: 5, name: 'Shopping', category: 'Shopping', is_fixed: 0 },
        ]];
    }
    if (sql.includes('FROM expenses e LEFT JOIN categories c') && sql.includes('LIMIT 10')) {
        return [[{ created_at: new Date(Date.UTC(_Y, _M - 1, 14, 22, 30)), amount: '120.50', description: 'Shawarma', category: 'Food' }]];
    }
    return [[]];
}

beforeEach(() => {
    sqlSeen = [];
    keyRevoked = false;
    db.query.mockImplementation(async (sql, params) => route(sql, params));
    jest.useFakeTimers({
        now: MID_CYCLE,
        doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate',
            'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
});
afterEach(() => jest.useRealTimers());

const agent = { Authorization: `Bearer ${KEY}` };

describe('agent auth', () => {
    test('no key → 401', async () => {
        const res = await request(app).get('/api/agent/snapshot');
        expect(res.status).toBe(401);
    });

    test('dashboard JWT is not accepted by agent endpoints', async () => {
        const res = await request(app).get('/api/agent/snapshot').set(authHeader());
        expect(res.status).toBe(401);
    });

    test('revoked or unknown key → 401', async () => {
        keyRevoked = true;
        const res = await request(app).get('/api/agent/snapshot').set(agent);
        expect(res.status).toBe(401);
    });

    test('agent key is not accepted by dashboard endpoints', async () => {
        const res = await request(app).get('/api/expenses').set(agent);
        expect(res.status).toBe(401);
    });
});

describe('GET /api/agent/snapshot', () => {
    test('returns flat cycle figures and per-category budget state', async () => {
        const res = await request(app).get('/api/agent/snapshot').set(agent);
        expect(res.status).toBe(200);
        const b = res.body;
        expect(b.currency).toBe('ILS');
        expect(b.spent).toBe(5200);
        expect(b.spent_fixed).toBe(4000);
        expect(b.income_received).toBe(10000);
        expect(typeof b.daily_allowance).toBe('number');
        expect(b.days_left).toBeGreaterThan(0);

        const shopping = b.categories.find(c => c.category === 'Shopping');
        expect(shopping).toMatchObject({ spent: 400, budget: 1000, remaining: 600, pct_used: 40 });
        expect(shopping.daily_allowance).toBeCloseTo(600 / b.days_left, 2);

        // 22:30 UTC on the 14th is already the 15th in Israel.
        expect(b.recent_expenses[0]).toEqual({ date: `${MONTH_NOW}-15`, amount: 120.5, description: 'Shawarma', category: 'Food' });
        expect(b.categories.find(c => c.category === 'Housing').daily_allowance).toBeNull();
    });
});

describe('GET /api/agent/what-if', () => {
    test('one-off purchase shifts headroom and category by exactly the amount', async () => {
        const res = await request(app).get('/api/agent/what-if?amount=300&category=shopping').set(agent);
        expect(res.status).toBe(200);
        const b = res.body;
        expect(b.after.spent).toBe(b.before.spent + 300);
        expect(b.after.headroom).toBeCloseTo(b.before.headroom - 300, 2);
        expect(b.after.net_forecast).toBeCloseTo(b.before.net_forecast - 300, 2);
        expect(b.category.category).toBe('Shopping');
        expect(b.category.after.remaining).toBe(300);
        expect(b.category.over_budget_after).toBe(false);
        expect(typeof b.within_headroom).toBe('boolean');
    });

    test('after.daily_allowance is the new headroom over the same days_left', async () => {
        const res = await request(app).get('/api/agent/what-if?amount=300').set(agent);
        const b = res.body;
        expect(b.after.daily_allowance).toBeCloseTo((b.before.headroom - 300) / b.days_left, 2);
        expect(b.category).toBeNull();
        expect(b.exceeds_daily_allowance).toBe(300 > b.before.daily_allowance);
        expect(b.within_headroom).toBe(300 <= b.before.headroom);
        expect(typeof b.assumption).toBe('string');
    });

    test('fixed category gets no daily allowance', async () => {
        const res = await request(app).get('/api/agent/what-if?amount=100&category=Housing').set(agent);
        expect(res.status).toBe(200);
        expect(res.body.category.budget).toBe(5000);
        expect(res.body.category.after.daily_allowance).toBeNull();
        expect(res.body.category.after.remaining).toBe(900);
    });

    test('over-budget purchase is flagged', async () => {
        const res = await request(app).get('/api/agent/what-if?amount=700&category=Shopping').set(agent);
        expect(res.body.category.over_budget_after).toBe(true);
        expect(res.body.category.after.remaining).toBe(-100);
    });

    test('unknown category → 400 with valid list', async () => {
        const res = await request(app).get('/api/agent/what-if?amount=50&category=Yachts').set(agent);
        expect(res.status).toBe(400);
        expect(res.body.valid_categories).toEqual(['Food', 'Housing', 'Shopping']);
    });

    test.each(['0', '-5', 'abc', '2000000'])('invalid amount %s → 400', async (amount) => {
        const res = await request(app).get(`/api/agent/what-if?amount=${amount}`).set(agent);
        expect(res.status).toBe(400);
    });
});

describe('privacy: no bank data reaches the agent', () => {
    test.each([
        '/api/agent/snapshot',
        '/api/agent/what-if?amount=300&category=Shopping',
    ])('%s reads no bank table and leaks no bank field', async (path) => {
        const res = await request(app).get(path).set(agent);
        expect(res.status).toBe(200);
        for (const sql of sqlSeen) {
            expect(sql).not.toMatch(/bank_|credential/i);
            expect(sql).not.toMatch(/SELECT\s+(\w+\.)?\*/i);
        }
        const body = JSON.stringify(res.body);
        expect(body).not.toMatch(/bank|source|credential|account|external_hash/i);
    });
});
