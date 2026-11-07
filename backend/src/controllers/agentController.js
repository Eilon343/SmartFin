const db = require('../config/db');
const fx = require('../services/forecastMath');
const cy = require('../services/cycle');
const expenseController = require('./expenseController');
const insightsController = require('./insightsController');
const commitments = require('./commitmentsController');
const loansController = require('./loansController');
const { zonedParts } = require('../utils/zonedTime');

// Read-only endpoints for an external AI agent (routes/agentRoutes.js, behind agentAuth).
//
// Every number comes from the dashboard's own controllers (getPnL, getBudgets, getInsights),
// called in-process, so the agent and the dashboard can never disagree about a figure.
// This file only picks fields and flattens them.
//
// PRIVACY RULE: the agent must never learn that bank connections exist. Nothing here may
// read a bank_* table or emit a field that reveals one (e.g. expenses.source = 'bank_sync').
// Every response is built from an explicit allowlist; tests/backend/agent.test.js enforces it.
// Installments come from installment_plans and loans from loans — derived/manual tables,
// not bank_* tables — and are re-shaped below so no provenance field (`source`) leaks.

const money = fx.money;

// Runs an Express handler and resolves with what it would have sent.
function run(handler, req, query = {}) {
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) {
                if (this.statusCode >= 400) {
                    const err = new Error(body?.error || 'Internal request failed');
                    err.status = this.statusCode;
                    reject(err);
                } else resolve(body);
            },
        };
        const subReq = { user: req.user, cycleSettings: req.cycleSettings, query, params: {}, body: {} };
        Promise.resolve(handler(subReq, res)).catch(reject);
    });
}

