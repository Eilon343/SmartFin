/**
 * Installments, recurring detection, deterministic categories and the import rules added
 * with migration 016. Pure modules are imported directly — the formulas under test are
 * the ones that ship.
 */
const inst = require('../../backend/src/services/installments');
const { detectRecurring, payeeKey } = require('../../backend/src/services/recurringDetector');
const { ruleCategoryOf, geminiHintOf } = require('../../backend/src/services/categoryRules');
const {
    classifyRow, settlementIssuerOf, syncWindowStart,
} = require('../../backend/src/services/bankSyncScheduler');

// A card row as bankSyncScheduler stages it (raw_json = the scraper's transaction).
function instRow(number, total, date, { monthly = 300, original = 3600, merchant = 'KSP מחשבים' } = {}) {
    return {
        bank_connection_id: 11,
        account_number: '1234',
        description: merchant,
        memo: `תשלום ${number} מתוך ${total}`,
        txn_date: date,
        charged_amount: -monthly,
        raw_json: JSON.stringify({
            type: 'installments',
            installments: { number, total },
            chargedAmount: -monthly,
            originalAmount: -original,
            description: merchant,
        }),
    };
}

describe('installments — Step 0 field extraction', () => {
    test('reads {number,total} from the scraper transaction', () => {
        expect(inst.installmentInfoOf({ installments: { number: 3, total: 12 } })).toEqual({ number: 3, total: 12 });
    });
    test('a one-payment "plan" and a normal row are not installments', () => {
        expect(inst.installmentInfoOf({ installments: { number: 1, total: 1 } })).toBeNull();
        expect(inst.installmentInfoOf({ type: 'normal' })).toBeNull();
        expect(inst.installmentInfoOf('not json')).toBeNull();
    });
    test('falls back to the "installment X of Y" text pattern', () => {
        expect(inst.installmentInfoFromText('תשלום 2 מתוך 6')).toEqual({ number: 2, total: 6 });
        expect(inst.installmentInfoFromText('installment 4 of 10')).toEqual({ number: 4, total: 10 });
        expect(inst.installmentInfoFromText('תשלום מיידי')).toBeNull();
    });
    test('addMonthsISO clamps to the end of a shorter month', () => {
        expect(inst.addMonthsISO('2026-01-31', 1)).toBe('2026-02-28');
        expect(inst.addMonthsISO('2026-11-15', 3)).toBe('2027-02-15');
        expect(inst.addMonthsISO('2026-03-15', -3)).toBe('2025-12-15');
    });
});

describe('installments — plans', () => {
    test('payments of one purchase merge into one plan keyed on the last imported payment', () => {
        const plans = inst.buildPlans([
            instRow(1, 12, '2026-09-05'),
            instRow(2, 12, '2026-10-05'),
            instRow(3, 12, '2026-11-05'),
        ]);
        expect(plans).toHaveLength(1);
        expect(plans[0]).toMatchObject({
            merchant: 'KSP מחשבים',
            monthly_amount: 300,
            total_amount: 3600,
            total_payments: 12,
            last_number: 3,
            remaining_payments: 9,
            remaining_amount: 2700,
            next_payment_date: '2026-12-05',
            end_date: '2027-08-05',
            active: true,
        });
    });

    test('two purchases at the same shop stay separate plans', () => {
        const plans = inst.buildPlans([
            instRow(1, 3, '2026-10-05', { monthly: 100, original: 300 }),
            instRow(1, 6, '2026-10-20', { monthly: 50, original: 300 }),
        ]);
        expect(plans).toHaveLength(2);
    });

    test('a finished plan is inactive and projects nothing', () => {
        const [p] = inst.buildPlans([instRow(3, 3, '2026-10-05', { monthly: 100, original: 300 })]);
        expect(p.active).toBe(false);
        expect(inst.installmentsAhead([p], '2026-01-01', '2030-01-01')).toBe(0);
    });

    test('monthly commitment sums active plans only', () => {
        const plans = inst.buildPlans([
            instRow(2, 12, '2026-10-05'),
            instRow(3, 3, '2026-10-05', { monthly: 100, original: 300, merchant: 'IKEA' }),
        ]);
        expect(inst.monthlyCommitment(plans)).toBe(300);
    });
});

/**
 * REGRESSION — a future installment is counted EXACTLY ONCE.
 *
 * The task brief said double counting "was already fixed". What the code actually did was
 * the opposite failure: combineInstallments:true made the scraper drop payments 2..N, so
 * they were never counted at all. These tests pin the rule that replaces it: a payment is
 * either imported (an expense) or projected (installments_ahead), never both, and never a
 * subscription.
 */
