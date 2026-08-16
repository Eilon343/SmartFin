const { matchDuplicates, MATCH_WINDOW_DAYS } = require('../../backend/src/services/duplicateMatcher');

// Helpers: `d` builds a date-only value the way mysql2 hands one back (local midnight).
const d = (iso) => { const [y, m, day] = iso.split('-').map(Number); return new Date(y, m - 1, day); };
const logged = (id, amount, date, extra = {}) => ({ id, amount, date: d(date), description: `logged ${id}`, source: 'bot', category_id: null, ...extra });
const synced = (id, amount, date, extra = {}) => ({ id, amount, date: d(date), description: `synced ${id}`, account: '2624', ...extra });

describe('matchDuplicates - the core rule', () => {
    it('pairs a hand-logged row with a same-amount import a few days later', () => {
        const { matched, unmatched } = matchDuplicates(
            [logged(1, 55, '2026-06-12')],
            [synced(90, 55, '2026-06-13')]
        );

        expect(matched).toHaveLength(1);
        expect(matched[0].id).toBe(1);
        expect(matched[0].match.id).toBe(90);
        expect(unmatched).toHaveLength(0);
    });

    it('keeps a row no import covers', () => {
        // Cash, Bit and PayBox never reach a bank or card feed. These are the rows a
        // date-range deletion would have destroyed with no way to get them back.
        const { matched, unmatched } = matchDuplicates(
            [logged(1, 55, '2026-06-12')],
            [synced(90, 120, '2026-06-13')]
        );

        expect(matched).toHaveLength(0);
        expect(unmatched.map((r) => r.id)).toEqual([1]);
    });

    it('keeps everything when nothing has been imported yet', () => {
        const { matched, unmatched } = matchDuplicates(
            [logged(1, 55, '2026-06-12'), logged(2, 30, '2026-06-13')],
            []
        );

        expect(matched).toHaveLength(0);
        expect(unmatched).toHaveLength(2);
    });
});

describe('matchDuplicates - one-to-one', () => {
    it('one import cannot absorb two identical hand-logged rows', () => {
        // Two ₪19.90 coffees, one imported transaction: exactly one is a duplicate.
        // Without this the single import would justify deleting both.
        const { matched, unmatched } = matchDuplicates(
            [logged(1, 19.9, '2026-06-12'), logged(2, 19.9, '2026-06-13')],
            [synced(90, 19.9, '2026-06-12')]
        );

        expect(matched).toHaveLength(1);
        expect(unmatched).toHaveLength(1);
    });

    it('two imports absorb two identical hand-logged rows', () => {
        const { matched, unmatched } = matchDuplicates(
            [logged(1, 19.9, '2026-06-12'), logged(2, 19.9, '2026-06-13')],
            [synced(90, 19.9, '2026-06-12'), synced(91, 19.9, '2026-06-14')]
        );

        expect(matched).toHaveLength(2);
        expect(unmatched).toHaveLength(0);
        // Each import was used once.
        expect(new Set(matched.map((r) => r.match.id)).size).toBe(2);
    });
});

describe('matchDuplicates - the date window', () => {
    it(`matches at exactly ${MATCH_WINDOW_DAYS} days`, () => {
        const { matched } = matchDuplicates(
            [logged(1, 55, '2026-06-10')],
            [synced(90, 55, '2026-06-15')]
        );
        expect(matched).toHaveLength(1);
    });

    it(`does not match one day beyond ${MATCH_WINDOW_DAYS}`, () => {
        const { matched, unmatched } = matchDuplicates(
            [logged(1, 55, '2026-06-10')],
            [synced(90, 55, '2026-06-16')]
        );
        expect(matched).toHaveLength(0);
        expect(unmatched).toHaveLength(1);
    });

    it('matches an import that posted before the user logged it', () => {
        // The window is absolute: clock skew and late logging both happen.
        const { matched } = matchDuplicates(
            [logged(1, 55, '2026-06-15')],
            [synced(90, 55, '2026-06-13')]
        );
        expect(matched).toHaveLength(1);
    });

    it('is not bent by a month boundary', () => {
        const { matched } = matchDuplicates(
            [logged(1, 55, '2026-06-30')],
            [synced(90, 55, '2026-07-02')]
        );
        expect(matched).toHaveLength(1);
    });

    it('accepts YYYY-MM-DD strings without shifting the day', () => {
        // Date.parse('2026-06-12') is UTC midnight, which renders as the 11th west of
        // Greenwich — the same class of bug that dated every import one day early.
        const { matched } = matchDuplicates(
            [{ id: 1, amount: 55, date: '2026-06-12', source: 'bot', category_id: null }],
            [{ id: 90, amount: 55, date: '2026-06-17', description: 'x', account: '1' }]
        );
        expect(matched).toHaveLength(1);
    });
});

