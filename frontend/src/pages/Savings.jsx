import { useEffect, useState, useCallback } from 'react';
import { useI18n } from '../context/I18nContext';
import api from '../api/client';
import Icon from '../components/ui/Icon';
import Ring from '../components/ui/Ring';
import PageHeader from '../components/ui/PageHeader';
import Modal from '../components/ui/Modal';
import Toast from '../components/ui/Toast';
import { pct } from '../components/ui/ProgressBar';
import Sk from '../components/ui/Skeleton';

const GOAL_COLORS = ['#6366f1','#10b981','#f472b6','#f59e0b','#fb7185','#22d3ee','#a78bfa','#34d399'];
const GOAL_ICONS  = ['plane','shield-check','laptop','gem','home','car','graduation-cap','heart','baby','gift','camera','bike'];
const INV_ICONS   = ['line-chart','trending-up','bar-chart-2','briefcase','globe','zap','layers','database'];
const INV_COLOR   = '#22d3ee';

function calcDue(g, t, lang) {
  const remaining = (g.target_amount || 0) - g.saved_amount;
  if (remaining <= 0) return t('sav_complete');
  if (!g.monthly_allocation || g.monthly_allocation <= 0) return t('dash_ongoing');
  const months = Math.ceil(remaining / g.monthly_allocation);
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US', { month: 'short', year: 'numeric' });
}

function fmt(n) {
  return `‎₪${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}‎`;
}