describe('REGRESSION: an installment payment is counted exactly once', () => {
    const NOV = ['2026-11-01', '2026-12-01'];
    const DEC = ['2026-12-01', '2027-01-01'];

    test('before payment 3 is imported, November projects it once', () => {
        const plans = inst.buildPlans([instRow(1, 12, '2026-09-05'), instRow(2, 12, '2026-10-05')]);
        expect(inst.installmentsAhead(plans, ...NOV)).toBe(300);
    });

    test('once payment 3 is imported it is an expense and the projection drops it', () => {
        const plans = inst.buildPlans([
            instRow(1, 12, '2026-09-05'), instRow(2, 12, '2026-10-05'), instRow(3, 12, '2026-11-05'),
        ]);
        expect(inst.installmentsAhead(plans, ...NOV)).toBe(0); // the imported row covers it
        expect(inst.installmentsAhead(plans, ...DEC)).toBe(300); // only the NEXT one is ahead
    });

    test('each future month projects one payment, not the whole purchase', () => {
        const plans = inst.buildPlans([instRow(1, 4, '2026-11-05', { monthly: 250, original: 1000 })]);
        expect(inst.installmentsAhead(plans, ...DEC)).toBe(250);
        expect(inst.installmentsAhead(plans, '2026-12-01', '2027-03-01')).toBe(750); // payments 2,3,4
        expect(inst.installmentsAhead(plans, '2027-03-01', '2027-04-01')).toBe(0);  // plan is over
    });

    test('installments are never detected as a subscription', () => {
        // Same payee, same amount, three consecutive months: a subscription by shape alone.
        const rows = ['2026-09-05', '2026-10-05', '2026-11-05'].map(date => ({
            description: 'KSP מחשבים', amount: 300, date, is_installment: true,
        }));
        expect(detectRecurring(rows, '2026-11')).toEqual([]);
        // The same rows without the flag WOULD be detected — so the flag is what protects it.
        expect(detectRecurring(rows.map(r => ({ ...r, is_installment: false })), '2026-11')).toHaveLength(1);
    });
});

describe('recurring detection', () => {
    const months = (desc, amounts, day = 15, extra = {}) =>
        amounts.map((amount, i) => ({ description: desc, amount, date: `2026-${String(8 + i).padStart(2, '0')}-${day}`, ...extra }));

    test('same payee, similar amount, each of 3 consecutive months → detected', () => {
        const [s] = detectRecurring(months('ANTHROPIC* CLAUDE SUB  ANTHROPIC.COM US', [61.55, 63.1, 64.23], 29), '2026-11');
        expect(s).toMatchObject({ name: 'ANTHROPIC* CLAUDE SUB  ANTHROPIC.COM US', amount: 64.23, day_of_month: 28 });
        expect(s.months).toEqual(['2026-08', '2026-09', '2026-10']);
    });

    test('gym, insurance and pension debits are detected', () => {
        const rows = [
            ...months('פרופיט קרית ים הוק', [179, 179, 179], 18),
            ...months('הראל ביטוח חיים', [33.67, 33.89, 33.73], 26),
            ...months('מיטב דש גמל-י', [100, 100, 100], 15),
        ];
        expect(detectRecurring(rows, '2026-11').map(r => r.name).sort())
            .toEqual(['הראל ביטוח חיים', 'מיטב דש גמל-י', 'פרופיט קרית ים הוק'].sort());
    });

    test('only two months → not yet', () => {
        expect(detectRecurring(months('PRIME VIDEO', [19.29, 18.91]), '2026-11')).toEqual([]);
    });

    test('a gap month breaks the run', () => {
        const rows = [
            { description: 'NETFLIX', amount: 40, date: '2026-07-10' },
            { description: 'NETFLIX', amount: 40, date: '2026-08-10' },
            { description: 'NETFLIX', amount: 40, date: '2026-10-10' },
        ];
        expect(detectRecurring(rows, '2026-11')).toEqual([]);
    });

    test('stopped paying months ago → not a subscription today', () => {
        expect(detectRecurring(months('GYM', [150, 150, 150]).map(r => ({ ...r, date: r.date.replace('2026', '2025') })), '2026-11')).toEqual([]);
    });

    test('very different amounts are not the same plan', () => {
        expect(detectRecurring(months('WOLT', [54, 220, 98]), '2026-11')).toEqual([]);
    });

    test('a payee with two plans yields two subscriptions', () => {
        const rows = [...months('PAYPAL *APPLE.COM/BILL', [11.9, 11.9, 11.9], 30), ...months('PAYPAL *APPLE.COM/BILL', [39.9, 39.9, 39.9], 8)];
        const found = detectRecurring(rows, '2026-11');
        expect(found.map(f => f.amount).sort((a, b) => a - b)).toEqual([11.9, 39.9]);
        expect(new Set(found.map(f => f.match_key)).size).toBe(2);
    });

    test('a frequent habit (several charges a month) is not a subscription', () => {
        const rows = [];
        for (const m of ['08', '09', '10']) for (const d of [3, 9, 15, 21]) rows.push({ description: 'החמניה', amount: 25, date: `2026-${m}-${String(d).padStart(2, '0')}` });
        expect(detectRecurring(rows, '2026-11')).toEqual([]);
    });

    test.each([
        ['פרעון הלוואה', 590],
        ['כרטיסי אשראי-י', 2000],
        ['העברה דיגיטל', 800],
        ['משיכת מזומן', 500],
        ['BIT', 50],
    ])('%s is never a subscription', (description, amount) => {
        expect(detectRecurring(months(description, [amount, amount, amount]), '2026-11')).toEqual([]);
    });

    test('Transfers / Loans categories are excluded', () => {
        expect(detectRecurring(months('שכר דירה לבעלים', [4000, 4000, 4000], 1, { category: 'Transfers' }), '2026-11')).toEqual([]);
    });

    test('payeeKey ignores reference numbers', () => {
        expect(payeeKey('STEAMGAMES.COM 4259522 912-1844160   US')).toBe(payeeKey('STEAMGAMES.COM 1111111 999-0000000 US'));
    });
});

