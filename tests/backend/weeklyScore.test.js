jest.mock('../../backend/src/utils/telegram', () => ({
    notifyUser: jest.fn(),
    sendTelegramMessage: jest.fn(),
}));

const db = require('./setup/dbMock');
const { notifyUser } = require('../../backend/src/utils/telegram');
const {
    weekWindow,
    buildUserScore,
    runWeeklyScores,
    MAX_SEND_ATTEMPTS,
} = require('../../backend/src/services/weeklyScore');

/**
 * The job moved here from the bot, which compared a week still in progress on Saturday
 * morning against a full week's expectation. It now closes the week first.
 *
 * Boundaries are Israel-local midnights, while bank rows are stored as a bare date, which
 * reads as 00:00 UTC. Those two only agree because Israel is ahead of UTC, so the window
 * tests below use both kinds of row on purpose.
 */

// Sunday 1 Nov 2026, 08:30 Israel time (UTC+2 by then).
const SUNDAY_0830 = new Date('2026-11-01T06:30:00Z');

const USER = { user_id: 1, telegram_chat_id: '555', cycle_anchor_day: 1, salary_day: 1 };
const CATS = [
    { category_id: 1, name: 'Food', is_fixed: 0 },
    { category_id: 2, name: 'Transport', is_fixed: 0 },
    { category_id: 3, name: 'Housing', is_fixed: 1 },
];
// Three complete cycles of ₪9,000 variable spend and ₪4,000 rent.
const HISTORY = ['2026-07', '2026-08', '2026-09'].flatMap((mo) => [
    { category_id: 1, mo, total: '6000', first_at: `${mo}-01` },
    { category_id: 2, mo, total: '3000', first_at: `${mo}-01` },
    { category_id: 3, mo, total: '4000', first_at: `${mo}-01` },
]);

function mockUserQueries({ buckets = HISTORY, budgets = [], week = [], pending = '0' } = {}) {
    db.query
        .mockResolvedValueOnce([CATS])
        .mockResolvedValueOnce([buckets])
        .mockResolvedValueOnce([budgets])
        .mockResolvedValueOnce([week])
        .mockResolvedValueOnce([[{ total: pending }]]);
}

const window = weekWindow(SUNDAY_0830);

beforeEach(() => {
    db.query.mockReset();
    notifyUser.mockReset();
});

// ── When it runs, and over what ───────────────────────────────────────────────

describe('weekWindow', () => {
    it('stays closed until 08:30 on Sunday', () => {
        expect(weekWindow(new Date('2026-11-01T06:29:00Z'))).toBeNull();
    });

    it('opens at 08:30 on Sunday, Israel time', () => {
        expect(weekWindow(SUNDAY_0830)).not.toBeNull();
    });

    it('is shut on every other day', () => {
        expect(weekWindow(new Date('2026-11-02T10:00:00Z'))).toBeNull();
        expect(weekWindow(new Date('2026-10-31T10:00:00Z'))).toBeNull();
    });

    it('uses the Israeli date, not the UTC one, late on Sunday', () => {
        // 22:30 UTC on Sunday is already Monday 00:30 in Israel.
        expect(weekWindow(new Date('2026-11-01T22:30:00Z'))).toBeNull();
    });

    it('covers the week just closed, across the DST change', () => {
        expect(window.start.toISOString()).toBe('2026-10-24T21:00:00.000Z');
        expect(window.end.toISOString()).toBe('2026-10-31T22:00:00.000Z');
        expect(window.weekKey).toBe('2026-10-25');
        expect(window.lastDayISO).toBe('2026-10-31');
    });

    it('spans exactly seven days in a summer week', () => {
        const w = weekWindow(new Date('2026-07-05T06:00:00Z'));
        expect(w.end - w.start).toBe(7 * 24 * 60 * 60 * 1000);
    });

    const inWindow = (iso) => new Date(iso) >= window.start && new Date(iso) < window.end;

    it('keeps date-only bank rows in the right week', () => {
        expect(inWindow('2026-10-24T00:00:00Z')).toBe(false); // the Saturday before
        expect(inWindow('2026-10-25T00:00:00Z')).toBe(true);  // this Sunday
        expect(inWindow('2026-10-31T00:00:00Z')).toBe(true);  // this Saturday
        expect(inWindow('2026-11-01T00:00:00Z')).toBe(false); // the next Sunday
    });

    it('counts a Saturday-night purchase logged by hand', () => {
        expect(inWindow('2026-10-31T21:30:00Z')).toBe(true); // 23:30 Saturday in Israel
    });

    it('does not count a purchase logged after midnight on Sunday', () => {
        expect(inWindow('2026-10-31T22:30:00Z')).toBe(false); // 00:30 Sunday in Israel
    });
});

// ── What it says ──────────────────────────────────────────────────────────────

