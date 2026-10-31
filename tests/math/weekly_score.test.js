/**
 * The weekly score and its message, tested against the code that ships.
 *
 * `utils/telegram.js` sends parse_mode 'Markdown', the legacy mode. Only _ * ` [ mean
 * anything there, and they are escaped with a backslash outside an entity. Inside a code
 * span nothing can be escaped, so user text must never land in one. An unbalanced entity is
 * a 400 from Telegram and the user gets nothing, which is why `isValidLegacyMarkdown` runs
 * over every state with hostile category names rather than trusting one example.
 */
const fx = require('../../backend/src/services/forecastMath');
const {
    formatWeeklyMessage,
    formatNoHistoryMessage,
    escapeMarkdown,
} = require('../../backend/src/services/weeklyScoreMessage');

const score = (weekTotal, monthlyTarget = 9000, cycleDays = 30) =>
    fx.weeklyScore({ weekTotal, monthlyTarget, cycleDays });

/** What Telegram's legacy parser rejects: an open entity, or an unescaped `[`. */
function isValidLegacyMarkdown(text) {
    let open = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (open === '`') {
            if (c === '`') open = null;
            continue;
        }
        if (c === '\\' && '_*`['.includes(text[i + 1])) { i++; continue; }
        if (open) {
            if (c === open) open = null;
            continue;
        }
        if (c === '[') return false;
        if (c === '_' || c === '*' || c === '`') open = c;
    }
    return open === null;
}

const base = {
    weekStart: '2026-10-25',
    weekEnd: '2026-10-31',
    basis: 'usual',
    topCategories: [],
    pendingTotal: 0,
};
const message = (weekTotal, overrides = {}) =>
    formatWeeklyMessage({ ...base, score: score(weekTotal), ...overrides });

describe('weeklyScore', () => {
    it('expects seven days at the daily rate', () => {
        expect(score(2100).expected).toBeCloseTo(2100, 8);
    });

    it('uses the real cycle length', () => {
        expect(score(0, 9000, 28).expected).toBeCloseTo(2250, 8);
    });

    it('grades on the rounded ratio', () => {
        expect(score(1680).state).toBe('well_under');   // 0.80
        expect(score(1701).state).toBe('under');        // 0.81
        expect(score(2100).state).toBe('on_pace');      // 1.00
        expect(score(2121).state).toBe('over');         // 1.01
        expect(score(2520).state).toBe('over');         // 1.20
        expect(score(2541).state).toBe('well_over');    // 1.21
    });

    it('treats a hair over the expectation as on pace, matching what is printed', () => {
        expect(score(2100.2).state).toBe('on_pace');
    });

    it('spending nothing is well under', () => {
        expect(score(0).state).toBe('well_under');
    });

    it('calls a net-negative week a refund', () => {
        expect(score(-50).state).toBe('refund');
    });

    it('has no score without a baseline', () => {
        expect(score(500, 0)).toBeNull();
        expect(score(500, -10)).toBeNull();
    });

    it('reports the signed gap to the expectation', () => {
        expect(score(1740).delta).toBeCloseTo(-360, 8);
        expect(score(1740).pct).toBeCloseTo(-17, 8);
    });
});

describe('formatWeeklyMessage', () => {
    it('heads the message with the week it covers', () => {
        expect(message(1740)).toContain('25–31 Oct');
    });

    it('names both months when the week crosses one', () => {
        const text = message(1740, { weekStart: '2026-10-29', weekEnd: '2026-11-04' });
        expect(text).toContain('29 Oct–4 Nov');
    });

    it('shows spending, the usual week and the gap in shekels', () => {
        const text = message(1740);
        expect(text).toContain('`₪1,740`');
        expect(text).toContain('`₪2,100`');
        expect(text).toContain('₪360 less (17%)');
    });

    it('says more for a week above the usual', () => {
        expect(message(2340)).toContain('₪240 more (11%)');
    });

    it('labels a budget-based expectation as a target', () => {
        const text = message(1740, { basis: 'target' });
        expect(text).toContain('Your weekly target');
        expect(text).toContain('Under your target');
        expect(text).not.toContain('usual');
    });

    it('labels a habit-based expectation as usual', () => {
        expect(message(1740)).toContain('Your usual week');
    });

    it('never says "budget" for a habit comparison', () => {
        for (const week of [0, 1740, 2100, 2340, 5000]) {
            expect(message(week)).not.toMatch(/budget/i);
        }
    });

    it('says right on pace instead of 0%', () => {
        const text = message(2100);
        expect(text).toContain('Right on your usual pace');
        expect(text).not.toContain('0%');
    });

    it('calls a net-negative week a refund, with no negative percentage', () => {
        const text = message(-50);
        expect(text).toContain('Net refund week');
        expect(text).toContain('₪50 came back');
        expect(text).not.toContain('%');
    });

    it('says fixed costs are not counted', () => {
        expect(message(1740)).toContain("Rent and other fixed costs aren't counted here.");
    });

    it('lists the biggest categories', () => {
        const text = message(1740, {
            topCategories: [{ name: 'Food', total: 900 }, { name: 'Transport', total: 420 }],
        });
        expect(text).toContain('Biggest: Food ₪900 · Transport ₪420');
    });

    it('leaves out the biggest line when there is nothing to list', () => {
        expect(message(1740)).not.toContain('Biggest');
    });

    it('mentions pending charges only when there are some', () => {
        expect(message(1740, { pendingTotal: 120 })).toContain('About ₪120 in card charges is still pending.');
        expect(message(1740, { pendingTotal: 0 })).not.toContain('still pending');
    });

    it('does not mention a pending amount that rounds to nothing', () => {
        expect(message(1740, { pendingTotal: 0.3 })).not.toContain('still pending');
    });
});

describe('Telegram legacy Markdown safety', () => {
    it('escapes exactly the characters legacy Markdown treats as special', () => {
        expect(escapeMarkdown('Food_out*')).toBe('Food\\_out\\*');
        expect(escapeMarkdown('a`b[c')).toBe('a\\`b\\[c');
    });

    it('leaves characters that are only special in MarkdownV2 alone', () => {
        expect(escapeMarkdown('Bars - pubs (1.5) ! #')).toBe('Bars - pubs (1.5) ! #');
    });

    it('keeps Hebrew names intact', () => {
        expect(escapeMarkdown('אוכל בחוץ')).toBe('אוכל בחוץ');
    });

    it('the checker itself rejects what Telegram rejects', () => {
        expect(isValidLegacyMarkdown('Food_out')).toBe(false);
        expect(isValidLegacyMarkdown('a [b')).toBe(false);
        expect(isValidLegacyMarkdown('*bold* and `code`')).toBe(true);
    });

    const hostile = ['Food_out', '*stars*', 'back`tick', '[link](x)', 'a\\_b', '_', 'אוכל_בחוץ', 'Bars - (1.5)'];
    const weeks = [-50, 0, 1740, 2100, 2340, 5000];

    it.each(hostile)('every state stays valid with a category named %s', (name) => {
        for (const week of weeks) {
            for (const basis of ['usual', 'target']) {
                const text = message(week, {
                    basis,
                    pendingTotal: 120,
                    topCategories: [{ name, total: 900 }, { name, total: 100 }],
                });
                expect(isValidLegacyMarkdown(text)).toBe(true);
            }
        }
    });

    it('the no-history message is valid too', () => {
        expect(isValidLegacyMarkdown(formatNoHistoryMessage())).toBe(true);
    });
});
