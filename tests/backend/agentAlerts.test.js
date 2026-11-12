const request = require('supertest');
const app = require('./setup/testApp');
const db = require('./setup/dbMock');
const { hashKey } = require('../../backend/src/middleware/agentAuth');

/**
 * GET /api/agent/alerts — the proactive alerts the agent polls for.
 *
 * The endpoint only reads alert_log; services/spendingAlerts.js is what writes it. That
 * split is what keeps the agent API read-only while alerting stays stateful, so this suite
 * also checks that a request never issues a write.
 */

const KEY = 'sfa_' + 'cd'.repeat(24);
const auth = { Authorization: `Bearer ${KEY}` };

let sqlSeen;
let alertRows;

beforeEach(() => {
    sqlSeen = [];
    alertRows = [
        {
            rule: 'data_stale',
            severity: 'critical',
            payload: JSON.stringify({ healthy: false, last_successful_sync: '2026-11-09', hours_since_last_sync: 61 }),
            sent_at: '2026-11-12 08:00:00',
        },
        {
            rule: 'unusual_expense',
            severity: 'normal',
            payload: { amount: 1500, description: 'Flight', category: 'Travel', your_recent_average: 50, times_average: 30 },
            sent_at: '2026-11-12 07:00:00',
        },
    ];

    db.query.mockImplementation(async (sql, params = []) => {
        sqlSeen.push(sql);
        if (sql.includes('FROM agent_api_keys k')) {
            return params[0] === hashKey(KEY)
                ? [[{ key_id: 1, user_id: 42, cycle_anchor_day: 1, salary_day: 10 }]]
                : [[]];
        }
        if (sql.startsWith('UPDATE agent_api_keys')) return [{ affectedRows: 1 }];
        if (sql.includes('FROM alert_log')) return [alertRows];
        return [[]];
    });
});

describe('GET /api/agent/alerts', () => {
    it('returns the alerts, worst first, with their numbers parsed', async () => {
        const res = await request(app).get('/api/agent/alerts').set(auth);

        expect(res.status).toBe(200);
        expect(res.body.currency).toBe('ILS');
        expect(res.body.alerts).toHaveLength(2);
        expect(res.body.alerts[0].rule).toBe('data_stale');
        expect(res.body.alerts[0].severity).toBe('critical');
        // Parsed whether mysql2 handed back a JSON string or an object.
        expect(res.body.alerts[0].data.healthy).toBe(false);
        expect(res.body.alerts[1].data.amount).toBe(1500);
        expect(res.body.alerts[0].detected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('scopes the read to the calling user', async () => {
        await request(app).get('/api/agent/alerts').set(auth);
        const read = sqlSeen.find((s) => s.includes('FROM alert_log'));
        expect(read).toMatch(/user_id = \?/);
    });

    it('narrows to what fired after `since`', async () => {
        const res = await request(app)
            .get('/api/agent/alerts?since=2026-11-12T07:30:00Z')
            .set(auth);
        expect(res.status).toBe(200);
        expect(sqlSeen.find((s) => s.includes('FROM alert_log'))).toMatch(/sent_at > \?/);
    });

    it('rejects a `since` that is not a timestamp', async () => {
        const res = await request(app).get('/api/agent/alerts?since=yesterday').set(auth);
        expect(res.status).toBe(400);
    });

    it('refuses an unknown key', async () => {
        const res = await request(app).get('/api/agent/alerts').set({ Authorization: 'Bearer sfa_' + '00'.repeat(24) });
        expect(res.status).toBe(401);
    });

    it('never writes, and never reads a bank table', async () => {
        await request(app).get('/api/agent/alerts').set(auth);
        const touched = sqlSeen.filter((s) => !s.startsWith('UPDATE agent_api_keys'));
        expect(touched.some((s) => /INSERT|UPDATE|DELETE/i.test(s))).toBe(false);
        expect(touched.some((s) => /bank_/i.test(s))).toBe(false);
    });
});
