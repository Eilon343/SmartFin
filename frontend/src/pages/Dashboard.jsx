import { useEffect, useState, useCallback } from 'react';
import api from '../api/client';
import Icon from '../components/ui/Icon';
import ProgressBar, { pct, tone } from '../components/ui/ProgressBar';
import Ring from '../components/ui/Ring';
import Sparkline from '../components/ui/Sparkline';
import PageHeader from '../components/ui/PageHeader';
import Modal from '../components/ui/Modal';
import Drawer from '../components/ui/Drawer';
import Toast from '../components/ui/Toast';

const CAT_COLORS = [
  '#f59e0b','#60a5fa','#a78bfa','#f472b6','#34d399','#fb7185',
  '#22d3ee','#94a3b8','#facc15','#818cf8','#4ade80','#f97316',
];
const CAT_ICONS = {
  food: 'utensils-crossed', groceries: 'utensils-crossed', restaurant: 'wine',
  transport: 'car', transit: 'car', home: 'house', housing: 'house',
  utilities: 'zap', leisure: 'wine', entertainment: 'tv',
  health: 'heart-pulse', medical: 'heart-pulse', shopping: 'shopping-bag',
  kids: 'baby', misc: 'package', other: 'package',
  clothing: 'shirt', education: 'graduation-cap', travel: 'plane',
  gym: 'dumbbell', sports: 'dumbbell', pets: 'paw-print',
};

function catIcon(name) {
  const key = name?.toLowerCase().replace(/[^a-z]/g, '');
  for (const [k, v] of Object.entries(CAT_ICONS)) {
    if (key?.includes(k)) return v;
  }
  return 'tag';
}

function catColor(index) {
  return CAT_COLORS[index % CAT_COLORS.length];
}

