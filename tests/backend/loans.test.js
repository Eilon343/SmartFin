const crypto = require('crypto');
const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { authHeader, TEST_USER } = require('./setup/authHelper');

// SQL-routed mock: each query is answered by what it reads, so the tests do not depend
// on the order the controllers happen to issue them in.
let tables;
let sqlSeen;
const KEY = 'sfa_' + 'c'.repeat(48);
const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

function route(sql, params) {
    sqlSeen.push(sql);
    if (sql.includes('FROM agent_api_keys k')) {
        return params[0] === hashKey(KEY) ? [[{ key_id: 1, user_id: 42, cycle_anchor_day: 1, salary_day: 1 }]] : [[]];
    }
    if (sql.startsWith('UPDATE agent_api_keys')) return [{ affectedRows: 1 }];
    if (sql.includes('FROM users')) return [[{ user_id: TEST_USER.user_id, cycle_anchor_day: 1, salary_day: 1 }]];
    if (sql.includes('FROM loans') && sql.includes('outstanding_balance DESC')) return [tables.loans];
    if (sql.includes('FROM loans')) return [tables.loans.map(l => ({ monthly_payment: l.monthly_payment, payment_day: l.payment_day, next_payment_date: null }))];
    if (sql.includes('FROM expenses') && sql.includes('LIKE')) return [tables.repayments];
    if (sql.includes('FROM installment_plans')) return [tables.plans];
    if (sql.includes('FROM subscriptions s LEFT JOIN categories c ON c.category_id')) return [tables.subs];
    if (sql.startsWith('INSERT INTO loans')) return [{ insertId: 7 }];
    if (sql.startsWith('UPDATE loans')) return [{ affectedRows: tables.loans.length ? 1 : 0 }];
    if (sql.startsWith('UPDATE subscriptions SET confirmed_at')) return [{ affectedRows: 1 }];
    return [[]];
}

beforeEach(() => {
    sqlSeen = [];
    tables = {
        loans: [{
            loan_id: 1, lender: 'Car loan', loan_type: 'loan', original_amount: '41000', outstanding_balance: '39000',
            interest_rate: '6.5', monthly_payment: '850', remaining_payments: 48, payment_day: 16,
            next_payment_date: null, match_key: null, notes: null, balance_updated_at: '2026-11-01',
        }],
        repayments: [
            { description: 'פרעון הלוואה', amount: '592.61', created_at: '2026-08-16' },
            { description: 'פרעון הלוואה', amount: '592.67', created_at: '2026-09-16' },
            { description: 'פרעון הלוואה', amount: '586.03', created_at: '2026-10-16' },
        ],
        plans: [{
            plan_id: 3, merchant: 'KSP', monthly_amount: '300', total_amount: '3600', total_payments: 12,
            last_number: 3, last_payment_date: '2026-11-05', next_payment_date: '2026-12-05', end_date: '2027-08-05',
        }],
        subs: [{ subscription_id: 9, name: 'Claude', amount: '64.23', day_of_month: 28, auto_detected: 1, confirmed_at: null, category: 'Subscriptions' }],
    };
    db.query.mockImplementation(async (sql, params) => route(sql, params));
});

describe('GET /api/loans', () => {
    test('lists loans with a summary and repayments found in the account', async () => {
        const res = await request(app).get('/api/loans').set(authHeader());
        expect(res.status).toBe(200);
        expect(res.body.loans[0]).toMatchObject({ lender: 'Car loan', outstanding_balance: 39000, monthly_payment: 850, source: 'manual' });
        expect(res.body.loans[0].next_payment_date).toMatch(/^\d{4}-\d{2}-16$/);
        expect(res.body.summary).toMatchObject({ count: 1, total_outstanding: 39000, total_monthly_payment: 850 });
        expect(res.body.detected_repayments).toHaveLength(1);
        expect(res.body.detected_repayments[0]).toMatchObject({ payments_seen: 3, last_amount: 586.03, payment_day: 16 });
    });

    test('a repayment already linked to a loan is not offered again', async () => {
        tables.loans[0].match_key = 'פרעון הלוואה';
        const res = await request(app).get('/api/loans').set(authHeader());
        expect(res.body.detected_repayments).toEqual([]);
    });
});