describe('deterministic categories', () => {
    test.each([
        ['פרעון הלוואה', 'Loans'],
        ['ריבית אשראים', 'Fees'],
        ['עמ.הקצאת אשראי', 'Fees'],
        ['דמי כרטיס', 'Fees'],
        ['הראל ביטוח חיים', 'Insurance'],
        ['מרכז הסליקה של חברות ביטוח בע"מ', 'Insurance'],
        ['מיטב דש גמל-י', 'Savings'],
        ['ANTHROPIC* CLAUDE SUB  ANTHROPIC.COM US', 'Subscriptions'],
        ['PAYPAL *GOOGLE GOOGLE ONE', 'Subscriptions'],
        ['פזYELLOW/ טבעון', 'Transport'],
        ["טן (מגדל העמק)חב' לדלק בע", 'Transport'],
        ["ג'ונל חאיק עיצוב שיער", 'Personal Care'],
        ['משיכת מזומן', 'Transfers'],
        ['PAYBOX', 'Transfers'],
    ])('%s → %s', (description, category) => {
        expect(ruleCategoryOf(description)).toBe(category);
    });

    test.each(['WOLT', 'מחסני מזון ביג', 'המכולת הקטן', 'סופר פארם', 'מיכאל כהן'])('%s is left to Gemini', (d) => {
        expect(ruleCategoryOf(d)).toBeNull();
    });

    test('the issuer category and memo reach Gemini as a hint', () => {
        expect(geminiHintOf({ description: 'WOLT', memo: null, raw_json: JSON.stringify({ category: 'מסעדות' }) }))
            .toBe('WOLT (issuer category: מסעדות)');
        expect(geminiHintOf({ description: 'WOLT', raw_json: null })).toBe('WOLT');
    });
});

