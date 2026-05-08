import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import api from '../api/client';
import Icon from '../components/ui/Icon';
import ProgressBar, { pct, tone } from '../components/ui/ProgressBar';
import Ring from '../components/ui/Ring';
import Sparkline from '../components/ui/Sparkline';
import PageHeader from '../components/ui/PageHeader';
import Modal from '../components/ui/Modal';
import Drawer from '../components/ui/Drawer';
import Toast from '../components/ui/Toast';
import Sk from '../components/ui/Skeleton';
import { useI18n } from '../context/I18nContext';

const CAT_COLORS = [
  '#f59e0b', '#60a5fa', '#a78bfa', '#f472b6', '#34d399', '#fb7185',
  '#22d3ee', '#94a3b8', '#facc15', '#818cf8', '#4ade80', '#f97316',
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

// Currency: sign placed before symbol ("-₪221" not "₪-221"). Uses U+2212 for visual weight.
function fmt(n, dp = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = n < 0 ? '−' : '';
  return `${sign}₪${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

function fmtSign(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return (n >= 0 ? '+' : '−') + '₪' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Safe MoM %: handles null prev (no data), zero prev (undefined ratio), and zero-to-zero.
// Returns { value: number|null, label: string, valid: boolean }.
function safePctChange(curr, prev) {
  if (prev == null || curr == null) return { value: null, label: 'N/A', valid: false };
  if (prev === 0) {
    if (curr === 0) return { value: 0, label: '0.0%', valid: true };
    // Undefined ratio (division by zero) — show N/A rather than fake Infinity/100%.
    return { value: null, label: 'N/A', valid: false };
  }
  const v = ((curr - prev) / Math.abs(prev)) * 100;
  return { value: v, label: `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`, valid: true };
}

function formatDate(isoOrDateStr) {
  const d = new Date(isoOrDateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function getRecentMonths(num = 3) {
  const result = [];
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth();

  for (let i = 0; i < num; i++) {
    const d = new Date(y, m, 1);
    const iso = `${y}-${String(m + 1).padStart(2, '0')}`;
    const label = i === 0
      ? d.toLocaleDateString('en-US', { month: 'long' })
      : d.toLocaleDateString('en-US', { month: 'short' });
    result.push({ iso, label });
    m--;
    if (m < 0) { m = 11; y--; }
  }
  return result;
}

/* -------- Category card -------- */
function CategoryCard({ budget, color, icon, onOpen }) {
  const { t } = useI18n();
  const hasLimit = !budget.no_budget && budget.effective_limit != null;
  const p = hasLimit ? pct(budget.spent, budget.effective_limit) : 0;
  const toneMap = tone(p);
  const barColor = { ok: 'var(--emerald)', warn: 'var(--amber)', over: 'var(--rose)' }[toneMap];
  const over = hasLimit && budget.spent > budget.effective_limit;
  return (
    <div className="card card-pad cat-card focusable" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}>
      <div className="between" style={{ marginBottom: 10 }}>
        <div className="cat-icon" style={{ color, width: 36, height: 36, borderRadius: 10 }}>
          <Icon name={icon} size={17} />
        </div>
        <Icon name="chevron-right" size={14} color="var(--text-3)" />
      </div>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {budget.category}
      </div>
      <div className="between" style={{ marginBottom: 6 }}>
        <span className="mono tnum" style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.5 }}>
          {fmt(budget.spent)}
        </span>
        {hasLimit && (
          <span className="mono tnum muted" style={{ fontSize: 11 }}>
            / {fmt(budget.effective_limit)}
          </span>
        )}
      </div>
      {hasLimit && <ProgressBar value={budget.spent} max={budget.effective_limit} height={5} />}
      {hasLimit && (
        <div style={{ marginTop: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', color: barColor }}>
            {over
              ? `${t('dash_over_by')} ${fmt(budget.spent - budget.effective_limit)}`
              : `${fmt(budget.remaining)} ${t('dash_left')}`}
          </span>
        </div>
      )}
      {!hasLimit && (
        <span className="muted-2" style={{ fontSize: 11 }}>{t('dash_no_budget')}</span>
      )}
    </div>
  );
}

/* -------- Category drawer -------- */
function CategoryDrawer({ budget, color, icon, expenses, onClose, onReload }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [limitVal, setLimitVal] = useState('');
  const [carryOver, setCarryOver] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (budget) {
      setLimitVal(budget.monthly_limit != null ? String(budget.monthly_limit) : '');
      setCarryOver(!!budget.carry_over);
      setEditing(false);
    }
  }, [budget]);

  if (!budget) return null;
  const catExpenses = expenses.filter(e => e.category_name === budget.category);
  const p = pct(budget.spent, budget.effective_limit);
  const hasLimit = !budget.no_budget && budget.effective_limit != null;

  async function saveBudget(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/budgets', {
        category_id: budget.category_id,
        monthly_limit: Number(limitVal),
        carry_over: carryOver,
      });
      setEditing(false);
      onReload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer open={!!budget} onClose={onClose}>
      <div className="between" style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)' }}>
        <div className="row" style={{ gap: 12 }}>
          <div className="cat-icon" style={{ color }}>
            <Icon name={icon} size={18} />
          </div>
          <div className="stack">
            <span style={{ fontWeight: 700, fontSize: 16 }}>{budget.category}</span>
            <span className="muted" style={{ fontSize: 12 }}>{catExpenses.length} {t('dash_tx_month')}</span>
          </div>
        </div>
        <button className="btn ghost icon" onClick={onClose}><Icon name="x" size={16} /></button>
      </div>
      <div style={{ padding: 20, overflow: 'auto', flex: 1 }}>
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          {editing ? (
            <form onSubmit={saveBudget} className="stack" style={{ gap: 12 }}>
              <div className="between">
                <span style={{ fontWeight: 600, fontSize: 14 }}>Set monthly budget</span>
                <button type="button" className="btn ghost icon" onClick={() => setEditing(false)}><Icon name="x" size={14} /></button>
              </div>
              <div className="field">
                <label>Monthly limit (₪)</label>
                <input className="input mono" type="number" step="1" min="1" autoFocus
                  value={limitVal} onChange={e => setLimitVal(e.target.value)} placeholder="e.g. 2000" />
              </div>
              <label className="row" style={{ gap: 8, cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={carryOver} onChange={e => setCarryOver(e.target.checked)} />
                <span className="muted">Roll unspent balance to next month</span>
              </label>
              <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
                <button type="submit" className="btn primary" disabled={saving}>
                  <Icon name="check" size={13} /> {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="between" style={{ marginBottom: hasLimit ? 10 : 0 }}>
                <span className="mono tnum" style={{ fontWeight: 700, fontSize: 22 }}>{fmt(budget.spent)}</span>
                <div className="row" style={{ gap: 8 }}>
                  {hasLimit && <span className="mono muted">/ {fmt(budget.effective_limit)}</span>}
                  <button className="btn ghost icon" style={{ width: 28, height: 28 }} onClick={() => setEditing(true)}>
                    <Icon name="pencil" size={13} color="var(--text-3)" />
                  </button>
                </div>
              </div>
              {hasLimit && (
                <>
                  <ProgressBar value={budget.spent} max={budget.effective_limit} height={8} />
                  <div className="between" style={{ marginTop: 10 }}>
                    <span className="muted" style={{ fontSize: 12 }}>{Math.round(p)}% of budget used</span>
                    <span className="mono" style={{ fontSize: 12, color: budget.spent > budget.effective_limit ? 'var(--rose)' : 'var(--emerald)' }}>
                      {budget.spent > budget.effective_limit
                        ? 'over by ' + fmt(budget.spent - budget.effective_limit)
                        : fmt(budget.remaining) + ' left'}
                    </span>
                  </div>
                  {budget.carry_over && (
                    <div className="row" style={{ marginTop: 10, gap: 8 }}>
                      <span className="chip amb"><Icon name="arrow-right" size={10} /> Carry-over</span>
                      {budget.carried_in > 0 && <span className="muted" style={{ fontSize: 12 }}>+{fmt(budget.carried_in)} rolled in</span>}
                    </div>
                  )}
                </>
              )}
              {!hasLimit && (
                <button className="btn ghost" style={{ marginTop: 8, width: '100%', justifyContent: 'center', gap: 6 }}
                  onClick={() => setEditing(true)}>
                  <Icon name="plus" size={13} /> Set a budget limit
                </button>
              )}
            </>
          )}
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
const GOAL_COLORS = ['#6366f1', '#10b981', '#f472b6', '#f59e0b', '#fb7185', '#22d3ee'];
const GOAL_ICONS = ['plane', 'shield-check', 'laptop', 'gem', 'home', 'car', 'graduation-cap', 'heart', 'baby', 'gift'];

function SavingsCard({ goals, onContribute, onEdit, onNew }) {
  return (
    <div className="card card-pad-lg">
      <div className="between" style={{ marginBottom: 16 }}>
        <h3 className="h2">Savings Goals</h3>
        <div className="row" style={{ gap: 8 }}>
          <span className="chip idg"><Icon name="piggy-bank" size={11} /> {goals.length} active</span>
          <button className="btn ghost" style={{ height: 26, fontSize: 12, padding: '0 10px' }} onClick={onNew}>
            <Icon name="plus" size={12} /> New
          </button>
        </div>
      </div>
      <div>
        {goals.map((g, i) => {
          const color = GOAL_COLORS[i % GOAL_COLORS.length];
          const icon = GOAL_ICONS[i % GOAL_ICONS.length];
          const p = pct(g.saved_amount, g.target_amount);
          return (
            <div key={g.goal_id} className="goal">
              <Ring value={g.saved_amount} max={g.target_amount} color={color} size={84} stroke={8} label={`${Math.round(p)}%`} />
              <div className="stack" style={{ gap: 8, minWidth: 0 }}>
                <div className="between" style={{ gap: 8 }}>
                  <div className="row" style={{ gap: 8, minWidth: 0 }}>
                    <Icon name={icon} size={14} color={color} />
                    <span style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {g.name}
                    </span>
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    <button className="btn ghost icon" style={{ width: 28, height: 28, color: 'var(--text-2)' }} onClick={() => onEdit(g)}>
                      <Icon name="pencil" size={12} />
                    </button>
                    <button className="btn ghost" style={{ height: 28, padding: '0 10px', fontSize: 12 }} onClick={() => onContribute(g)}>
                      <Icon name="plus" size={12} /> Add
                    </button>
                  </div>
                </div>
                <div className="between">
                  <span className="mono tnum" style={{ fontWeight: 600, fontSize: 13 }}>
                    {fmt(g.saved_amount)} <span className="muted" style={{ fontWeight: 400 }}>/ {fmt(g.target_amount)}</span>
                  </span>
                  <span className="muted" style={{ fontSize: 11 }}>Ongoing</span>
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
const SUB_ICONS_MAP = {
  spotify: 'music-2', apple: 'apple', netflix: 'clapperboard', youtube: 'youtube',
  icloud: 'cloud', google: 'cloud', dropbox: 'cloud', notion: 'notebook-pen',
  gym: 'dumbbell', fitness: 'dumbbell', domain: 'globe', hosting: 'server',
  phone: 'smartphone', mobile: 'smartphone', amazon: 'shopping-bag',
  microsoft: 'laptop', adobe: 'pen-tool', github: 'code',
};

function subIcon(name) {
  const key = name?.toLowerCase().replace(/[^a-z]/g, '');
  for (const [k, v] of Object.entries(SUB_ICONS_MAP)) {
    if (key?.includes(k)) return v;
  }
  return 'repeat';
}

function ordinal(d) {
  const s = ['th', 'st', 'nd', 'rd'], v = d % 100;
  return d + (s[(v - 20) % 10] || s[v] || s[0]);
}

function SubscriptionsMini({ subs, onTogglePause }) {
  const activeSubs = subs.filter(s => !s.paused);
  const total = activeSubs.reduce((s, x) => s + x.amount, 0);
  return (
    <div className="card card-pad-lg" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="between" style={{ marginBottom: 14 }}>
        <div className="stack">
          <h3 className="h2">Subscriptions</h3>
          <span className="muted" style={{ fontSize: 12 }}>{activeSubs.length} active monthly</span>
        </div>
        <span className="chip idg"><Icon name="repeat" size={11} /> ₪{fmt(total, 0)}/mo</span>
      </div>
      <div style={{ flex: 1 }}>
        {subs.slice(0, 5).map(s => (
          <div key={s.subscription_id} className="sub-row" style={{ gridTemplateColumns: '36px 1fr auto 32px' }}>
            <div style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--hover-bg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={subIcon(s.name)} size={15} color="var(--text-1)" />
            </div>
            <div className="stack" style={{ opacity: s.paused ? 0.6 : 1, flex: 1, minWidth: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <span style={{ fontWeight: 500, fontSize: 13.5 }}>{s.name}</span>
                {!!s.paused && <span className="chip" style={{ fontSize: 9, padding: '2px 6px', background: 'var(--hover-bg)' }}>paused</span>}
              </div>
              <span className="muted-2" style={{ fontSize: 11 }}>Monthly · next on the {ordinal(s.day_of_month)}</span>
            </div>
            <span className="mono tnum" style={{ fontSize: 13, opacity: s.paused ? 0.6 : 1 }}>{fmt(s.amount, s.amount % 1 ? 2 : 0)}</span>
            <button
              className="btn ghost icon"
              style={{ width: 32, height: 32, color: 'var(--text-1)' }}
              onClick={() => onTogglePause(s)}
              title={s.paused ? "Resume" : "Pause"}
            >
              <Icon name={s.paused ? "play" : "pause"} size={16} style={{ fill: 'currentColor' }} />
            </button>
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
          <span className="muted" style={{ fontSize: 12 }}>This month</span>
        </div>
      </div>
      <div className="tx-row head">
        <div>Date</div><div>Description</div><div>Category</div><div style={{ textAlign: 'right' }}>Amount</div><div style={{ textAlign: 'right' }}>Source</div>
      </div>
      {expenses.slice(0, 12).map(e => (
        <div key={e.expense_id} className="tx-row">
          <div className="mono muted desktop-only" style={{ fontSize: 12 }}>{formatDate(e.created_at)}</div>
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
            {e.source === 'apple_pay' ? (
              <span className="vr" style={{ background: '#1a1a1a', color: '#f5f5f7', fontSize: 10, fontWeight: 600 }}>Apple Pay</span>
            ) : e.source === 'bot' ? (
              <span className="vr" style={{ background: 'var(--indigo-soft)', color: 'var(--indigo)' }}>Bot</span>
            ) : e.source === 'web' ? (
              <span className="vr" style={{ background: 'var(--hover-bg-2)', color: 'var(--text-1)' }}>Web</span>
            ) : (
              <span className="vr" style={{ background: 'var(--hover-bg-2)', color: 'var(--text-1)' }}>{e.source || 'Manual'}</span>
            )}
          </div>
        </div>
      ))}
      {expenses.length === 0 && (
        <div style={{ padding: '24px 22px', color: 'var(--text-3)', fontSize: 13 }}>No transactions this month.</div>
      )}
    </div>
  );
}

/* -------- Compute real daily cumulative spending for sparkline -------- */
function buildSpendingSparkline(expenses, month) {
  const [y, m] = month.split('-').map(Number);
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === y && today.getMonth() === m - 1;
  const lastDay = isCurrentMonth ? today.getDate() : new Date(y, m, 0).getDate();

  const dailyTotals = new Array(lastDay).fill(0);
  for (const e of expenses) {
    const d = new Date(e.created_at);
    // Guard: only include expenses that belong to the target month
    if (d.getFullYear() !== y || d.getMonth() + 1 !== m) continue;
    const day = d.getDate();
    if (day >= 1 && day <= lastDay) dailyTotals[day - 1] += Number(e.amount);
  }

  const cumulative = [];
  let sum = 0;
  for (const v of dailyTotals) { sum += v; cumulative.push(sum); }
  return cumulative;
}

/* -------- Net Position header -------- */
function NetPosition({ pnl, expenses }) {
  if (!pnl) return null;

  const currentNet = pnl.current_net_pnl ?? 0;
  const forecastNet = pnl.forecasted_net_pnl ?? 0;
  const lastNet = pnl.last_net_pnl;

  const prevMonthName = pnl.prev_month
    ? new Date(`${pnl.prev_month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long' })
    : null;
  const currMonthName = new Date(`${pnl.month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long' });
  const currYear = new Date(`${pnl.month}-01T00:00:00Z`).getFullYear();

  const diff = lastNet != null ? currentNet - lastNet : 0;
  const pctChange = safePctChange(currentNet, lastNet);
  const up = diff >= 0;
  // Clarity: negative net = spending exceeds income. Avoid double-negatives in copy.
  const isDeficit = currentNet < 0;
  const isForecastDeficit = forecastNet < 0;

  const spendingSparkData = buildSpendingSparkline(expenses, pnl.month);

  const [selY, selM] = pnl.month.split('-').map(Number);
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === selY && today.getMonth() === selM - 1;
  const endDate = isCurrentMonth ? today : new Date(selY, selM, 0);
  const startDate = new Date(selY, selM - 1, 1);
  const startStr = startDate.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
  const endStr = endDate.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });

  const totalIncomeActual = pnl.total_income_actual ?? 0;
  const forecastColor = forecastNet >= 0 ? 'var(--emerald)' : 'var(--rose)';

  return (
    <div className="card card-pad-lg" style={{ marginBottom: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 40, alignItems: 'center' }} className="np-grid">

        <div className="stack" style={{ gap: 16 }}>
          <div className="row" style={{ gap: 10, textTransform: 'uppercase', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-2)' }}>
            <span>Current Net Position — {currMonthName} {currYear}</span>
            <span className="chip" style={{ background: 'var(--hover-bg-2)', color: 'var(--text-1)', textTransform: 'none', fontWeight: 600 }}>
              <Icon name="wallet" size={11} /> live
            </span>
          </div>

          <div className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
            <span style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-2)', marginTop: 8 }}>{currentNet < 0 ? '−' : ''}₪</span>
            <span style={{ fontSize: 46, fontWeight: 700, letterSpacing: -1, lineHeight: 1 }}>
              {Math.abs(currentNet).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
            </span>
          </div>

          <div style={{ padding: '12px 14px', background: isForecastDeficit ? 'rgba(244, 63, 94, 0.1)' : 'rgba(16, 185, 129, 0.1)', borderRadius: 8, borderLeft: `3px solid ${forecastColor}`, marginTop: 4 }}>
            <div className="row" style={{ gap: 8, fontSize: 13, color: 'var(--text-1)' }}>
              <Icon name="sparkles" size={14} color={forecastColor} />
              <span>
                {isDeficit
                  ? <>Spending currently exceeds income by <strong>{fmt(Math.abs(currentNet))}</strong>. </>
                  : <>Net position currently <strong>{fmt(currentNet)}</strong>. </>}
                {isForecastDeficit
                  ? <>Projected to end the month <strong style={{ color: forecastColor }}>{fmt(forecastNet)}</strong> in the red.</>
                  : <>Projected to end the month at <strong style={{ color: forecastColor }}>{fmt(forecastNet)}</strong>.</>}
              </span>
            </div>
          </div>

          {lastNet != null && prevMonthName && (
            <div className="row" style={{ gap: 12, marginTop: 4 }}>
              <span className={`chip ${pctChange.valid ? (up ? 'up' : 'down') : ''}`} style={{ fontWeight: 600 }}>
                <Icon name={pctChange.valid ? (up ? 'trending-up' : 'trending-down') : 'minus'} size={12} />
                {pctChange.label} vs last month
              </span>
              <span className="row" style={{ gap: 4, fontSize: 13, fontWeight: 500, color: 'var(--text-2)' }}>
                <Icon name={up ? 'triangle' : 'triangle-down'} size={10} style={{ fill: 'currentColor', opacity: 0.8 }} />
                {fmtSign(diff)} from {prevMonthName}
              </span>
            </div>
          )}

          <div className="row" style={{ marginTop: 8, fontSize: 13, gap: 16, color: 'var(--text-2)', flexWrap: 'wrap' }}>
            <div className="row" style={{ gap: 6 }}><span className="dot" style={{ background: 'var(--emerald)' }} /> In {fmt(totalIncomeActual)}</div>
            <div className="row" style={{ gap: 6 }}><span className="dot" style={{ background: 'var(--rose)' }} /> Out {fmt(pnl.total_expenses)}</div>
            <div className="row" style={{ gap: 6 }}><span className="dot" style={{ background: 'var(--indigo)' }} /> Save {fmt(pnl.savings_allocation)}</div>
          </div>
        </div>

        <div className="stack" style={{ gap: 16, height: '100%', justifyContent: 'space-between' }}>
          <div className="between" style={{ textTransform: 'uppercase', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-2)' }}>
            <span>Spending Trend</span>
            <span className="chip idg" style={{ textTransform: 'none', fontWeight: 600 }}>
              {fmt(pnl.total_expenses)} spent
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 60, position: 'relative' }}>
            <Sparkline data={spendingSparkData.length ? spendingSparkData : [0]} color="var(--rose)" height={70} />
          </div>
          <div className="between muted-2" style={{ fontSize: 11, fontWeight: 500 }}>
            <span>{startStr}</span>
            <span>{endStr}</span>
          </div>
        </div>

      </div>
      <style>{`@media (max-width: 760px){ .np-grid { grid-template-columns: 1fr !important; gap: 32px !important; } }`}</style>
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
                <span className="muted" style={{ fontSize: 12 }}>· {income.variable.length} sources</span>
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

/* -------- Goal modal -------- */
function GoalModal({ open, goal, onClose, onSave }) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [alloc, setAlloc] = useState('');
  useEffect(() => {
    if (open) {
      setName(goal ? goal.name : '');
      setTarget(goal ? goal.target_amount : '');
      setAlloc(goal ? goal.monthly_allocation : '');
    }
  }, [open, goal]);
  const submit = async (e) => {
    e.preventDefault();
    const t = parseFloat(target);
    if (!name.trim() || !t || t <= 0) return;
    await onSave({ goal_id: goal?.goal_id, name: name.trim(), target_amount: t, monthly_allocation: parseFloat(alloc) || 0 });
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
        <div className="between">
          <h3 className="h2" style={{ fontSize: 17 }}>
            {goal ? 'Edit savings goal' : 'New savings goal'}
          </h3>
          <button type="button" className="btn ghost icon" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className="field">
          <label>Goal name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Trip to Tokyo" />
        </div>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <div className="field">
            <label>Target amount (₪)</label>
            <input className="input mono" type="number" step="100" value={target}
              onChange={(e) => setTarget(e.target.value)} placeholder="10000" />
          </div>
          <div className="field">
            <label>Monthly allocation (₪)</label>
            <input className="input mono" type="number" step="50" value={alloc}
              onChange={(e) => setAlloc(e.target.value)} placeholder="0" />
          </div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary"><Icon name="check" size={13} /> {goal ? 'Save' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}

/* -------- Main Dashboard -------- */
export default function Dashboard() {
  const [month, setMonth] = useState(currentMonth());
  const recentMonths = useMemo(() => getRecentMonths(3), []);
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
  const [goalModalOpen, setGoalModalOpen] = useState(false);
  const [editGoal, setEditGoal] = useState(null);
  const abortControllerRef = useRef(null);

  const load = useCallback(() => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    setLoading(true);
    const [y, m] = month.split('-').map(Number);
    let py = y, pm = m - 1;
    if (pm === 0) { pm = 12; py--; }
    const prevM = `${py}-${String(pm).padStart(2, '0')}`;

    Promise.allSettled([
      api.get(`/pnl?month=${month}`, { signal }),
      api.get(`/pnl?month=${prevM}`, { signal }),
      api.get(`/budgets?month=${month}`, { signal }),
      api.get(`/expenses?month=${month}`, { signal }),
      api.get(`/income/summary?month=${month}`, { signal }),
      api.get('/subscriptions', { signal }),
      api.get('/savings', { signal }),
    ]).then(([p, prevP, b, e, inc, s, g]) => {
      if (signal.aborted) return;
      if (p.status === 'fulfilled') {
        setPnl({
          ...p.value.data,
          last_net_pnl: prevP.status === 'fulfilled' ? (prevP.value.data.current_net_pnl ?? null) : null,
          prev_month: prevM
        });
      }
      if (b.status === 'fulfilled') setBudgets(b.value.data.budgets || []);
      if (e.status === 'fulfilled') setExpenses(Array.isArray(e.value.data) ? e.value.data : []);
      if (inc.status === 'fulfilled') setIncome(inc.value.data);
      if (s.status === 'fulfilled') setSubs(Array.isArray(s.value.data) ? s.value.data : []);
      if (g.status === 'fulfilled') setGoals(Array.isArray(g.value.data) ? g.value.data : []);
    }).finally(() => { if (!signal.aborted) setLoading(false); });
  }, [month]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    window.addEventListener('smartfin:reload', load);
    return () => window.removeEventListener('smartfin:reload', load);
  }, [load]);

  const handleContribute = async (goalId, amount) => {
    try {
      await api.post(`/savings/${goalId}/deposit`, { amount });
      setToast(`Contributed ₪${amount.toLocaleString()} to goal`);
      load();
    } catch (err) {
      console.error('Contribution failed:', err);
      setToast('Failed to contribute — please try again');
    }
  };

  const handleTogglePauseSub = async (sub) => {
    try {
      await api.put(`/subscriptions/${sub.subscription_id}/pause`, { paused: !sub.paused });
      load();
    } catch (err) {
      console.error('Subscription update failed:', err);
      setToast('Failed to update subscription — please try again');
    }
  };

  const handleSaveGoal = async (data) => {
    try {
      if (data.goal_id) {
        await api.put(`/savings/${data.goal_id}`, data);
        setToast(`Updated "${data.name}"`);
      } else {
        await api.post('/savings', data);
        setToast(`Created "${data.name}"`);
      }
      load();
    } catch (err) {
      console.error('Goal save failed:', err);
      setToast('Failed to save goal — please try again');
    }
  };

  const today = new Date();
  const [selY, selM] = month.split('-').map(Number);
  const isCurrentMonth = today.getFullYear() === selY && today.getMonth() === selM - 1;
  const daysLeft = isCurrentMonth
    ? new Date(selY, selM, 0).getDate() - today.getDate()
    : null;

  if (loading) {
    return (
      <div className="view-enter" style={{ padding: '20px 0' }}>
        {/* PageHeader */}
        <Sk width="38%" height={28} style={{ marginBottom: 8 }} />
        <Sk width="55%" height={13} style={{ marginBottom: 24 }} />
        {/* Month selector */}
        <div className="row" style={{ gap: 6, marginBottom: 20 }}>
          {[1,2,3,4].map(i => <Sk key={i} width={72} height={32} radius={99} />)}
        </div>
        {/* NetPosition card */}
        <div className="card card-pad-lg" style={{ marginBottom: 20 }}>
          <Sk width="30%" height={13} style={{ marginBottom: 14 }} />
          <Sk width="50%" height={40} style={{ marginBottom: 10 }} />
          <Sk width="40%" height={12} style={{ marginBottom: 16 }} />
          <Sk height={8} radius={4} />
        </div>
        {/* Budget category grid */}
        <Sk width="35%" height={16} style={{ marginBottom: 12 }} />
        <div className="grid grid-4" style={{ marginBottom: 20 }}>
          {[1,2,3,4].map(i => (
            <div key={i} className="card card-pad">
              <Sk width={32} height={32} radius={9} style={{ marginBottom: 12 }} />
              <Sk width="60%" height={13} style={{ marginBottom: 8 }} />
              <Sk height={6} radius={3} style={{ marginBottom: 6 }} />
              <Sk width="40%" height={11} />
            </div>
          ))}
        </div>
        {/* grid-3: income / subs / savings */}
        <div className="grid grid-3" style={{ marginBottom: 20 }}>
          {[1,2,3].map(i => (
            <div key={i} className="card card-pad-lg">
              <Sk width="50%" height={13} style={{ marginBottom: 14 }} />
              <Sk width="65%" height={32} style={{ marginBottom: 10 }} />
              {[1,2,3].map(j => <Sk key={j} height={36} radius={8} style={{ marginBottom: 6 }} />)}
            </div>
          ))}
        </div>
        {/* Transactions table */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--line)' }}>
            <Sk width={200} height={18} />
          </div>
          <div style={{ padding: '12px 22px 20px' }}>
            {[1,2,3,4,5].map(i => <Sk key={i} height={40} radius={8} style={{ marginBottom: 8 }} />)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view-enter">
      <PageHeader
        title={`Good ${today.getHours() < 12 ? 'morning' : today.getHours() < 18 ? 'afternoon' : 'evening'}`}
        sub={isCurrentMonth
          ? `${today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · ${daysLeft} days left in the month`
          : new Date(selY, selM - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
      />

      <div className="seg" style={{ marginBottom: 20 }}>
        {recentMonths.map(rm => (
          <button
            key={rm.iso}
            className={month === rm.iso ? 'on' : ''}
            onClick={() => setMonth(rm.iso)}
          >
            {rm.label}
          </button>
        ))}
      </div>

      <NetPosition pnl={pnl} expenses={expenses} />

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
        <SubscriptionsMini subs={subs} onTogglePause={handleTogglePauseSub} />
        <SavingsCard
          goals={goals.slice(0, 3)}
          onContribute={(g) => { setContributeGoal(g); setContributeOpen(true); }}
          onEdit={(g) => { setEditGoal(g); setGoalModalOpen(true); }}
          onNew={() => { setEditGoal(null); setGoalModalOpen(true); }}
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
          onReload={load}
        />
      )}

      <ContributeModal
        open={contributeOpen}
        goal={contributeGoal}
        onClose={() => setContributeOpen(false)}
        onSubmit={handleContribute}
      />

      <GoalModal
        open={goalModalOpen}
        goal={editGoal}
        onClose={() => setGoalModalOpen(false)}
        onSave={handleSaveGoal}
      />

      <Toast msg={toast} onDone={() => setToast('')} />
    </div>
  );
}