// The user's calendar date. The containers run on UTC, so reading a Date's local fields
// would date a 00:30 purchase in Israel to the previous day.
const USER_TZ = 'Asia/Jerusalem';
const pad2 = (n) => String(n).padStart(2, '0');
function localDate(d) {
    const p = zonedParts(d instanceof Date ? d : new Date(d), USER_TZ);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

// Explicit allowlists for the commitments blocks.
function agentInstallment(p) {
    return {
        merchant: p.merchant,
        monthly_amount: p.monthly_amount,
        total_amount: p.total_amount,
        total_payments: p.total_payments,
        payments_made: p.payments_made,
        remaining_payments: p.remaining_payments,
        remaining_amount: p.remaining_amount,
        next_payment_date: p.next_payment_date,
        end_date: p.end_date,
    };
}
function agentLoan(l) {
    return {
        lender: l.lender,
        loan_type: l.loan_type,
        original_amount: l.original_amount,
        outstanding_balance: l.outstanding_balance,
        interest_rate: l.interest_rate,
        monthly_payment: l.monthly_payment,
        remaining_payments: l.remaining_payments,
        next_payment_date: l.next_payment_date,
        balance_updated_at: l.balance_updated_at,
        finished: l.finished,
        // Imported repayments lower the balance automatically; this is that history.
        recent_payments: l.payments.slice(0, 6).map(p => ({ date: p.date, amount: p.amount, balance_after: p.balance_after })),
        // Loans are typed in by the user — the agent should treat balances as "as of".
        entry: 'manual',
    };
}
async function loadCommitments(userId) {
    const [subs, plans, loans] = await Promise.all([
        commitments.loadActiveSubscriptions(userId),
        commitments.loadInstallmentPlans(userId),
        loansController.loadLoans(userId),
    ]);
    const active = plans.filter(p => p.active);
    const instSummary = commitments.summarizeInstallments(plans);
    const loanSummary = loansController.summarizeLoans(loans);
    const subsTotal = money(subs.reduce((s, x) => s + x.amount, 0));
    return {
        subscriptions: {
            monthly_total: subsTotal,
            items: subs.map(x => ({
                name: x.name,
                amount: x.amount,
                day_of_month: x.day_of_month,
                category: x.category,
                auto_detected: x.auto_detected,
                confirmed: x.confirmed,
            })),
        },
        installments: {
            active_count: instSummary.active_count,
            monthly_commitment: instSummary.monthly_commitment,
            remaining_total: instSummary.remaining_total,
            items: active.map(agentInstallment),
        },
        loans: loans.map(agentLoan),
        loans_summary: {
            count: loanSummary.count,
            total_outstanding: loanSummary.total_outstanding,
            total_monthly_payment: loanSummary.total_monthly_payment,
            next_payment: loanSummary.next_payment,
        },
        recurring_monthly_total: money(subsTotal + instSummary.monthly_commitment + loanSummary.total_monthly_payment),
    };
}

async function buildSnapshot(req) {
    const settings = req.cycleSettings;
    const month = cy.currentCycleKey(settings);
    const cycle = cy.resolveCycle(month, settings);
    const user_id = req.user.user_id;

    const [pnl, budgets, insights, [subRows], [recentRows], commit] = await Promise.all([
        run(expenseController.getPnL, req, { month }),
        run(expenseController.getBudgets, req, { month }),
        run(insightsController.getInsights, req, { month }),
        db.query(
            `SELECT s.name, s.amount, s.day_of_month, c.name AS category
             FROM subscriptions s LEFT JOIN categories c ON s.category_id = c.category_id
             WHERE s.user_id = ? AND s.active = TRUE AND s.paused = FALSE`,
            [user_id]
        ),
        db.query(
            `SELECT e.created_at, e.amount, e.description, c.name AS category
             FROM expenses e LEFT JOIN categories c ON e.category_id = c.category_id
                  AND (c.user_id IS NULL OR c.user_id = ?)
             WHERE e.user_id = ? AND e.is_virtual = FALSE
               AND e.created_at >= ? AND e.created_at < ?
             ORDER BY e.created_at DESC LIMIT 10`,
            [user_id, user_id, cycle.start, cycle.end]
        ),
        loadCommitments(user_id),
    ]);

    const daysLeft = pnl.days_left || 0;
    const typicalByName = new Map((insights.by_category || []).map(c => [c.name, c.three_mo_avg]));
    const fixedByName = new Map((insights.by_category || []).map(c => [c.name, c.is_fixed]));

    const categories = (budgets.budgets || [])
        .filter(b => b.spent > 0 || b.effective_limit != null)
        .map(b => {
            const hasBudget = b.effective_limit != null;
            const isFixed = !!fixedByName.get(b.category);
            return {
                category: b.category,
                is_fixed: isFixed,
                spent: money(b.spent),
                budget: hasBudget ? money(b.effective_limit) : null,
                remaining: hasBudget ? money(b.remaining) : null,
                pct_used: hasBudget ? b.pct_used : null,
                // What a full cycle in this category usually costs (decayed 6-cycle habit).
                typical_cycle: money(typicalByName.get(b.category) ?? 0),
                // Not for fixed categories: rent is not spent a little each day.
                daily_allowance: hasBudget && !isFixed && daysLeft > 0 ? money(Math.max(0, b.remaining) / daysLeft) : null,
            };
        })
        .sort((a, b) => b.spent - a.spent);

    const budgeted = categories.filter(c => c.budget != null);
    // Same "has it been charged yet" test as getPnL, so this list sums to subscriptions_ahead.
    const pnlToday = cy.todayISO();
    const upcoming = subRows
        .map(s => ({ name: s.name, amount: money(Number(s.amount)), category: s.category, date: cy.chargeDateInCycle(cycle, s.day_of_month) }))
        .filter(s => s.date > pnlToday)
        .sort((a, b) => a.date.localeCompare(b.date));

    return {
        currency: 'ILS',
        generated_at: new Date().toISOString(),
        today: localDate(new Date()),
        cycle_start: pnl.cycle_start,
        cycle_end: pnl.cycle_end,
        cycle_day: pnl.cycle_day,
        days_in_cycle: pnl.days_in_cycle,
        days_left: daysLeft,

        income_received: pnl.total_income_actual,
        income_forecast: pnl.total_income_projected,
        spent: pnl.total_expenses,
        spent_fixed: pnl.fixed_expenses,
        spent_variable: pnl.variable_expenses,
        spent_forecast: pnl.projected_expenses,
        subscriptions_ahead: pnl.subscription_total,
        // Committed money still to leave this cycle that is not spent yet (in net_forecast).
        installments_ahead: pnl.installments_ahead,
        loan_payments_ahead: pnl.loan_payments_ahead,
        savings_set_aside: pnl.savings_allocation,

        net_now: pnl.current_net_pnl,
        net_forecast: pnl.forecasted_net_pnl,
        net_forecast_low: pnl.forecast_low,
        net_forecast_high: pnl.forecast_high,
        // Money left for the rest of the cycle after everything committed, and per day.
        headroom: pnl.safe_to_spend_headroom,
        daily_allowance: pnl.safe_to_spend_per_day,

        budget_total: money(budgeted.reduce((s, c) => s + c.budget, 0)),
        budget_spent: money(budgeted.reduce((s, c) => s + c.spent, 0)),
        budget_remaining: money(budgeted.reduce((s, c) => s + c.remaining, 0)),
        history_months: pnl.history_months,

        categories,
        upcoming_subscriptions: upcoming,
        // Committed monthly outflow (Hebrew UI: הוצאות שוטפות) = subscriptions +
        // active card installments + loan repayments.
        recurring_monthly_total: commit.recurring_monthly_total,
        subscriptions: commit.subscriptions,
        installments: commit.installments,
        loans_summary: commit.loans_summary,
        recent_expenses: recentRows.map(r => ({
            date: localDate(r.created_at),
            amount: money(Number(r.amount)),
            description: r.description,
            category: r.category || 'Uncategorized',
        })),
    };
}

exports.getSnapshot = async (req, res) => {
    try {
        res.json(await buildSnapshot(req));
    } catch (err) {
        console.error('agent snapshot error:', err);
        res.status(500).json({ error: 'Failed to build snapshot' });
    }
};

exports.getLoans = async (req, res) => {
    try {
        const c = await loadCommitments(req.user.user_id);
        res.json({ currency: 'ILS', summary: c.loans_summary, loans: c.loans });
    } catch (err) {
        console.error('agent loans error:', err);
        res.status(500).json({ error: 'Failed to load loans' });
    }
};

exports.getInstallments = async (req, res) => {
    try {
        const c = await loadCommitments(req.user.user_id);
        res.json({ currency: 'ILS', ...c.installments });
    } catch (err) {
        console.error('agent installments error:', err);
        res.status(500).json({ error: 'Failed to load installments' });
    }
};

const MAX_WHAT_IF = 1_000_000;

// What the current cycle looks like if `amount` is spent today, in `category` if given.
//
// The purchase is treated as a one-off: it adds exactly `amount` to spending and the
// forecast. Feeding it through the run-rate projection instead would extrapolate a single
// ₪300 purchase as if it were a new daily habit.
exports.whatIf = async (req, res) => {
    const amount = Number(req.query.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_WHAT_IF) {
        return res.status(400).json({ error: `amount must be a number between 0 and ${MAX_WHAT_IF}` });
    }
    const categoryName = typeof req.query.category === 'string' ? req.query.category.trim() : '';

    try {
        const snap = await buildSnapshot(req);
        let cat = null;
        if (categoryName) {
            cat = snap.categories.find(c => c.category.toLowerCase() === categoryName.toLowerCase());
            if (!cat) {
                const [rows] = await db.query(
                    'SELECT name FROM categories WHERE user_id IS NULL OR user_id = ? ORDER BY name',
                    [req.user.user_id]
                );
                const known = rows.find(r => r.name.toLowerCase() === categoryName.toLowerCase());
                if (!known) {
                    return res.status(400).json({ error: 'Unknown category', valid_categories: rows.map(r => r.name) });
                }
                cat = { category: known.name, is_fixed: false, spent: 0, budget: null, remaining: null, pct_used: null, daily_allowance: null };
            }
        }

        const daysLeft = snap.days_left;
        const perDay = (headroom) => (daysLeft > 0 && headroom != null ? money(headroom / daysLeft) : null);
        const minus = (v) => (v == null ? null : money(v - amount));

        const before = {
            spent: snap.spent,
            spent_forecast: snap.spent_forecast,
            net_forecast: snap.net_forecast,
            headroom: snap.headroom,
            daily_allowance: snap.daily_allowance,
        };
        const after = {
            spent: money(snap.spent + amount),
            spent_forecast: money(snap.spent_forecast + amount),
            net_forecast: minus(snap.net_forecast),
            headroom: minus(snap.headroom),
            daily_allowance: perDay(minus(snap.headroom)),
        };

        let category = null;
        if (cat) {
            const hasBudget = cat.budget != null;
            const remainingAfter = hasBudget ? money(cat.remaining - amount) : null;
            category = {
                category: cat.category,
                budget: cat.budget,
                before: { spent: cat.spent, remaining: cat.remaining, pct_used: cat.pct_used, daily_allowance: cat.daily_allowance },
                after: {
                    spent: money(cat.spent + amount),
                    remaining: remainingAfter,
                    pct_used: hasBudget && cat.budget > 0 ? Math.round(((cat.spent + amount) / cat.budget) * 100) : null,
                    daily_allowance: hasBudget && !cat.is_fixed && daysLeft > 0 ? money(Math.max(0, remainingAfter) / daysLeft) : null,
                },
                over_budget_after: hasBudget ? remainingAfter < 0 : null,
            };
        }

        res.json({
            currency: 'ILS',
            amount: money(amount),
            today: snap.today,
            days_left: daysLeft,
            before,
            after,
            category,
            // Plain verdicts so the agent does not have to do arithmetic.
            within_headroom: snap.headroom != null ? amount <= snap.headroom : null,
            net_forecast_stays_positive: after.net_forecast != null ? after.net_forecast >= 0 : null,
            // More than one day's allowance (the allowance covers the days after today).
            exceeds_daily_allowance: snap.daily_allowance != null ? amount > snap.daily_allowance : null,
            assumption: 'One-off purchase today. Exact cash impact: spending, forecast and headroom move by exactly the amount. Once recorded, the dashboard forecast may move somewhat more, because it also extrapolates spending pace.',
        });
    } catch (err) {
        console.error('agent what-if error:', err);
        res.status(500).json({ error: 'Failed to run what-if' });
    }
};