describe('import rules (migration 016)', () => {
    test('Leumi\'s "כרטיסי אשראי-י" is the Visa Cal settlement — skipped when Cal is connected', () => {
        expect(settlementIssuerOf('כרטיסי אשראי-י')).toBe('visaCal');
        const row = { company_id: 'leumi', charged_amount: -1693.6, description: 'כרטיסי אשראי-י' };
        expect(classifyRow(row, new Set(['visaCal']))).toEqual({ action: 'skip', amount: 0, reason: 'settlement_of_visaCal' });
        // …but NOT when Cal is not connected, or the money would vanish.
        expect(classifyRow(row, new Set(['max'])).action).toBe('expense');
    });

    test('the pattern is anchored — other credit-card text is not a settlement', () => {
        expect(settlementIssuerOf('כרטיסי אשראי בע"מ - עמלת פיגור')).toBeNull();
    });

    test('existing Leumi debit twin rule still holds (double-count fix unchanged)', () => {
        expect(classifyRow({ company_id: 'leumi', charged_amount: -45, description: 'לאומי דביט' }, new Set(['max'])).action).toBe('skip');
        // A debit-card refund credit is a twin too — not income.
        expect(classifyRow({ company_id: 'leumi', charged_amount: 26, description: 'לאומי דביט' }, new Set(['max'])).action).toBe('skip');
    });

    test('a loan disbursement is a negative expense, not income', () => {
        expect(classifyRow({ company_id: 'leumi', charged_amount: 41000, description: 'העמדת הלואה' }))
            .toEqual({ action: 'expense', amount: -41000, reason: 'loan_disbursement' });
    });

    test('salary is still income', () => {
        expect(classifyRow({ company_id: 'leumi', charged_amount: 10775, description: 'העברת משכורת' }).action).toBe('income');
    });

    test('full_resync_pending reaches back three months even after a sync', () => {
        const now = Date.parse('2026-11-07T12:00:00Z');
        const start = syncWindowStart({ last_sync_at: '2026-11-07T07:00:00Z', full_resync_pending: 1 }, now);
        expect(Math.round((now - start.getTime()) / 86400000)).toBe(90);
        const normal = syncWindowStart({ last_sync_at: '2026-11-07T07:00:00Z', full_resync_pending: 0 }, now);
        expect(Math.round((now - normal.getTime()) / 86400000)).toBe(3);
    });
});

describe('scraper options', () => {
    test('installments are NOT combined — every payment is returned', () => {
        jest.resetModules();
        let captured;
        jest.doMock('israeli-bank-scrapers', () => ({
            createScraper: (opts) => { captured = opts; return { scrape: async () => ({ success: true, accounts: [] }) }; },
        }));
        const { scrapeAccount } = require('../../backend/src/services/bankScraperService');
        return scrapeAccount({ companyId: 'max', credentials: {}, startDate: new Date() }).then(() => {
            expect(captured.combineInstallments).toBe(false);
            jest.dontMock('israeli-bank-scrapers');
        });
    });
});

describe('boot repairs (DB-touching, mocked)', () => {
    const db = require('./setup/dbMock');
    const commitments = require('../../backend/src/services/commitments');

    test('repairUncategorized only fills NULL categories, by rule', async () => {
        db.query
            .mockResolvedValueOnce([[
                { expense_id: 1, description: 'פרעון הלוואה' },
                { expense_id: 2, description: 'WOLT' },          // no rule — left alone
                { expense_id: 3, description: 'ריבית אשראים' },
            ]])
            .mockResolvedValueOnce([[{ category_id: 20, name: 'Loans' }, { category_id: 21, name: 'Fees' }]])
            .mockResolvedValue([{ affectedRows: 1 }]);
        expect(await commitments.repairUncategorized()).toBe(2);
        const updates = db.query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE expenses'));
        expect(updates.map(([, p]) => p)).toEqual([[20, 1], [21, 3]]);
        // The guard is in the WHERE clause too, so a row the user just categorized is safe.
        for (const [sql] of updates) expect(sql).toContain('category_id IS NULL');
    });

    test('repairLoanDisbursements moves a loan out of income inside one transaction', async () => {
        db.query
            .mockResolvedValueOnce([[{ raw_id: 5, income_id: 8, user_id: 42, amount: '41000.00', currency: 'ILS', description: 'העמדת הלואה', created_at: '2026-10-02' }]])
            .mockResolvedValueOnce([[{ category_id: 20 }]]);
        // resetMocks wipes the pool's defaults; re-arm the connection for this test.
        db.getConnection.mockResolvedValue(db._conn);
        for (const fn of ['beginTransaction', 'commit', 'rollback']) db._conn[fn].mockResolvedValue();
        db._conn.query.mockResolvedValueOnce([{ insertId: 99 }]).mockResolvedValue([{ affectedRows: 1 }]);
        expect(await commitments.repairLoanDisbursements()).toBe(1);
        const calls = db._conn.query.mock.calls;
        expect(calls[0][0]).toMatch(/INSERT INTO expenses/);
        expect(calls[0][1]).toEqual([42, -41000, 'ILS', 'העמדת הלואה', 20, '2026-10-02']);
        expect(calls[1][1]).toEqual([99, 5]);
        expect(calls[2][0]).toMatch(/DELETE FROM income/);
        expect(db._conn.commit).toHaveBeenCalled();
    });
});
