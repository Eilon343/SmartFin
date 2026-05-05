import { useEffect, useState, useCallback } from 'react';
import api from '../api/client';
import Icon from '../components/ui/Icon';
import ProgressBar, { pct, tone } from '../components/ui/ProgressBar';
import PageHeader from '../components/ui/PageHeader';
import Drawer from '../components/ui/Drawer';
import Modal from '../components/ui/Modal';
import Toast from '../components/ui/Toast';
import Sk from '../components/ui/Skeleton';

const CAT_COLORS = [
  '#f59e0b','#60a5fa','#a78bfa','#f472b6','#34d399','#fb7185',
  '#22d3ee','#94a3b8','#facc15','#818cf8','#4ade80','#f97316',
];

const CAT_ICONS_MAP = {
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
  for (const [k, v] of Object.entries(CAT_ICONS_MAP)) {
    if (key?.includes(k)) return v;
  }
  return 'tag';
}

function fmt(n) {
  return '₪' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatDate(isoOrDateStr) {
  const d = new Date(isoOrDateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function CategoryCard({ budget, color, icon, onOpen }) {
  const hasLimit = !budget.no_budget && budget.effective_limit != null;
  const p = hasLimit ? pct(budget.spent, budget.effective_limit) : 0;
  const t = tone(p);
  const colorMap = { ok: 'var(--emerald)', warn: 'var(--amber)', over: 'var(--rose)' };
  const over = hasLimit && budget.spent > budget.effective_limit;
  
  const today = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const currentDay = today.getDate();

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
          <span className="mono tnum" style={{ fontSize: 14, fontWeight: 600 }}>{fmt(budget.spent)}</span>
          {hasLimit && <span className="mono tnum muted" style={{ fontSize: 12 }}>/ {fmt(budget.effective_limit)}</span>}
        </div>
        {hasLimit && <ProgressBar value={budget.spent} max={budget.effective_limit} />}
        {hasLimit && (
          <div className="between" style={{ marginTop: 8 }}>
            <span className="meta-label" style={{ color: colorMap[t], textTransform: 'uppercase' }}>
              {over ? 'over by ' + fmt(budget.spent - budget.effective_limit) : fmt(budget.remaining) + ' left'}
            </span>
            <span className="muted" style={{ fontSize: 11, fontWeight: 500 }}>
              day {currentDay} / {daysInMonth}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function CategoryDrawer({ budget, color, icon, expenses, onClose, onBudgetSaved }) {
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
  const hasLimit = !budget.no_budget && budget.effective_limit != null;
  const p = hasLimit ? pct(budget.spent, budget.effective_limit) : 0;

  async function saveBudget(e) {
    e.preventDefault();
    const n = parseFloat(limitVal);
    if (!n || n <= 0) return;
    setSaving(true);
    try {
      await api.post('/budgets', { category_id: budget.category_id, monthly_limit: n, carry_over: carryOver });
      setEditing(false);
      onBudgetSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer open={!!budget} onClose={onClose}>
      <div className="between" style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)' }}>
        <div className="row" style={{ gap: 12 }}>
          <div className="cat-icon" style={{ color }}><Icon name={icon} size={18} /></div>
          <div className="stack">
            <span style={{ fontWeight: 700, fontSize: 16 }}>{budget.category}</span>
            <span className="muted" style={{ fontSize: 12 }}>{catExpenses.length} transactions this month</span>
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

/* -------- New category modal -------- */
function NewCategoryModal({ open, onClose, onSave }) {
  const [name, setName] = useState('');
  useEffect(() => { if (open) setName(''); }, [open]);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    await onSave(name.trim());
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
        <div className="between">
          <h3 className="h2" style={{ fontSize: 17 }}>New category</h3>
          <button type="button" className="btn ghost icon" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className="field">
          <label>Category name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Subscriptions" />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary"><Icon name="check" size={13} /> Create</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Categories() {
  const [month] = useState(currentMonth());
  const [budgets, setBudgets] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openBudget, setOpenBudget] = useState(null);
  const [newCatOpen, setNewCatOpen] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    Promise.allSettled([
      api.get(`/budgets?month=${month}`),
      api.get(`/expenses?month=${month}`),
    ]).then(([b, e]) => {
      if (b.status === 'fulfilled') setBudgets((b.value.data.budgets || []).slice().sort((a, z) => a.category.localeCompare(z.category)));
      if (e.status === 'fulfilled') setExpenses(Array.isArray(e.value.data) ? e.value.data : []);
    }).finally(() => setLoading(false));
  }, [month]);

  useEffect(() => { load(); }, [load]);

  const handleNewCategory = async (name) => {
    try {
      await api.post('/categories', { name });
      setToast(`Category "${name}" created`);
      load();
    } catch (err) {
      setToast(err.response?.data?.error || 'Failed to create category');
    }
  };

  const totalBudget = budgets.reduce((s, b) => s + (b.effective_limit ?? 0), 0);
  const totalSpent = budgets.reduce((s, b) => s + b.spent, 0);

  if (loading) return (
    <div className="view-enter">
      <Sk width="33%" height={28} style={{ marginBottom: 8 }} />
      <Sk width="60%" height={13} style={{ marginBottom: 24 }} />
      {/* Summary progress card */}
      <div className="card card-pad-lg" style={{ marginBottom: 20 }}>
        <div className="between" style={{ marginBottom: 12 }}>
          <Sk width="45%" height={11} />
          <Sk width={80} height={14} />
        </div>
        <Sk height={8} radius={4} />
      </div>
      {/* Category grid */}
      <div className="grid grid-3">
        {[1,2,3,4,5,6].map(i => (
          <div key={i} className="card card-pad">
            <div className="row" style={{ gap: 10, marginBottom: 12 }}>
              <Sk width={32} height={32} radius={9} />
              <Sk width="55%" height={14} />
            </div>
            <Sk height={6} radius={3} style={{ marginBottom: 8 }} />
            <div className="between">
              <Sk width="35%" height={11} />
              <Sk width="25%" height={11} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="view-enter">
      <PageHeader
        title="Categories"
        sub="Track spending against monthly budget envelopes"
        actions={
          <button className="btn primary" style={{ background: 'var(--emerald)' }} onClick={() => setNewCatOpen(true)}>
            <Icon name="plus" size={13} /> New category
          </button>
        }
      />

      {totalSpent > 0 && (
        <div className="card card-pad-lg" style={{ marginBottom: 20 }}>
          <div className="between" style={{ marginBottom: 12 }}>
            <span className="meta-label">All categories — {new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' })}</span>
            <span className="mono tnum" style={{ fontSize: 14 }}>
              <span style={{ fontWeight: 700 }}>{fmt(totalSpent)}</span>
              {totalBudget > 0 && <span className="muted"> / {fmt(totalBudget)}</span>}
            </span>
          </div>
          {totalBudget > 0 && <ProgressBar value={totalSpent} max={totalBudget} height={8} />}
          {totalBudget > 0 && (
            <div className="row" style={{ marginTop: 12, gap: 16, flexWrap: 'wrap' }}>
              <span className="muted" style={{ fontSize: 12 }}>
                {budgets.filter(b => b.effective_limit && b.spent > b.effective_limit).length} over budget ·&nbsp;
                {budgets.filter(b => b.effective_limit && pct(b.spent, b.effective_limit) >= 80).length} at risk
              </span>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-3">
          {budgets.map((b, i) => (
            <CategoryCard
              key={b.budget_id ?? b.category}
              budget={b}
              color={CAT_COLORS[i % CAT_COLORS.length]}
              icon={catIcon(b.category)}
              onOpen={() => setOpenBudget({ budget: b, color: CAT_COLORS[i % CAT_COLORS.length], icon: catIcon(b.category), key: b.budget_id ?? b.category })}
            />
          ))}
          <div className="card card-pad empty-card focusable" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: '1px dashed var(--line-2)', background: 'transparent', minHeight: 140 }} onClick={() => setNewCatOpen(true)}>
            <Icon name="plus" size={24} color="var(--text-3)" />
            <span className="muted" style={{ marginTop: 8, fontSize: 13 }}>New category</span>
          </div>
        </div>

      {openBudget && (
        <CategoryDrawer
          budget={openBudget.budget}
          color={openBudget.color}
          icon={openBudget.icon}
          expenses={expenses}
          onClose={() => setOpenBudget(null)}
          onBudgetSaved={() => { setToast('Budget saved'); load(); setOpenBudget(null); }}
        />
      )}

      <NewCategoryModal
        open={newCatOpen}
        onClose={() => setNewCatOpen(false)}
        onSave={handleNewCategory}
      />

      <Toast msg={toast} onDone={() => setToast('')} />
    </div>
  );
}