describe('POST/PUT/DELETE /api/loans', () => {
    test('creates a loan', async () => {
        const res = await request(app).post('/api/loans').set(authHeader())
            .send({ lender: 'Leumi', loan_type: 'loan', outstanding_balance: 41000, monthly_payment: 850, payment_day: 16 });
        expect(res.status).toBe(200);
        expect(res.body.loan_id).toBe(7);
        const insert = sqlSeen.find(s => s.startsWith('INSERT INTO loans'));
        expect(insert).toContain('balance_updated_at');
    });

    test.each([
        [{ loan_type: 'loan' }, /lender/],
        [{ lender: 'x', loan_type: 'boat' }, /loan_type/],
        [{ lender: 'x', interest_rate: 250 }, /interest_rate/],
        [{ lender: 'x', payment_day: 40 }, /payment_day/],
        [{ lender: 'x', next_payment_date: '16/11/2026' }, /next_payment_date/],
    ])('rejects %j', async (body, msg) => {
        const res = await request(app).post('/api/loans').set(authHeader()).send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(msg);
    });

    test('a balance update stamps balance_updated_at', async () => {
        const res = await request(app).put('/api/loans/1').set(authHeader()).send({ outstanding_balance: 38000 });
        expect(res.status).toBe(200);
        expect(sqlSeen.find(s => s.startsWith('UPDATE loans'))).toContain('balance_updated_at = CURDATE()');
    });

    test('updating another user\'s / a missing loan is 404', async () => {
        tables.loans = [];
        const res = await request(app).put('/api/loans/99').set(authHeader()).send({ outstanding_balance: 1 });
        expect(res.status).toBe(404);
    });

    test('every loan query is scoped to the caller', async () => {
        await request(app).get('/api/loans').set(authHeader());
        await request(app).put('/api/loans/1').set(authHeader()).send({ notes: 'x' });
        for (const sql of sqlSeen.filter(s => /loans/.test(s) && !s.includes('FROM users'))) {
            expect(sql).toMatch(/user_id = \?/);
        }
    });
});

describe('installments, recurring, subscription approval', () => {
    test('GET /api/installments returns active plans and the monthly commitment', async () => {
        const res = await request(app).get('/api/installments').set(authHeader());
        expect(res.status).toBe(200);
        expect(res.body.plans[0]).toMatchObject({ merchant: 'KSP', payments_made: 3, remaining_payments: 9, remaining_amount: 2700, end_date: '2027-08-05' });
        expect(res.body.summary).toEqual({ active_count: 1, monthly_commitment: 300, remaining_total: 2700 });
    });

    test('GET /api/recurring = subscriptions + installments + loans', async () => {
        const res = await request(app).get('/api/recurring').set(authHeader());
        expect(res.status).toBe(200);
        expect(res.body.subscriptions.monthly_total).toBe(64.23);
        expect(res.body.installments.monthly_commitment).toBe(300);
        expect(res.body.loans.total_monthly_payment).toBe(850);
        expect(res.body.total_monthly).toBe(1214.23);
        expect(res.body.subscriptions.items[0]).toMatchObject({ auto_detected: true, confirmed: false });
    });

    test('PUT /api/subscriptions/:id/confirm approves an auto-detected one', async () => {
        const res = await request(app).put('/api/subscriptions/9/confirm').set(authHeader());
        expect(res.status).toBe(200);
        expect(sqlSeen.find(s => s.startsWith('UPDATE subscriptions SET confirmed_at'))).toMatch(/user_id = \?/);
    });
});

describe('agent API — loans and installments', () => {
    const agent = { Authorization: `Bearer ${KEY}` };

    test('GET /api/agent/loans', async () => {
        const res = await request(app).get('/api/agent/loans').set(agent);
        expect(res.status).toBe(200);
        expect(res.body.summary).toMatchObject({ total_outstanding: 39000, total_monthly_payment: 850 });
        expect(res.body.loans[0]).toMatchObject({ lender: 'Car loan', entry: 'manual' });
    });

    test('GET /api/agent/installments', async () => {
        const res = await request(app).get('/api/agent/installments').set(agent);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ active_count: 1, monthly_commitment: 300 });
        expect(res.body.items[0]).toMatchObject({ merchant: 'KSP', remaining_payments: 9 });
    });

    test.each(['/api/agent/loans', '/api/agent/installments'])('%s needs a valid key', async (path) => {
        expect((await request(app).get(path)).status).toBe(401);
        expect((await request(app).get(path).set({ Authorization: 'Bearer sfa_wrong' })).status).toBe(401);
    });

    test.each(['/api/agent/loans', '/api/agent/installments'])('%s reads no bank table and leaks no provenance', async (path) => {
        const res = await request(app).get(path).set(agent);
        for (const sql of sqlSeen) {
            expect(sql).not.toMatch(/bank_|credential/i);
            expect(sql).not.toMatch(/SELECT\s+(\w+\.)?\*/i);
            expect(sql).not.toMatch(/^\s*(INSERT|DELETE)|^\s*UPDATE (?!agent_api_keys)/i);
        }
        expect(JSON.stringify(res.body)).not.toMatch(/bank|source|credential|account|external_hash|match_key/i);
    });

    test('the agent loan endpoints are GET-only', async () => {
        expect((await request(app).post('/api/agent/loans').set(agent)).status).toBe(404);
    });
});