describe('matchDuplicates - amount comparison', () => {
    it('treats float noise as equal', () => {
        const { matched } = matchDuplicates(
            [logged(1, 0.1 + 0.2, '2026-06-12')],
            [synced(90, 0.3, '2026-06-12')]
        );
        expect(matched).toHaveLength(1);
    });

    it('accepts DECIMAL strings from mysql2', () => {
        const { matched } = matchDuplicates(
            [logged(1, '55.00', '2026-06-12')],
            [synced(90, '55.00', '2026-06-13')]
        );
        expect(matched).toHaveLength(1);
    });

    it('matches a reimbursement, which is a negative expense', () => {
        // `זיכוי`/`החזר` credits are booked as NEGATIVE expenses, not income. Both sides
        // must keep their sign: comparing an absolute staged amount against a negative
        // logged one meant a reimbursement could never find its counterpart.
        const { matched } = matchDuplicates(
            [logged(1, -250, '2026-06-12')],
            [synced(90, -250, '2026-06-13')]
        );
        expect(matched).toHaveLength(1);
    });

    it('never matches a credit against a debit of the same size', () => {
        // A ₪250 refund and a ₪250 purchase are opposite events.
        const { matched, unmatched } = matchDuplicates(
            [logged(1, -250, '2026-06-12')],
            [synced(90, 250, '2026-06-12')]
        );
        expect(matched).toHaveLength(0);
        expect(unmatched).toHaveLength(1);
    });

    it('does not match one agora apart', () => {
        const { matched } = matchDuplicates(
            [logged(1, 55.0, '2026-06-12')],
            [synced(90, 55.01, '2026-06-12')]
        );
        expect(matched).toHaveLength(0);
    });
});

describe('matchDuplicates - pairing quality', () => {
    it('pairs with the closest date, not the first one found', () => {
        // Both candidates are valid. The nearest is the pair a human would draw, and
        // these pairs are shown for approval — an odd pairing costs trust.
        const { matched } = matchDuplicates(
            [logged(1, 55, '2026-06-14')],
            [synced(90, 55, '2026-06-10'), synced(91, 55, '2026-06-15')]
        );
        expect(matched[0].match.id).toBe(91);
    });

    it('is deterministic regardless of input order', () => {
        const a = matchDuplicates(
            [logged(1, 55, '2026-06-12'), logged(2, 55, '2026-06-20')],
            [synced(90, 55, '2026-06-12'), synced(91, 55, '2026-06-21')]
        );
        const b = matchDuplicates(
            [logged(2, 55, '2026-06-20'), logged(1, 55, '2026-06-12')],
            [synced(91, 55, '2026-06-21'), synced(90, 55, '2026-06-12')]
        );
        const pairs = (r) => r.matched.map((m) => [m.id, m.match.id]).sort();
        expect(pairs(a)).toEqual(pairs(b));
    });

    it('carries the counterpart so the UI can show the evidence', () => {
        const { matched } = matchDuplicates(
            [logged(1, 55, '2026-06-12')],
            [synced(90, 55, '2026-06-13', { description: 'שווארמה הקסם', account: '2624' })]
        );
        expect(matched[0].match).toMatchObject({
            id: 90,
            amount: 55,
            description: 'שווארמה הקסם',
            account: '2624',
        });
    });
});
