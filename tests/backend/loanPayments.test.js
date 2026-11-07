const { matchRepayments, applyPayment } = require('../../backend/src/services/loanPayments');
const db = require('./setup/dbMock');
const commitments = require('../../backend/src/services/commitments');

const leumi = { loan_id: 1, match_key: 'פרעון הלוואה', monthly_payment: 586.03, balance_updated_at: '2026-11-07' };
const car = { loan_id: 2, match_key: 'פרעון הלוואה', monthly_payment: 1450, balance_updated_at: '2026-11-07' };
const exp = (id, date, amount, description = 'פרעון הלוואה') => ({ expense_id: id, date, amount, description });

describe('matchRepayments', () => {
    test('a repayment after the balance was entered is applied to its loan', () => {
        expect(matchRepayments([leumi], [exp(10, '2026-11-16', 586.03)])).toEqual([
            { loan_id: 1, expense_id: 10, amount: 586.03, date: '2026-11-16' },
        ]);
    });

    test('repayments on or before the balance date are already in the entered balance', () => {
        expect(matchRepayments([leumi], [exp(9, '2026-10-16', 586.03), exp(8, '2026-11-07', 586.03)])).toEqual([]);
    });

    test('each expense is applied once', () => {
        expect(matchRepayments([leumi], [exp(10, '2026-11-16', 586.03)], new Set([10]))).toEqual([]);
    });

    test('two loans under the same label: each payment goes to the loan whose amount it matches', () => {
        const m = matchRepayments([leumi, car], [exp(10, '2026-11-16', 586.03), exp(11, '2026-11-16', 1450)]);
        expect(m.map(x => [x.expense_id, x.loan_id])).toEqual([[10, 1], [11, 2]]);
    });

    test('an implausible amount is not applied to a priced loan', () => {
        expect(matchRepayments([leumi], [exp(12, '2026-11-20', 5000)])).toEqual([]);
    });

    test('a loan without a monthly payment takes its label only when it is the only one', () => {
        const unpriced = { ...car, monthly_payment: 0 };
        expect(matchRepayments([unpriced], [exp(13, '2026-11-16', 1400)])).toHaveLength(1);
        expect(matchRepayments([leumi, unpriced], [exp(13, '2026-11-16', 1400)])).toEqual([]);
    });

    test('other payees and unlinked loans never match', () => {
        expect(matchRepayments([{ ...leumi, match_key: null }], [exp(14, '2026-11-16', 586.03)])).toEqual([]);
        expect(matchRepayments([leumi], [exp(15, '2026-11-16', 586.03, 'WOLT')])).toEqual([]);
    });
});

describe('applyPayment', () => {
    test('without a rate the whole payment lowers the balance and one payment is used', () => {
        expect(applyPayment({ outstanding_balance: 10000, remaining_payments: 18, interest_rate: null }, 586.03))
            .toEqual({ principal: 586.03, outstanding_balance: 9413.97, remaining_payments: 17 });
    });

    test('with a rate only the principal part lowers it', () => {
        // 12,000 at 6% → 60 interest this month; 600 payment → 540 principal.
        expect(applyPayment({ outstanding_balance: 12000, remaining_payments: null, interest_rate: 6 }, 600))
            .toEqual({ principal: 540, outstanding_balance: 11460, remaining_payments: null });
    });

    test('never below zero', () => {
        expect(applyPayment({ outstanding_balance: 300, remaining_payments: 1 }, 586.03))
            .toEqual({ principal: 300, outstanding_balance: 0, remaining_payments: 0 });
    });
});

describe('applyLoanPayments (DB, mocked)', () => {
    beforeEach(() => {
        db.getConnection.mockResolvedValue(db._conn);
        for (const fn of ['beginTransaction', 'commit', 'rollback']) db._conn[fn].mockResolvedValue();
    });

    test('records the payment and lowers the balance in one transaction', async () => {
        db.query
            .mockResolvedValueOnce([[{ loan_id: 1, match_key: 'פרעון הלוואה', monthly_payment: '586.03', outstanding_balance: '10000.00', remaining_payments: 18, interest_rate: null, balance_updated_at: '2026-11-07' }]])
            .mockResolvedValueOnce([[{ expense_id: 10, description: 'פרעון הלוואה', amount: '586.03', created_at: '2026-11-16' }]]);
        db._conn.query.mockResolvedValue([{ affectedRows: 1 }]);

        expect(await commitments.applyLoanPayments(42)).toBe(1);
        const [[insertSql, insertParams], [updateSql, updateParams]] = db._conn.query.mock.calls;
        expect(insertSql).toMatch(/INSERT INTO loan_payments/);
        expect(insertParams).toEqual([1, 10, '2026-11-16', 586.03, 586.03, 9413.97]);
        expect(updateSql).toMatch(/UPDATE loans SET outstanding_balance = \?, remaining_payments = \? WHERE loan_id = \? AND user_id = \?/);
        expect(updateParams).toEqual([9413.97, 17, 1, 42]);
        expect(db._conn.commit).toHaveBeenCalled();
        // The candidate query excludes expenses already in the ledger.
        expect(db.query.mock.calls[1][0]).toMatch(/lp\.expense_id IS NULL/);
    });

    test('a duplicate (already applied) rolls back without changing the balance', async () => {
        db.query
            .mockResolvedValueOnce([[{ loan_id: 1, match_key: 'פרעון הלוואה', monthly_payment: '586.03', outstanding_balance: '10000', remaining_payments: 18, balance_updated_at: '2026-11-07' }]])
            .mockResolvedValueOnce([[{ expense_id: 10, description: 'פרעון הלוואה', amount: '586.03', created_at: '2026-11-16' }]]);
        db._conn.query.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }));

        expect(await commitments.applyLoanPayments(42)).toBe(0);
        expect(db._conn.rollback).toHaveBeenCalled();
        expect(db._conn.query).toHaveBeenCalledTimes(1);
    });

    test('no linked loans → nothing queried beyond the loans', async () => {
        db.query.mockResolvedValueOnce([[]]);
        expect(await commitments.applyLoanPayments(42)).toBe(0);
        expect(db.query).toHaveBeenCalledTimes(1);
    });
});