describe('buildUserScore', () => {
    it('compares variable spending with the typical week', async () => {
        mockUserQueries({ week: [{ category_id: 1, name: 'Food', total: '1000' }] });

        const text = await buildUserScore(USER, window);

        // ₪9,000 over the 31-day October cycle is ₪2,032 a week.
        expect(text).toContain('`₪1,000`');
        expect(text).toContain('`₪2,032`');
        expect(text).toContain('Your usual week');
    });

    it('filters the week to real, variable spending inside the window', async () => {
        mockUserQueries();
        await buildUserScore(USER, window);

        const [sql, params] = db.query.mock.calls[3];
        expect(sql).toMatch(/is_virtual\s*=\s*FALSE/i);
        expect(sql).toMatch(/COALESCE\(c\.is_fixed, FALSE\)\s*=\s*FALSE/i);
        expect(sql).toMatch(/created_at >= \? AND e\.created_at < \?/i);
        expect(params).toEqual([USER.user_id, '2026-10-24 21:00:00', '2026-10-31 22:00:00']);
    });

    it('takes the history from the six cycles before the week', async () => {
        mockUserQueries();
        await buildUserScore(USER, window);

        const [sql, params] = db.query.mock.calls[1];
        expect(sql).toMatch(/is_virtual\s*=\s*FALSE/i);
        expect(params).toContain('2026-04-01');
        expect(params).toContain('2026-10-01');
    });

    it('calls it a target once a variable category has a budget', async () => {
        mockUserQueries({ budgets: [{ category_id: 1, monthly_limit: '3000' }] });

        const text = await buildUserScore(USER, window);

        expect(text).toContain('Your weekly target');
    });

    it('stays "usual" when only a fixed category has a budget', async () => {
        mockUserQueries({ budgets: [{ category_id: 3, monthly_limit: '4000' }] });

        expect(await buildUserScore(USER, window)).toContain('Your usual week');
    });

    it('lists the three biggest categories, without refunds', async () => {
        mockUserQueries({
            week: [
                { category_id: 1, name: 'Food', total: '900' },
                { category_id: 2, name: 'Transport', total: '100' },
                { category_id: 4, name: 'Fun', total: '300' },
                { category_id: 5, name: 'Gifts', total: '200' },
                { category_id: 6, name: 'Returns', total: '-50' },
            ],
        });

        expect(await buildUserScore(USER, window)).toContain('Biggest: Food ₪900 · Fun ₪300 · Gifts ₪200');
    });

    it('names uncategorized spending', async () => {
        mockUserQueries({ week: [{ category_id: null, name: null, total: '400' }] });

        expect(await buildUserScore(USER, window)).toContain('Uncategorized ₪400');
    });

    it('mentions pending card charges', async () => {
        mockUserQueries({ pending: '120' });

        expect(await buildUserScore(USER, window)).toContain('About ₪120 in card charges');
    });

    it('asks only for ILS outgoing pending rows in the week', async () => {
        mockUserQueries();
        await buildUserScore(USER, window);

        const [sql, params] = db.query.mock.calls[4];
        expect(sql).toMatch(/status\s*=\s*'pending'/i);
        expect(sql).toMatch(/import_status\s*=\s*'pending_categorization'/i);
        expect(sql).toMatch(/charged_amount\s*<\s*0/i);
        expect(sql).toMatch(/currency\s*=\s*'ILS'/i);
        expect(params).toEqual([USER.user_id, '2026-10-25', '2026-11-01']);
    });

    it('anchors the cycle to the user, not the calendar', async () => {
        mockUserQueries();
        await buildUserScore({ ...USER, cycle_anchor_day: 10 }, window);

        expect(db.query.mock.calls[1][1]).toContain('2026-04-10');
        expect(db.query.mock.calls[1][1]).toContain('2026-10-10');
    });
});

describe('buildUserScore - not enough history', () => {
    // A single five-day cycle: categoryHabits returns no months, so nothing has a habit.
    const SHORT = [{ category_id: 1, mo: '2026-09', total: '500', first_at: '2026-09-27' }];

    it('gives the no-history message with no budgets at all', async () => {
        mockUserQueries({ buckets: SHORT, week: [{ category_id: 1, name: 'Food', total: '300' }] });

        expect(await buildUserScore(USER, window)).toContain('Not enough history yet');
    });

    it('does not score all spending against one budget that covers part of it', async () => {
        // The target would be the Food budget alone, while the total includes Transport.
        mockUserQueries({
            buckets: SHORT,
            budgets: [{ category_id: 1, monthly_limit: '3000' }],
            week: [
                { category_id: 1, name: 'Food', total: '300' },
                { category_id: 2, name: 'Transport', total: '200' },
            ],
        });

        expect(await buildUserScore(USER, window)).toContain('Not enough history yet');
    });

    it('treats uncategorized spending as outside any budget', async () => {
        mockUserQueries({
            buckets: SHORT,
            budgets: [{ category_id: 1, monthly_limit: '3000' }],
            week: [
                { category_id: 1, name: 'Food', total: '300' },
                { category_id: null, name: null, total: '50' },
            ],
        });

        expect(await buildUserScore(USER, window)).toContain('Not enough history yet');
    });

    it('scores a new user whose budgets cover everything spent', async () => {
        mockUserQueries({
            buckets: SHORT,
            budgets: [{ category_id: 1, monthly_limit: '3100' }],
            week: [{ category_id: 1, name: 'Food', total: '300' }],
        });

        const text = await buildUserScore(USER, window);

        expect(text).toContain('Your weekly target');
        expect(text).toContain('`₪700`'); // 3,100 over 31 days × 7
    });

    it('ignores a refund in an unbudgeted category when checking coverage', async () => {
        mockUserQueries({
            buckets: SHORT,
            budgets: [{ category_id: 1, monthly_limit: '3100' }],
            week: [
                { category_id: 1, name: 'Food', total: '300' },
                { category_id: 2, name: 'Transport', total: '-20' },
            ],
        });

        expect(await buildUserScore(USER, window)).toContain('Your weekly target');
    });

    it('does not apply the coverage rule once there is real history', async () => {
        mockUserQueries({
            budgets: [{ category_id: 1, monthly_limit: '3000' }],
            week: [{ category_id: 9, name: 'New category', total: '200' }],
        });

        expect(await buildUserScore(USER, window)).toContain('Your weekly target');
    });

    it('falls back when the only budget is zero', async () => {
        mockUserQueries({
            buckets: SHORT,
            budgets: [{ category_id: 1, monthly_limit: '0' }],
            week: [{ category_id: 1, name: 'Food', total: '300' }],
        });

        expect(await buildUserScore(USER, window)).toContain('Not enough history yet');
    });
});

