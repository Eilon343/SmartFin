import { useEffect, useState, useCallback } from 'react';
import api from '../api/client';
import Icon from '../components/ui/Icon';
import Ring from '../components/ui/Ring';
import PageHeader from '../components/ui/PageHeader';
import Modal from '../components/ui/Modal';
import Toast from '../components/ui/Toast';
import { pct } from '../components/ui/ProgressBar';

const GOAL_COLORS = ['#6366f1','#10b981','#f472b6','#f59e0b','#fb7185','#22d3ee','#a78bfa','#34d399'];
const GOAL_ICONS = ['plane','shield-check','laptop','gem','home','car','graduation-cap','heart','baby','gift','camera','bike'];

function calcDue(g) {
  const remaining = g.target_amount - g.saved_amount;
  if (remaining <= 0) return 'Complete';
  if (!g.monthly_allocation || g.monthly_allocation <= 0) return 'Ongoing';
  const months = Math.ceil(remaining / g.monthly_allocation);
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

function fmt(n) {
  return '₪' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
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
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Ring value={goal.saved_amount} max={goal.target_amount} color={color} size={120} stroke={10} />
        </div>
        <div className="muted" style={{ textAlign: 'center', fontSize: 13 }}>
          {fmt(goal.saved_amount)} of {fmt(goal.target_amount)} ({goal.pct_complete}%)
        </div>
        <div className="field">
          <label>Amount to add (₪)</label>
          <input className="input mono" type="number" step="1" autoFocus value={amt}
            onChange={(e) => setAmt(e.target.value)} placeholder="500" />
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

export default function Savings() {
  const [goals, setGoals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [contributeGoal, setContributeGoal] = useState(null);
  const [contributeOpen, setContributeOpen] = useState(false);
  const [editGoal, setEditGoal] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(() => {
    api.get('/savings').then(r => setGoals(r.data)).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalSaved = goals.reduce((s, g) => s + g.saved_amount, 0);
  const totalTarget = goals.reduce((s, g) => s + g.target_amount, 0);

  const handleContribute = async (goalId, amount) => {
    await api.post(`/savings/${goalId}/deposit`, { amount });
    setToast(`Contributed ₪${amount.toLocaleString()} to goal`);
    load();
  };

  const handleSaveGoal = async (data) => {
    if (data.goal_id) {
      await api.put(`/savings/${data.goal_id}`, data);
      setToast(`Updated "${data.name}"`);
    } else {
      await api.post('/savings', data);
      setToast(`Created "${data.name}"`);
    }
    load();
  };

  const handleDelete = async (goalId, name) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    await api.delete(`/savings/${goalId}`);
    setToast(`Deleted "${name}"`);
    load();
  };

  return (
    <div className="view-enter">
      <PageHeader
        title="Savings"
        sub="Goals and virtual envelopes"
        actions={
          <button className="btn primary" onClick={() => { setEditGoal(null); setNewOpen(true); }}>
            <Icon name="plus" size={13} /> New goal
          </button>
        }
      />

      {totalTarget > 0 && (
        <div className="card card-pad-lg" style={{ marginBottom: 16, display: 'flex', gap: 20, alignItems: 'center' }}>
          <Ring value={totalSaved} max={totalTarget} color="var(--emerald)" size={120} stroke={11}
                label={`${Math.round(pct(totalSaved, totalTarget))}%`} />
          <div className="stack" style={{ gap: 6 }}>
            <span className="meta-label">Total progress</span>
            <div className="big-num" style={{ fontSize: 38, lineHeight: 1 }}>
              <span className="ccy" style={{ fontSize: 20 }}>₪</span>{totalSaved.toLocaleString()}
            </div>
            <span className="muted" style={{ fontSize: 12 }}>of {fmt(totalTarget)}</span>
            {(() => {
              const totalAlloc = goals.reduce((s, g) => s + (g.monthly_allocation || 0), 0);
              if (totalAlloc <= 0) return null;
              return (
                <span className="chip up" style={{ marginTop: 2 }}>
                  <Icon name="trending-up" size={11} /> +{fmt(totalAlloc)} this month
                </span>
              );
            })()}
          </div>
        </div>
      )}

      {loading ? (
        <div className="stack" style={{ gap: 10 }}>
          {[1, 2, 3].map(i => (
            <div key={i} className="card card-pad-lg" style={{ height: 110, background: 'var(--hover-bg)', animation: 'pulse 1.5s ease infinite' }} />
          ))}
        </div>
      ) : goals.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 0' }}>
          <Icon name="piggy-bank" size={32} color="var(--text-3)" />
          <div className="muted" style={{ marginTop: 12, fontSize: 13 }}>No savings goals yet. Create your first one!</div>
          <button className="btn primary" style={{ marginTop: 16 }} onClick={() => { setEditGoal(null); setNewOpen(true); }}>
            <Icon name="plus" size={13} /> New goal
          </button>
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {goals.map((g, i) => {
            const color = GOAL_COLORS[i % GOAL_COLORS.length];
            const icon = GOAL_ICONS[i % GOAL_ICONS.length];
            const p = pct(g.saved_amount, g.target_amount);
            return (
              <div key={g.goal_id} className="card card-pad-lg">
                <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                  <Ring value={g.saved_amount} max={g.target_amount} color={color} size={76} stroke={7}
                        label={`${Math.round(p)}%`} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="between" style={{ marginBottom: 6 }}>
                      <div className="row" style={{ gap: 7, minWidth: 0 }}>
                        <Icon name={icon} size={14} color={color} />
                        <span style={{ fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {g.name}
                        </span>
                      </div>
                      <button
                        style={{ width: 32, height: 32, borderRadius: 10, background: color + '28', color, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                        onClick={() => { setContributeGoal(g); setContributeOpen(true); }}
                      >
                        <Icon name="plus" size={16} />
                      </button>
                    </div>
                    <div className="row" style={{ gap: 4, marginBottom: 6 }}>
                      <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{fmt(g.saved_amount)}</span>
                      <span className="muted" style={{ fontSize: 12 }}>/ {fmt(g.target_amount)}</span>
                    </div>
                    <div className="pb-track" style={{ height: 4, marginBottom: 5 }}>
                      <div className="pb-fill" style={{ width: Math.min(100, p) + '%', background: color }} />
                    </div>
                    <div className="between">
                      <span className="muted-2" style={{ fontSize: 11 }}>due {calcDue(g)}</span>
                      <div className="row" style={{ gap: 2 }}>
                        <button className="btn ghost icon" style={{ width: 24, height: 24, color: 'var(--text-2)' }}
                                onClick={() => { setEditGoal(g); setNewOpen(true); }}>
                          <Icon name="edit-2" size={11} />
                        </button>
                        <button className="btn ghost icon" style={{ width: 24, height: 24, color: 'var(--rose)' }}
                                onClick={() => handleDelete(g.goal_id, g.name)}>
                          <Icon name="trash-2" size={11} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <button
            className="btn ghost"
            style={{ width: '100%', height: 52, borderRadius: 14, border: '1.5px dashed var(--border)', color: 'var(--text-3)', fontSize: 13, gap: 8 }}
            onClick={() => { setEditGoal(null); setNewOpen(true); }}
          >
            <Icon name="plus" size={15} /> New savings goal
          </button>
        </div>
      )}

      <ContributeModal
        open={contributeOpen}
        goal={contributeGoal}
        onClose={() => setContributeOpen(false)}
        onSubmit={handleContribute}
      />
      <GoalModal open={newOpen} goal={editGoal} onClose={() => setNewOpen(false)} onSave={handleSaveGoal} />
      <Toast msg={toast} onDone={() => setToast('')} />
    </div>
  );
}
