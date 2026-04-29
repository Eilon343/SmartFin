/**
 * Pure math tests for P&L formulas — mirrors test_pnl_math.py but in JS.
 * No DB, no supertest, no mocking. Run as part of the Jest suite.
 */

// ── Formula implementations (exact copy of expenseController.js logic) ───────

function variableAvg(total, monthsWithData) {
    return monthsWithData > 0 ? total / monthsWithData : 0;
}

function projectedIncome(fixed, variableActual, varAvg) {
    return fixed + Math.max(variableActual, varAvg);
}

function projectedExpenses(actual, dayOfMonth, daysInMonth, isCurrentMonth) {
    if (!isCurrentMonth || actual === 0) return actual;
    return actual * (daysInMonth / dayOfMonth);
}

function currentNet(actualIncome, expenses, subs, savings) {
    return actualIncome - expenses - subs - savings;
}

function forecastedNet(projIncome, projExpenses, subs, savings) {
    return projIncome - projExpenses - subs - savings;
}

// ── variableAvg ───────────────────────────────────────────────────────────────

describe('variableAvg', () => {
    it('returns 0 when no months with data', () => {
        expect(variableAvg(0, 0)).toBe(0);
    });

    it('divides by 1 for single month', () => {
        expect(variableAvg(900, 1)).toBe(900);
    });

    it('divides by 2 when 2 months have data', () => {
        expect(variableAvg(1800, 2)).toBe(900);
    });

    it('divides by 3 for full 3-month lookback', () => {
        expect(variableAvg(2700, 3)).toBe(900);
    });

    it('old bug: 2 months in 3-month window was divided by 3', () => {
        // Old: 1800 / 3 = 600 (bug)
        // Fix: 1800 / 2 = 900 (correct)
        expect(variableAvg(1800, 2)).toBe(900);
        expect(variableAvg(1800, 2)).not.toBe(600);
    });

    it('does not return NaN for zero total with zero months', () => {
        const result = variableAvg(0, 0);
        expect(Number.isFinite(result)).toBe(true);
    });
});

// ── projectedIncome ───────────────────────────────────────────────────────────

describe('projectedIncome', () => {
    it('uses actual when higher than avg (windfall)', () => {
        expect(projectedIncome(0, 800, 0)).toBe(800);
    });

    it('uses avg when higher than actual', () => {
        expect(projectedIncome(0, 0, 900)).toBe(900);
    });

    it('adds fixed to max(actual, avg)', () => {
        expect(projectedIncome(5000, 1100, 300)).toBe(6100);
    });

    it('uses fixed + avg when actual is zero', () => {
        expect(projectedIncome(5000, 0, 900)).toBe(5900);
    });

    it('returns 0 for all-zero inputs', () => {
        expect(projectedIncome(0, 0, 0)).toBe(0);
    });

    it('result is always >= already-received income', () => {
        const actual = 1100;
        const result = projectedIncome(0, actual, 0);
        expect(result).toBeGreaterThanOrEqual(actual);
    });
});

// ── projectedExpenses ─────────────────────────────────────────────────────────

describe('projectedExpenses', () => {
    it('returns actual for past month unchanged', () => {
        expect(projectedExpenses(1500, 15, 30, false)).toBe(1500);
    });

    it('returns 0 when no expenses yet', () => {
        expect(projectedExpenses(0, 15, 30, true)).toBe(0);
    });

    it('doubles expenses at midpoint', () => {
        expect(projectedExpenses(300, 15, 30, true)).toBe(600);
    });

    it('projects 30x from day 1', () => {
        expect(projectedExpenses(30, 1, 30, true)).toBe(900);
    });

    it('no scaling on last day', () => {
        expect(projectedExpenses(900, 30, 30, true)).toBe(900);
    });

    it('day 29 of 30 projects close to actual', () => {
        const result = projectedExpenses(870, 29, 30, true);
        expect(Math.abs(result - 900)).toBeLessThan(1);
    });

    it('handles 28-day february', () => {
        expect(projectedExpenses(200, 14, 28, true)).toBe(400);
    });
});

// ── currentNet ────────────────────────────────────────────────────────────────

describe('currentNet', () => {
    it('user exact scenario: 1100 - 30 - 0 - 200 = 870', () => {
        expect(currentNet(1100, 30, 0, 200)).toBe(870);
    });

    it('returns negative when expenses exceed income', () => {
        expect(currentNet(1000, 2000, 0, 0)).toBe(-1000);
    });

    it('all zeros → zero', () => {
        expect(currentNet(0, 0, 0, 0)).toBe(0);
    });

    it('subscriptions and savings both reduce net', () => {
        expect(currentNet(5000, 1000, 200, 300)).toBe(3500);
    });

    it('breakeven returns 0', () => {
        expect(currentNet(1700, 1000, 200, 500)).toBe(0);
    });
});

// ── forecastedNet ─────────────────────────────────────────────────────────────

describe('forecastedNet', () => {
    it('original bug: new user with 1100 income went negative before fix', () => {
        // Old code: projectedIncome = 0 + 0 = 0 → forecast = 0 - 30 - 0 - 200 = -230
        const oldForecast = forecastedNet(0, 30, 0, 200);
        expect(oldForecast).toBe(-230); // confirms the bug existed
    });

    it('after fix: user with 1100 stays positive', () => {
        const pi = projectedIncome(0, 1100, 0); // 1100
        const pe = projectedExpenses(30, 29, 30, true); // ~31
        const result = forecastedNet(pi, pe, 0, 200);
        expect(result).toBeGreaterThan(0);
        expect(result).toBeGreaterThan(860);
    });

    it('genuinely negative scenario returns negative', () => {
        const result = forecastedNet(2000, 3500, 500, 200);
        expect(result).toBe(-2200);
    });

    it('is always a finite number', () => {
        [0, 1, 2, 3].forEach(months => {
            const avg = variableAvg(0, months);
            const pi = projectedIncome(0, 0, avg);
            const pe = projectedExpenses(0, 15, 30, true);
            const result = forecastedNet(pi, pe, 0, 0);
            expect(Number.isFinite(result)).toBe(true);
        });
    });
});

// ── End-to-end scenario tests ─────────────────────────────────────────────────

describe('full P&L scenario', () => {
    it('salaried user mid-month is on track', () => {
        // Day 15 of 30, salary 10000, spent 600, subs 200, savings 500
        const fixedIncome = 10000;
        const varActual = 0;
        const varAvg = variableAvg(0, 0);
        const pi = projectedIncome(fixedIncome, varActual, varAvg);
        const pe = projectedExpenses(600, 15, 30, true); // projects to 1200
        const net = currentNet(fixedIncome, 600, 200, 500);
        const forecast = forecastedNet(pi, pe, 200, 500);

        expect(net).toBe(8700);          // current: good
        expect(forecast).toBe(8100);     // forecast: 10000 - 1200 - 200 - 500
        expect(forecast).toBeGreaterThan(0);
    });

    it('user who overspends ends up negative in forecast', () => {
        // Day 10 of 30, income 3000, already spent 2000, subs 0, savings 0
        // Projects to 6000 spend on 3000 income
        const pi = projectedIncome(3000, 0, 0);
        const pe = projectedExpenses(2000, 10, 30, true); // 6000
        const forecast = forecastedNet(pi, pe, 0, 0);

        expect(forecast).toBe(-3000);
        expect(forecast).toBeLessThan(0);
    });
});