function fmt(n, dp = 0) {
  const sign = n < 0 ? '-' : '';
  return `${sign}₪${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

function fmtSign(n) {
  return (n >= 0 ? '+' : '−') + '₪' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatDate(isoOrDateStr) {
  const d = new Date(isoOrDateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

/* -------- Category card -------- */
function CategoryCard({ budget, color, icon, onOpen }) {
  const hasLimit = !budget.no_budget && budget.effective_limit != null;
  const p = hasLimit ? pct(budget.spent, budget.effective_limit) : 0;
  const t = tone(p);
  const colorMap = { ok: 'var(--emerald)', warn: 'var(--amber)', over: 'var(--rose)' };
  const over = hasLimit && budget.spent > budget.effective_limit;
  return (
    <div className="card card-pad cat-card focusable" tabIndex={0} onClick={onOpen}
         onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}>
      <div className="between">
        <div className="row" style={{ gap: 12 }}>
          <div className="cat-icon" style={{ color }}>
            <Icon name={icon} size={18} />
          </div>
          <div className="stack">
            <div style={{ fontWeight: 600, fontSize: 14 }}>{budget.category}</div>
            <div className="muted-2" style={{ fontSize: 11 }}>
              {hasLimit ? `${Math.round(p)}% used${over ? ' · over budget' : ''}` : 'no budget set'}
            </div>
          </div>
        </div>
        <Icon name="chevron-right" size={16} color="var(--text-3)" />
      </div>
      <div>
        <div className="between" style={{ marginBottom: 6 }}>
          <span className="mono tnum" style={{ fontSize: 14, fontWeight: 600 }}>
            {fmt(budget.spent)}
          </span>
          {hasLimit && (
            <span className="mono tnum muted" style={{ fontSize: 12 }}>
              / {fmt(budget.effective_limit)}
            </span>
          )}
        </div>
        {hasLimit && <ProgressBar value={budget.spent} max={budget.effective_limit} />}
        {hasLimit && (
          <div className="between" style={{ marginTop: 8 }}>
            <span className="meta-label" style={{ color: colorMap[t] }}>
              {over ? 'over by ' + fmt(budget.spent - budget.effective_limit) : fmt(budget.remaining) + ' left'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* -------- Category drawer -------- */
function CategoryDrawer({ budget, color, icon, expenses, onClose }) {
  if (!budget) return null;
  const catExpenses = expenses.filter(e => e.category_name === budget.category);
  const p = pct(budget.spent, budget.effective_limit);
  return (
    <Drawer open={!!budget} onClose={onClose}>
      <div className="between" style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)' }}>
        <div className="row" style={{ gap: 12 }}>
          <div className="cat-icon" style={{ color }}>
            <Icon name={icon} size={18} />
          </div>
          <div className="stack">
            <span style={{ fontWeight: 700, fontSize: 16 }}>{budget.category}</span>
            <span className="muted" style={{ fontSize: 12 }}>{catExpenses.length} transactions this month</span>
          </div>
        </div>
        <button className="btn ghost icon" onClick={onClose}><Icon name="x" size={16} /></button>
      </div>
      <div style={{ padding: 20, overflow: 'auto', flex: 1 }}>
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <div className="between" style={{ marginBottom: 10 }}>
            <span className="mono tnum" style={{ fontWeight: 700, fontSize: 22 }}>{fmt(budget.spent)}</span>
            <span className="mono muted">/ {fmt(budget.effective_limit)}</span>
          </div>
          <ProgressBar value={budget.spent} max={budget.effective_limit} height={8} />
          <div className="between" style={{ marginTop: 10 }}>
            <span className="muted" style={{ fontSize: 12 }}>{Math.round(p)}% of budget used</span>
            <span className="mono" style={{ fontSize: 12, color: budget.spent > budget.effective_limit ? 'var(--rose)' : 'var(--emerald)' }}>
              {budget.spent > budget.effective_limit
                ? 'over by ' + fmt(budget.spent - budget.effective_limit)
                : fmt(budget.remaining) + ' left'}
            </span>
          </div>
        </div>
        <div className="meta-label" style={{ marginBottom: 10 }}>Transactions</div>
        {catExpenses.length === 0
          ? <div className="muted" style={{ fontSize: 13 }}>No transactions yet for this category.</div>
          : catExpenses.map(e => (
              <div key={e.expense_id} className="between" style={{ padding: '12px 0', borderBottom: '1px solid var(--row-divider)' }}>
                <div className="stack">
                  <span style={{ fontSize: 13.5, fontWeight: 500 }}>{e.description || e.category_name}</span>
                  <span className="muted-2" style={{ fontSize: 11 }}>{formatDate(e.created_at)}</span>
                </div>
                <span className="mono tnum" style={{ fontWeight: 600 }}>−{fmt(e.amount)}</span>
              </div>
            ))
        }
      </div>
    </Drawer>
  );
}

/* -------- Savings card -------- */
const GOAL_COLORS = ['#6366f1','#10b981','#f472b6','#f59e0b','#fb7185','#22d3ee'];
const GOAL_ICONS = ['plane','shield-check','laptop','gem','home','car','graduation-cap','heart','baby','gift'];

function SavingsCard({ goals, onContribute }) {
  return (
    <div className="card card-pad-lg">
      <div className="between" style={{ marginBottom: 16 }}>
        <h3 className="h2">Savings Goals</h3>
        <span className="chip idg"><Icon name="piggy-bank" size={11} /> {goals.length} active</span>
      </div>
      <div>
        {goals.map((g, i) => {
          const color = GOAL_COLORS[i % GOAL_COLORS.length];
          const icon = GOAL_ICONS[i % GOAL_ICONS.length];
          const p = pct(g.saved_amount, g.target_amount);
          return (
            <div key={g.goal_id} className="goal">
              <Ring value={g.saved_amount} max={g.target_amount} color={color} size={84} stroke={8} />
              <div className="stack" style={{ gap: 8, minWidth: 0 }}>
                <div className="between" style={{ gap: 8 }}>
                  <div className="row" style={{ gap: 8, minWidth: 0 }}>
                    <Icon name={icon} size={14} color={color} />
                    <span style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {g.name}
                    </span>
                  </div>
                  <button className="btn ghost" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={() => onContribute(g)}>
                    <Icon name="plus" size={12} /> Add
                  </button>
                </div>
                <div className="between">
                  <span className="mono tnum" style={{ fontWeight: 600, fontSize: 13 }}>
                    {fmt(g.saved_amount)} <span className="muted" style={{ fontWeight: 400 }}>/ {fmt(g.target_amount)}</span>
                  </span>
                </div>
                <div className="pb-track" style={{ height: 4 }}>
                  <div className="pb-fill" style={{ width: Math.min(100, p) + '%', background: color }} />
                </div>
              </div>
            </div>
          );
        })}
        {goals.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No savings goals yet.</div>}
      </div>
    </div>
  );
}

/* -------- Contribute modal -------- */
function ContributeModal({ open, goal, onClose, onSubmit }) {
  const [amt, setAmt] = useState('');
  useEffect(() => { if (open) setAmt(''); }, [open]);
  if (!goal) return null;
  const color = GOAL_COLORS[0];
  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); const n = parseFloat(amt); if (n > 0) { onSubmit(goal.goal_id, n); onClose(); } }} className="stack" style={{ gap: 14 }}>
        <div className="between">
          <div className="row" style={{ gap: 10 }}>
            <Icon name="piggy-bank" size={18} color={color} />
            <h3 className="h2" style={{ fontSize: 17 }}>Contribute to {goal.name}</h3>
          </div>
          <button type="button" className="btn ghost icon" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <Ring value={goal.saved_amount} max={goal.target_amount} color={color} size={120} stroke={10} />
        <div className="muted" style={{ textAlign: 'center', fontSize: 13 }}>
          {fmt(goal.saved_amount)} of {fmt(goal.target_amount)} ({Math.round(pct(goal.saved_amount, goal.target_amount))}%)
        </div>
        <div className="field">
          <label>Amount to add (₪)</label>
          <input className="input mono" type="number" step="1" autoFocus value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="500" />
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {[100, 250, 500, 1000].map(v => (
            <button type="button" key={v} className="btn ghost" style={{ height: 30, fontSize: 12 }} onClick={() => setAmt(String(v))}>
              +₪{v}
            </button>
          ))}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary"><Icon name="plus" size={13} /> Add to goal</button>
        </div>
      </form>
    </Modal>
  );
}

/* -------- Subscriptions mini card -------- */
function SubscriptionsMini({ subs }) {
  const total = subs.reduce((s, x) => s + x.amount, 0);
  return (
    <div className="card card-pad-lg">
      <div className="between" style={{ marginBottom: 14 }}>
        <div className="stack">
          <h3 className="h2">Subscriptions</h3>
          <span className="muted" style={{ fontSize: 12 }}>{subs.length} active</span>
        </div>
        <span className="chip idg"><Icon name="repeat" size={11} /> {fmt(total, 0)}/mo</span>
      </div>
      <div>
        {subs.slice(0, 5).map(s => (
          <div key={s.subscription_id} className="sub-row">
            <div style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--hover-bg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="repeat" size={15} color="var(--text-1)" />
            </div>
            <div className="stack">
              <span style={{ fontWeight: 500, fontSize: 13.5 }}>{s.name}</span>
              <span className="muted-2" style={{ fontSize: 11 }}>Monthly · day {s.day_of_month}</span>
            </div>
            <span className="mono tnum" style={{ fontSize: 13 }}>{fmt(s.amount, s.amount % 1 ? 2 : 0)}</span>
          </div>
        ))}
        {subs.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No subscriptions found.</div>}
      </div>
    </div>
  );
}

/* -------- Transactions table -------- */
function TransactionsTable({ expenses }) {
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="between" style={{ padding: '18px 22px 12px' }}>
        <div className="stack">
          <h3 className="h2">Recent Transactions</h3>
          <span className="muted" style={{ fontSize: 12 }}>This month · from Telegram bot</span>
        </div>
        <span className="chip"><Icon name="message-circle" size={11} /> tg-bot</span>
      </div>
      <div className="tx-row head">
        <div>Date</div><div>Description</div><div>Category</div><div style={{ textAlign: 'right' }}>Amount</div><div style={{ textAlign: 'right' }}>Type</div>
      </div>
      {expenses.slice(0, 12).map(e => (
        <div key={e.expense_id} className="tx-row">
          <div className="mono muted" style={{ fontSize: 12 }}>{formatDate(e.created_at)}</div>
          <div className="stack" style={{ minWidth: 0 }}>
            <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {e.description || e.category_name}
            </span>
            <span className="tx-meta-mobile muted-2" style={{ fontSize: 11, gap: 8, display: 'flex' }}>
              {formatDate(e.created_at)} · {e.category_name}
            </span>
          </div>
          <div className="row desktop-only" style={{ gap: 8 }}>
            <Icon name={catIcon(e.category_name)} size={13} color="var(--text-2)" />
            <span style={{ fontSize: 13, color: 'var(--text-1)' }}>{e.category_name}</span>
          </div>
          <div className="mono tnum" style={{ textAlign: 'right', fontWeight: 600 }}>
            −{fmt(e.amount)}
          </div>
          <div className="desktop-only" style={{ textAlign: 'right' }}>
            <span className="vr real">real</span>
          </div>
        </div>
      ))}
      {expenses.length === 0 && (
        <div style={{ padding: '24px 22px', color: 'var(--text-3)', fontSize: 13 }}>No transactions this month.</div>
      )}
    </div>
  );
}

/* -------- Net Position header -------- */
function NetPosition({ pnl }) {
  if (!pnl) return null;
  const net = pnl.net_pnl;
  const up = net >= 0;
  return (
    <div className="card card-pad-lg" style={{ marginBottom: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 28, alignItems: 'center' }}
           className="np-grid">
        <div className="stack" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 10 }}>
            <span className="meta-label">P&amp;L Forecast — {new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' })}</span>
            <span className="chip idg"><Icon name="sparkles" size={11} /> projected</span>
          </div>
          <div>
            <div className="big-num">
              <span className="ccy">₪</span>{Math.abs(net).toLocaleString('en-US')}
            </div>
            <div className="row" style={{ gap: 10, marginTop: 12 }}>
              <span className={`chip ${up ? 'up' : 'down'}`}>
                <Icon name={up ? 'trending-up' : 'trending-down'} size={12} />
                {up ? 'Surplus' : 'Deficit'}
              </span>
            </div>
          </div>
          <div className="legend" style={{ marginTop: 6 }}>
            <div><span className="dot" style={{ background: 'var(--emerald)' }} /> Income {fmt(pnl.total_income)}</div>
            <div><span className="dot" style={{ background: 'var(--rose)' }} /> Expenses {fmt(pnl.total_expenses)}</div>
            {pnl.subscription_total > 0 && <div><span className="dot" style={{ background: 'var(--indigo)' }} /> Subs {fmt(pnl.subscription_total)}</div>}
          </div>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <div className="between">
            <span className="meta-label">Breakdown</span>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {[
              { label: 'Fixed income', val: pnl.fixed_income, color: 'var(--emerald)' },
              { label: 'Variable avg', val: pnl.variable_income_avg, color: 'var(--emerald)' },
              { label: 'Expenses', val: -pnl.total_expenses, color: 'var(--rose)' },
              { label: 'Subscriptions', val: -pnl.subscription_total, color: 'var(--indigo)' },
              { label: 'Savings alloc.', val: -pnl.savings_allocation, color: 'var(--amber)' },
            ].filter(r => r.val !== 0).map(r => (
              <div key={r.label} className="between" style={{ fontSize: 12.5 }}>
                <span className="muted">{r.label}</span>
                <span className="mono tnum" style={{ color: r.color, fontWeight: 600 }}>
                  {r.val > 0 ? '+' : ''}₪{Math.abs(r.val).toLocaleString('en-US')}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <style>{`@media (max-width: 760px){ .np-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

/* -------- Income card -------- */
function IncomeCard({ income }) {
  if (!income) return null;
  return (
    <div className="card card-pad-lg">
      <div className="between" style={{ marginBottom: 14 }}>
        <h3 className="h2">Income</h3>
        <span className="chip up"><Icon name="arrow-down-to-line" size={11} /> {fmt(income.total)}</span>
      </div>
      <div className="stack" style={{ gap: 10 }}>
        <div className="between">
          <div className="row" style={{ gap: 8 }}>
            <span className="dot" style={{ background: 'var(--emerald)' }} />
            <span style={{ fontWeight: 500 }}>Fixed</span>
            <span className="muted" style={{ fontSize: 12 }}>· {income.fixed.length} sources</span>
          </div>
          <span className="mono tnum" style={{ fontWeight: 600 }}>{fmt(income.fixed_total)}</span>
        </div>
        {income.fixed.map((f, i) => (
          <div key={i} className="between" style={{ paddingLeft: 16 }}>
            <span className="muted" style={{ fontSize: 13 }}>{f.source}</span>
            <span className="mono tnum muted" style={{ fontSize: 13 }}>{fmt(f.amount)}</span>
          </div>
        ))}
      </div>
      {income.variable.length > 0 && (
        <>
          <div className="div" />
          <div className="stack" style={{ gap: 10 }}>
            <div className="between">
              <div className="row" style={{ gap: 8 }}>
                <span className="dot" style={{ background: 'var(--indigo)' }} />
                <span style={{ fontWeight: 500 }}>Variable</span>
                <span className="muted" style={{ fontSize: 12 }}>· 3-mo avg</span>
              </div>
              <span className="mono tnum" style={{ fontWeight: 600 }}>{fmt(income.variable_total)}</span>
            </div>
            {income.variable.map((v, i) => (
              <div key={i} className="between" style={{ paddingLeft: 16 }}>
                <span className="muted" style={{ fontSize: 13 }}>{v.source}</span>
                <span className="mono tnum muted" style={{ fontSize: 13 }}>{fmt(v.amount)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* -------- Main Dashboard -------- */
export default function Dashboard() {
  const [month] = useState(currentMonth());
  const [pnl, setPnl] = useState(null);
  const [budgets, setBudgets] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [income, setIncome] = useState(null);
  const [subs, setSubs] = useState([]);
  const [goals, setGoals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openBudget, setOpenBudget] = useState(null);
  const [contributeGoal, setContributeGoal] = useState(null);
  const [contributeOpen, setContributeOpen] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    Promise.allSettled([
      api.get(`/pnl?month=${month}`),
      api.get(`/budgets?month=${month}`),
      api.get(`/expenses?month=${month}`),
      api.get(`/income/summary?month=${month}`),
      api.get('/subscriptions'),
      api.get('/savings'),
    ]).then(([p, b, e, inc, s, g]) => {
      if (p.status === 'fulfilled') setPnl(p.value.data);
      if (b.status === 'fulfilled') setBudgets(b.value.data.budgets || []);
      if (e.status === 'fulfilled') setExpenses(Array.isArray(e.value.data) ? e.value.data : []);
      if (inc.status === 'fulfilled') setIncome(inc.value.data);
      if (s.status === 'fulfilled') setSubs(Array.isArray(s.value.data) ? s.value.data : []);
      if (g.status === 'fulfilled') setGoals(Array.isArray(g.value.data) ? g.value.data : []);
    }).finally(() => setLoading(false));
  }, [month]);

  useEffect(() => { load(); }, [load]);

  const handleContribute = async (goalId, amount) => {
    await api.post(`/savings/${goalId}/deposit`, { amount });
    setToast(`Contributed ₪${amount.toLocaleString()} to goal`);
    load();
  };

  const today = new Date();
  const daysLeft = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <div className="stack" style={{ alignItems: 'center', gap: 12 }}>
          <Icon name="loader-circle" size={32} color="var(--emerald)" style={{ animation: 'spin 1s linear infinite' }} />
          <span className="muted">Loading your finances…</span>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div className="view-enter">
      <PageHeader
        title={`Good ${today.getHours() < 12 ? 'morning' : today.getHours() < 18 ? 'afternoon' : 'evening'}`}
        sub={`${today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · ${daysLeft} days left in the month`}
      />

      <NetPosition pnl={pnl} />

      {budgets.length > 0 && (
        <section style={{ marginBottom: 22 }}>
          <div className="between" style={{ marginBottom: 12 }}>
            <h3 className="h2">Category Budgets</h3>
            <div className="row" style={{ gap: 12 }}>
              <span className="legend">
                <div><span className="dot" style={{ background: 'var(--emerald)' }} /> &lt; 50%</div>
                <div><span className="dot" style={{ background: 'var(--amber)' }} /> 50–80%</div>
                <div><span className="dot" style={{ background: 'var(--rose)' }} /> &gt; 80%</div>
              </span>
            </div>
          </div>
          <div className="grid grid-4">
            {budgets.map((b, i) => (
              <CategoryCard
                key={b.budget_id ?? b.category}
                budget={b}
                color={catColor(i)}
                icon={catIcon(b.category)}
                onOpen={() => setOpenBudget({ budget: b, color: catColor(i), icon: catIcon(b.category) })}
              />
            ))}
          </div>
        </section>
      )}

      <section className="grid grid-3" style={{ marginBottom: 22 }}>
        <IncomeCard income={income} />
        <SubscriptionsMini subs={subs} />
        <SavingsCard
          goals={goals.slice(0, 3)}
          onContribute={(g) => { setContributeGoal(g); setContributeOpen(true); }}
        />
      </section>

      <section>
        <TransactionsTable expenses={expenses} />
      </section>

      {openBudget && (
        <CategoryDrawer
          budget={openBudget.budget}
          color={openBudget.color}
          icon={openBudget.icon}
          expenses={expenses}
          onClose={() => setOpenBudget(null)}
        />
      )}

      <ContributeModal
        open={contributeOpen}
        goal={contributeGoal}
        onClose={() => setContributeOpen(false)}
        onSubmit={handleContribute}
      />

      <Toast msg={toast} onDone={() => setToast('')} />
    </div>
  );
}