// ── Delivery ──────────────────────────────────────────────────────────────────

describe('runWeeklyScores', () => {
    const userRow = (user_id) => ({ ...USER, user_id, telegram_chat_id: String(user_id) });

    /** Answers by query shape, so a run with several users needs no positional queue. */
    function answerQueries({ users, failFor = [] }) {
        db.query.mockImplementation(async (sql, params) => {
            if (/FROM users/i.test(sql)) return [users];
            if (/UPDATE users/i.test(sql)) return [{ affectedRows: 1 }];
            if (failFor.includes(params[0])) throw new Error('boom');
            if (/FROM categories/i.test(sql)) return [CATS];
            if (/first_at/i.test(sql)) return [HISTORY];
            if (/FROM budgets/i.test(sql)) return [[]];
            if (/bank_transactions_raw/i.test(sql)) return [[{ total: '0' }]];
            return [[]];
        });
    }
    const markers = () => db.query.mock.calls.filter(([sql]) => /UPDATE users/i.test(sql));

    it('does nothing outside the window', async () => {
        await runWeeklyScores(new Date('2026-11-02T10:00:00Z'));

        expect(db.query).not.toHaveBeenCalled();
        expect(notifyUser).not.toHaveBeenCalled();
    });

    it('sends once and records the week', async () => {
        answerQueries({ users: [userRow(101)] });
        notifyUser.mockResolvedValue(true);

        await runWeeklyScores(SUNDAY_0830);

        expect(notifyUser).toHaveBeenCalledTimes(1);
        expect(notifyUser.mock.calls[0][0]).toBe('101');
        expect(markers()).toHaveLength(1);
        expect(markers()[0][1]).toEqual(['2026-10-25', 101]);
    });

    it('only selects users who have not had this week yet', async () => {
        // This is what stops a restart on Sunday from sending a second message.
        answerQueries({ users: [] });

        await runWeeklyScores(SUNDAY_0830);

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/telegram_chat_id IS NOT NULL/i);
        expect(sql).toMatch(/weekly_score_sent_for IS NULL OR weekly_score_sent_for < \?/i);
        expect(params).toEqual(['2026-10-25']);
        expect(notifyUser).not.toHaveBeenCalled();
    });

    it('leaves the marker unset after a failed send, so the next tick retries', async () => {
        answerQueries({ users: [userRow(102)] });
        notifyUser.mockResolvedValue(false);

        await runWeeklyScores(SUNDAY_0830);

        expect(markers()).toHaveLength(0);
    });

    it('gives up after three failures, rather than retrying a blocked chat all Sunday', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        answerQueries({ users: [userRow(103)] });
        notifyUser.mockResolvedValue(false);

        for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) await runWeeklyScores(SUNDAY_0830);

        expect(notifyUser).toHaveBeenCalledTimes(3);
        expect(markers()).toHaveLength(1);
        expect(errors).toHaveBeenCalled();
        errors.mockRestore();
    });

    it('one user failing does not stop the next', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        answerQueries({ users: [userRow(104), userRow(105)], failFor: [104] });
        notifyUser.mockResolvedValue(true);

        await runWeeklyScores(SUNDAY_0830);

        expect(notifyUser).toHaveBeenCalledTimes(1);
        expect(notifyUser.mock.calls[0][0]).toBe('105');
        errors.mockRestore();
    });

    it('never overlaps itself when a tick runs long', async () => {
        answerQueries({ users: [userRow(106)] });
        let release;
        notifyUser.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

        const first = runWeeklyScores(SUNDAY_0830);
        await runWeeklyScores(SUNDAY_0830);
        await new Promise((resolve) => setImmediate(resolve));
        release(true);
        await first;

        expect(notifyUser).toHaveBeenCalledTimes(1);
    });
});