/* -------- Contribute modal -------- */
function ContributeModal({ open, goal, onClose, onSubmit, t }) {
  const [amt, setAmt] = useState('');
  useEffect(() => { if (open) setAmt(''); }, [open]);
  if (!goal) return null;
  const isOngoing = goal.is_ongoing;
  const color = isOngoing ? INV_COLOR : GOAL_COLORS[0];
  return (
    <Modal open={open} onClose={onClose}>
      <form
        onSubmit={(e) => { e.preventDefault(); const n = parseFloat(amt); if (n > 0) { onSubmit(goal.goal_id, n); onClose(); } }}
        className="stack"
        style={{ gap: 14 }}
      >
        <div className="between">
          <div className="row" style={{ gap: 10 }}>
            <Icon name={isOngoing ? 'line-chart' : 'piggy-bank'} size={18} color={color} />
            <h3 className="h2" style={{ fontSize: 17 }}>
              {isOngoing ? t('sav_deposit') : t('dash_contribute')} — {goal.name}
            </h3>
          </div>
          <button type="button" className="btn ghost icon" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>

        {isOngoing ? (
          <div style={{
            background: INV_COLOR + '12', border: `1px solid ${INV_COLOR}30`,
            borderRadius: 14, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14,
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12,
              background: INV_COLOR + '20', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <Icon name="trending-up" size={20} color={INV_COLOR} />
            </div>
            <div className="stack" style={{ gap: 3 }}>
              <span className="meta-label">{t('sav_accumulated')}</span>
              <span className="mono" style={{ fontWeight: 700, fontSize: 22, color: INV_COLOR }} dir="ltr">
                {fmt(goal.saved_amount)}
              </span>
              {goal.monthly_allocation > 0 && (
                <span style={{ fontSize: 12, color: 'var(--text-2)' }} dir="ltr">
                  {fmt(goal.monthly_allocation)}/{t('sav_this_mo')}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Ring value={goal.saved_amount} max={goal.target_amount} color={color} size={120} stroke={10} />
          </div>
        )}

        {!isOngoing && (
          <div className="muted" style={{ textAlign: 'center', fontSize: 13 }} dir="ltr">
            {fmt(goal.saved_amount)} / {fmt(goal.target_amount)} ({goal.pct_complete}%)
          </div>
        )}

        <div className="field">
          <label>{t('dash_amt_add')}</label>
          <input className="input mono" type="number" step="1" autoFocus value={amt}
            onChange={(e) => setAmt(e.target.value)} placeholder="500" />
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} dir="ltr">
          {[100, 250, 500, 1000].map(v => (
            <button type="button" key={v} className="btn ghost" style={{ height: 30, fontSize: 12 }} onClick={() => setAmt(String(v))}>
              +₪{v}
            </button>
          ))}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>{t('common_cancel')}</button>
          <button type="submit" className="btn primary">
            <Icon name="plus" size={13} />
            {isOngoing ? t('sav_deposit') : t('dash_add_goal')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* -------- Goal / Investment modal -------- */
function GoalModal({ open, goal, onClose, onSave, t }) {
  const [isOngoing, setIsOngoing] = useState(false);
  const [name, setName]   = useState('');
  const [target, setTarget] = useState('');
  const [alloc, setAlloc]   = useState('');

  useEffect(() => {
    if (open) {
      const ongoing = goal ? Boolean(goal.is_ongoing) : false;
      setIsOngoing(ongoing);
      setName(goal ? goal.name : '');
      setTarget(goal && !goal.is_ongoing ? String(goal.target_amount ?? '') : '');
      setAlloc(goal ? String(goal.monthly_allocation ?? '') : '');
    }
  }, [open, goal]);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (!isOngoing && (!parseFloat(target) || parseFloat(target) <= 0)) return;
    await onSave({
      goal_id: goal?.goal_id,
      name: name.trim(),
      target_amount: isOngoing ? null : parseFloat(target),
      monthly_allocation: parseFloat(alloc) || 0,
      is_ongoing: isOngoing,
    });
    onClose();
  };

  const accentColor = isOngoing ? INV_COLOR : 'var(--emerald)';

  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 16 }}>
        <div className="between">
          <h3 className="h2" style={{ fontSize: 17 }}>
            {goal ? t('dash_edit_goal') : t('sav_new')}
          </h3>
          <button type="button" className="btn ghost icon" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>

        {/* Segmented type toggle */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
          padding: 4, background: 'var(--input-bg)',
          border: '1px solid var(--line-2)', borderRadius: 12,
        }}>
          {[
            { ongoing: false, label: t('sav_type_goal'), sub: 'יעד מוגדר', icon: 'target' },
            { ongoing: true,  label: t('sav_type_inv'),  sub: 'השקעה שוטפת', icon: 'line-chart' },
          ].map(opt => {
            const active = isOngoing === opt.ongoing;
            const tone   = opt.ongoing ? INV_COLOR : 'var(--emerald)';
            return (
              <button
                key={String(opt.ongoing)}
                type="button"
                onClick={() => setIsOngoing(opt.ongoing)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                  padding: '10px 8px', borderRadius: 9, border: 'none', cursor: 'pointer',
                  background: active ? 'var(--card)' : 'transparent',
                  boxShadow: active ? 'var(--shadow-card)' : 'none',
                  transition: 'background .15s',
                  borderBottom: active ? `2.5px solid ${tone}` : '2.5px solid transparent',
                }}
              >
                <Icon name={opt.icon} size={16} color={active ? tone : 'var(--text-3)'} />
                <span style={{ fontSize: 12.5, fontWeight: 600, color: active ? 'var(--text-0)' : 'var(--text-2)' }}>
                  {opt.label}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{opt.sub}</span>
              </button>
            );
          })}
        </div>

        <div className="field">
          <label>{t('dash_goal_name')}</label>
          <input
            className="input" autoFocus value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isOngoing ? 'e.g. S&P 500 — IBKR' : t('dash_goal_eg')}
            style={{ borderColor: name ? accentColor : undefined }}
          />
        </div>

        {!isOngoing && (
          <div className="field">
            <label>{t('dash_target_amt')}</label>
            <input className="input mono" type="number" step="100" value={target}
              onChange={(e) => setTarget(e.target.value)} placeholder="10000" />
          </div>
        )}

        <div className="field">
          <label>{isOngoing ? t('sav_monthly_dep') : t('dash_mo_alloc')}</label>
          <input className="input mono" type="number" step="50" value={alloc}
            onChange={(e) => setAlloc(e.target.value)}
            placeholder={isOngoing ? '500' : '0'} />
          {isOngoing && (
            <span style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              No target amount — deposits accumulate indefinitely
            </span>
          )}
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>{t('common_cancel')}</button>
          <button
            type="submit" className="btn primary"
            style={{ background: isOngoing ? INV_COLOR : undefined }}
          >
            <Icon name="check" size={13} />
            {goal ? t('common_save') : (isOngoing ? 'Start investing' : t('common_create'))}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* -------- Investment card -------- */
function InvestmentCard({ g, idx, t, lang, onContribute, onEdit, onDelete, historyOpen, historyLoading, history, onToggleHistory }) {
  const color = GOAL_COLORS[(idx) % GOAL_COLORS.length] || INV_COLOR;
  const icon  = INV_ICONS[idx % INV_ICONS.length];
  return (
    <div className="card card-pad-lg">
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* Icon tile */}
        <div style={{
          width: 52, height: 52, borderRadius: 14, flexShrink: 0,
          background: INV_COLOR + '18', border: `1px solid ${INV_COLOR}30`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon name={icon} size={22} color={INV_COLOR} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="between" style={{ marginBottom: 8 }}>
            <div className="row" style={{ gap: 7, minWidth: 0 }}>
              <span style={{ fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {g.name}
              </span>
              {/* Ongoing chip */}
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                height: 20, padding: '0 7px', borderRadius: 999,
                background: INV_COLOR + '18', color: INV_COLOR,
                fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
                flexShrink: 0,
              }}>
                <Icon name="infinity" size={9} /> ongoing
              </span>
            </div>
            <button
              style={{ width: 32, height: 32, borderRadius: 10, background: INV_COLOR + '20', color: INV_COLOR, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              onClick={() => onContribute(g)}
            >
              <Icon name="plus" size={16} />
            </button>
          </div>

          {/* Accumulated amount */}
          <div style={{ marginBottom: 6 }}>
            <span className="meta-label" style={{ display: 'block', marginBottom: 3 }}>{t('sav_accumulated')}</span>
            <div className="mono" style={{ fontWeight: 700, fontSize: 22, color: INV_COLOR, letterSpacing: '-0.02em' }} dir="ltr">
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', marginRight: 2 }}>₪</span>
              {g.saved_amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </div>
          </div>

          {/* Stats row */}
          <div className="between">
            <div className="row" style={{ gap: 10 }}>
              {g.monthly_allocation > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-2)' }} dir="ltr">
                  <Icon name="repeat" size={11} color="var(--text-3)" />
                  {fmt(g.monthly_allocation)}/{t('sav_this_mo')}
                </span>
              )}
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                height: 20, padding: '0 7px', borderRadius: 999,
                background: 'var(--emerald-soft)', color: 'var(--emerald)',
                fontSize: 10, fontWeight: 600,
              }}>
                <Icon name="trending-up" size={10} /> growing
              </span>
            </div>
            <div className="row" style={{ gap: 2 }}>
              <button className="btn ghost icon" style={{ width: 24, height: 24, color: 'var(--text-2)' }}
                      title={historyOpen ? t('sav_hide_history') : t('sav_history')}
                      onClick={() => onToggleHistory(g.goal_id)}>
                <Icon name={historyOpen ? 'chevron-up' : 'history'} size={11} />
              </button>
              <button className="btn ghost icon" style={{ width: 24, height: 24, color: 'var(--text-2)' }}
                      onClick={() => onEdit(g)}>
                <Icon name="edit-2" size={11} />
              </button>
              <button className="btn ghost icon" style={{ width: 24, height: 24, color: 'var(--rose)' }}
                      onClick={() => onDelete(g.goal_id, g.name)}>
                <Icon name="trash-2" size={11} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {historyOpen && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
          {historyLoading ? (
            <div className="stack" style={{ gap: 6 }}><Sk height={14} /><Sk height={14} width="80%" /></div>
          ) : (history?.length ? (
            <div className="stack" style={{ gap: 6 }}>
              {history.map(h => (
                <div key={h.expense_id} className="between" style={{ fontSize: 12 }}>
                  <span className="muted">
                    {new Date(h.created_at).toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-US', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </span>
                  <span className="mono" style={{ fontWeight: 600, color: INV_COLOR }} dir="ltr">+{fmt(h.amount)}</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="muted-2" style={{ fontSize: 12 }}>{t('sav_no_history')}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------- Target goal card -------- */
function GoalCard({ g, idx, t, lang, onContribute, onEdit, onDelete, historyOpen, historyLoading, history, onToggleHistory }) {
  const color = GOAL_COLORS[idx % GOAL_COLORS.length];
  const icon  = GOAL_ICONS[idx % GOAL_ICONS.length];
  const p     = pct(g.saved_amount, g.target_amount || 1);
  return (
    <div className="card card-pad-lg">
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <Ring value={g.saved_amount} max={g.target_amount || 1} color={color} size={76} stroke={7}
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
              onClick={() => onContribute(g)}
            >
              <Icon name="plus" size={16} />
            </button>
          </div>
          <div className="row" style={{ gap: 4, marginBottom: 6 }} dir="ltr">
            <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{fmt(g.saved_amount)}</span>
            <span className="muted" style={{ fontSize: 12 }}>/ {fmt(g.target_amount)}</span>
          </div>
          <div className="pb-track" style={{ height: 4, marginBottom: 5 }}>
            <div className="pb-fill" style={{ width: Math.min(100, p) + '%', background: color }} />
          </div>
          <div className="between">
            <span className="muted-2" style={{ fontSize: 11 }}>{t('sav_due')} {calcDue(g, t, lang)}</span>
            <div className="row" style={{ gap: 2 }}>
              <button className="btn ghost icon" style={{ width: 24, height: 24, color: 'var(--text-2)' }}
                      title={historyOpen ? t('sav_hide_history') : t('sav_history')}
                      onClick={() => onToggleHistory(g.goal_id)}>
                <Icon name={historyOpen ? 'chevron-up' : 'history'} size={11} />
              </button>
              <button className="btn ghost icon" style={{ width: 24, height: 24, color: 'var(--text-2)' }}
                      onClick={() => onEdit(g)}>
                <Icon name="edit-2" size={11} />
              </button>
              <button className="btn ghost icon" style={{ width: 24, height: 24, color: 'var(--rose)' }}
                      onClick={() => onDelete(g.goal_id, g.name)}>
                <Icon name="trash-2" size={11} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {historyOpen && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
          {historyLoading ? (
            <div className="stack" style={{ gap: 6 }}><Sk height={14} /><Sk height={14} width="80%" /></div>
          ) : (history?.length ? (
            <div className="stack" style={{ gap: 6 }}>
              {history.map(h => (
                <div key={h.expense_id} className="between" style={{ fontSize: 12 }}>
                  <span className="muted">
                    {new Date(h.created_at).toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-US', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </span>
                  <span className="mono" style={{ fontWeight: 600, color }} dir="ltr">+{fmt(h.amount)}</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="muted-2" style={{ fontSize: 12 }}>{t('sav_no_history')}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------- Main page -------- */
export default function Savings() {
  const { lang, t } = useI18n();
  const [goals, setGoals]               = useState([]);
  const [loading, setLoading]           = useState(true);
  const [contributeGoal, setContributeGoal] = useState(null);
  const [contributeOpen, setContributeOpen] = useState(false);
  const [editGoal, setEditGoal]         = useState(null);
  const [newOpen, setNewOpen]           = useState(false);
  const [toast, setToast]               = useState('');
  const [historyOpen, setHistoryOpen]   = useState({});
  const [history, setHistory]           = useState({});
  const [historyLoading, setHistoryLoading] = useState({});

  const toggleHistory = (goalId) => {
    setHistoryOpen(prev => {
      const next = { ...prev, [goalId]: !prev[goalId] };
      if (next[goalId] && history[goalId] === undefined) {
        setHistoryLoading(l => ({ ...l, [goalId]: true }));
        api.get(`/savings/${goalId}/history`)
          .then(r => setHistory(h => ({ ...h, [goalId]: r.data })))
          .catch(() => setHistory(h => ({ ...h, [goalId]: [] })))
          .finally(() => setHistoryLoading(l => ({ ...l, [goalId]: false })));
      }
      return next;
    });
  };

  const load = useCallback(() => {
    api.get('/savings').then(r => setGoals(r.data)).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const targetGoals = goals.filter(g => !g.is_ongoing);
  const ongoingInvs = goals.filter(g =>  g.is_ongoing);

  const totalSaved   = targetGoals.reduce((s, g) => s + g.saved_amount, 0);
  const totalTarget  = targetGoals.reduce((s, g) => s + (g.target_amount || 0), 0);
  const totalInvested = ongoingInvs.reduce((s, g) => s + g.saved_amount, 0);
  const monthlyInv    = ongoingInvs.reduce((s, g) => s + g.monthly_allocation, 0);

  const handleContribute = async (goalId, amount) => {
    await api.post(`/savings/${goalId}/deposit`, { amount });
    const g = goals.find(x => x.goal_id === goalId);
    setToast(`${g?.is_ongoing ? t('sav_deposit') : t('sav_toast_contrib')} ₪${amount.toLocaleString()} ${t('sav_toast_to')}`);
    setHistory(h => { const n = { ...h }; delete n[goalId]; return n; });
    if (historyOpen[goalId]) {
      setHistoryLoading(l => ({ ...l, [goalId]: true }));
      api.get(`/savings/${goalId}/history`)
        .then(r => setHistory(h => ({ ...h, [goalId]: r.data })))
        .finally(() => setHistoryLoading(l => ({ ...l, [goalId]: false })));
    }
    load();
  };

  const handleSaveGoal = async (data) => {
    if (data.goal_id) {
      await api.put(`/savings/${data.goal_id}`, data);
      setToast(`${t('sav_toast_upd')} "${data.name}"`);
    } else {
      await api.post('/savings', data);
      setToast(`${t('sav_toast_cre')} "${data.name}"`);
    }
    load();
  };

  const handleDelete = async (goalId, name) => {
    if (!confirm(t('sav_del_confirm'))) return;
    await api.delete(`/savings/${goalId}`);
    setToast(`${t('sav_toast_del')} "${name}"`);
    load();
  };

  const openContribute = (g) => { setContributeGoal(g); setContributeOpen(true); };
  const openEdit = (g) => { setEditGoal(g); setNewOpen(true); };

  if (loading) return (
    <div className="view-enter">
      <Sk width="40%" height={28} style={{ marginBottom: 8 }} />
      <Sk width="55%" height={13} style={{ marginBottom: 24 }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div className="card card-pad-lg" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <Sk width={100} height={100} radius={50} />
          <div className="stack" style={{ gap: 8, flex: 1 }}>
            <Sk width="40%" height={11} />
            <Sk width="60%" height={32} />
            <Sk width="35%" height={12} />
          </div>
        </div>
        <div className="card card-pad-lg">
          <Sk width="50%" height={11} style={{ marginBottom: 10 }} />
          <Sk width="70%" height={32} style={{ marginBottom: 6 }} />
          <Sk width="40%" height={12} />
        </div>
      </div>
      <div className="stack" style={{ gap: 10 }}>
        {[1,2,3].map(i => (
          <div key={i} className="card card-pad-lg" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Sk width={76} height={76} radius={38} />
            <div style={{ flex: 1 }}>
              <Sk width="50%" height={15} style={{ marginBottom: 10 }} />
              <Sk height={6} radius={3} style={{ marginBottom: 8 }} />
              <Sk width="40%" height={12} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const bothTypes = targetGoals.length > 0 && ongoingInvs.length > 0;

  return (
    <div className="view-enter">
      <PageHeader
        title={t('sav_title')}
        sub={t('sav_sub')}
        actions={
          <button className="btn primary" onClick={() => { setEditGoal(null); setNewOpen(true); }}>
            <Icon name="plus" size={13} /> {t('sav_new')}
          </button>
        }
      />

      {/* Hero cards */}
      {goals.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: bothTypes ? '1fr 1fr' : '1fr',
          gap: 12,
          marginBottom: 16,
        }}
        className="sav-hero-grid"
        >
          {/* Target goals hero */}
          {targetGoals.length > 0 && (
            <div className="card card-pad-lg" style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
              <Ring
                value={totalSaved} max={totalTarget || 1}
                color="var(--emerald)" size={bothTypes ? 84 : 120} stroke={bothTypes ? 8 : 11}
                label={`${Math.round(pct(totalSaved, totalTarget || 1))}%`}
              />
              <div className="stack" style={{ gap: 6 }}>
                <span className="meta-label">{t('sav_goals_hero_sub')}</span>
                <div className="big-num" style={{ fontSize: bothTypes ? 28 : 38, lineHeight: 1 }} dir="ltr">
                  <span className="ccy" style={{ fontSize: bothTypes ? 16 : 20 }}>₪</span>
                  {totalSaved.toLocaleString()}
                </div>
                <span className="muted" style={{ fontSize: 12 }}>{t('sav_of')} {fmt(totalTarget)}</span>
                {(() => {
                  const totalAlloc = targetGoals.reduce((s, g) => s + (g.monthly_allocation || 0), 0);
                  if (totalAlloc <= 0) return null;
                  return (
                    <span className="chip up" style={{ marginTop: 2 }} dir="ltr">
                      <Icon name="trending-up" size={11} /> +{fmt(totalAlloc)} {t('sav_this_mo')}
                    </span>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Ongoing investments hero */}
          {ongoingInvs.length > 0 && (
            <div className="card card-pad-lg" style={{
              background: `linear-gradient(135deg, ${INV_COLOR}08 0%, var(--card) 60%)`,
              borderColor: `${INV_COLOR}30`,
            }}>
              <div className="row" style={{ gap: 10, marginBottom: 12 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 9,
                  background: INV_COLOR + '20', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Icon name="line-chart" size={16} color={INV_COLOR} />
                </div>
                <span className="meta-label">{t('sav_inv_hero_sub')}</span>
              </div>
              <div className="big-num" style={{ fontSize: 36, lineHeight: 1, color: INV_COLOR }} dir="ltr">
                <span style={{ fontSize: 18, fontWeight: 600, color: INV_COLOR + 'aa', marginRight: 3 }}>₪</span>
                {totalInvested.toLocaleString()}
              </div>
              <div className="stack" style={{ gap: 6, marginTop: 10 }}>
                {monthlyInv > 0 && (
                  <div className="row" style={{ gap: 6 }} dir="ltr">
                    <Icon name="repeat" size={12} color="var(--text-3)" />
                    <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                      {fmt(monthlyInv)}/{t('sav_this_mo')}
                    </span>
                  </div>
                )}
                <div className="row" style={{ gap: 6 }}>
                  <span className="chip up" dir="ltr">
                    <Icon name="trending-up" size={11} /> {ongoingInvs.length} {t('sav_section_inv').toLowerCase()}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {goals.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 0' }}>
          <Icon name="piggy-bank" size={32} color="var(--text-3)" />
          <div className="muted" style={{ marginTop: 12, fontSize: 13 }}>{t('sav_no_goals')}</div>
          <button className="btn primary" style={{ marginTop: 16 }} onClick={() => { setEditGoal(null); setNewOpen(true); }}>
            <Icon name="plus" size={13} /> {t('sav_new')}
          </button>
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>

          {/* Target goals section */}
          {targetGoals.length > 0 && (
            <>
              {bothTypes && (
                <span className="meta-label" style={{ display: 'block', marginBottom: 2, marginTop: 4 }}>
                  <Icon name="target" size={11} /> {t('sav_section_goals')}
                </span>
              )}
              {targetGoals.map((g, i) => (
                <GoalCard
                  key={g.goal_id}
                  g={g} idx={i} t={t} lang={lang}
                  onContribute={openContribute}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                  historyOpen={historyOpen[g.goal_id]}
                  historyLoading={historyLoading[g.goal_id]}
                  history={history[g.goal_id]}
                  onToggleHistory={toggleHistory}
                />
              ))}
            </>
          )}

          {/* Ongoing investments section */}
          {ongoingInvs.length > 0 && (
            <>
              <span className="meta-label" style={{ display: 'block', marginBottom: 2, marginTop: bothTypes ? 10 : 4 }}>
                <Icon name="line-chart" size={11} /> {t('sav_section_inv')}
              </span>
              {ongoingInvs.map((g, i) => (
                <InvestmentCard
                  key={g.goal_id}
                  g={g} idx={i} t={t} lang={lang}
                  onContribute={openContribute}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                  historyOpen={historyOpen[g.goal_id]}
                  historyLoading={historyLoading[g.goal_id]}
                  history={history[g.goal_id]}
                  onToggleHistory={toggleHistory}
                />
              ))}
            </>
          )}

          <button
            className="btn ghost"
            style={{ width: '100%', height: 52, borderRadius: 14, border: '1.5px dashed var(--line-2)', color: 'var(--text-3)', fontSize: 13, gap: 8 }}
            onClick={() => { setEditGoal(null); setNewOpen(true); }}
          >
            <Icon name="plus" size={15} /> {t('sav_new')}
          </button>
        </div>
      )}

      <ContributeModal
        open={contributeOpen}
        goal={contributeGoal}
        onClose={() => setContributeOpen(false)}
        onSubmit={handleContribute}
        t={t}
      />
      <GoalModal
        open={newOpen}
        goal={editGoal}
        onClose={() => setNewOpen(false)}
        onSave={handleSaveGoal}
        t={t}
      />
      <Toast msg={toast} onDone={() => setToast('')} />
    </div>
  );
}
