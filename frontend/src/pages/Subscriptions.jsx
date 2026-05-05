import { useEffect, useState, useCallback } from 'react';
import api from '../api/client';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader';
import Modal from '../components/ui/Modal';

function fmt(n, dp = 0) {
  return '₪' + n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function ordinal(d) {
  const s = ['th', 'st', 'nd', 'rd'], v = d % 100;
  return d + (s[(v - 20) % 10] || s[v] || s[0]);
}

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

const EMPTY_FORM = { name: '', amount: '', currency: 'ILS', category_id: '', day_of_month: '1' };

export default function Subscriptions() {
  const [subs, setSubs] = useState([]);
  const [cats, setCats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null); // subscription object or null
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    setLoading(true);
    api.get('/subscriptions').then(r => setSubs(r.data)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
    api.get('/categories').then(r => setCats(r.data));
  }, [reload]);

  function openAdd() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setError('');
    setModalOpen(true);
  }

  function openEdit(s) {
    setEditing(s);
    setForm({
      name: s.name,
      amount: String(s.amount),
      currency: s.currency || 'ILS',
      category_id: s.category_id ? String(s.category_id) : '',
      day_of_month: String(s.day_of_month),
    });
    setError('');
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setError('');
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    const payload = {
      name: form.name.trim(),
      amount: parseFloat(form.amount),
      currency: form.currency,
      category_id: form.category_id ? parseInt(form.category_id, 10) : null,
      day_of_month: parseInt(form.day_of_month, 10),
    };
    if (!payload.name || isNaN(payload.amount) || isNaN(payload.day_of_month)) {
      setError('Name, amount and billing day are required.');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/subscriptions/${editing.subscription_id}`, payload);
      } else {
        await api.post('/subscriptions', payload);
      }
      closeModal();
      reload();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTogglePause(s) {
    try {
      await api.put(`/subscriptions/${s.subscription_id}/pause`, { paused: !s.paused });
      reload();
    } catch (err) {
      setError('Failed to toggle pause state.');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.delete(`/subscriptions/${deleteTarget.subscription_id}`);
      setDeleteTarget(null);
      reload();
    } catch {
      // ignore
    } finally {
      setDeleting(false);
    }
  }

  const activeSubs = subs.filter(s => !s.paused);
  const monthlyTotal = activeSubs.reduce((s, x) => s + x.amount, 0);
  const annualized = monthlyTotal * 12;
  const sorted = [...subs].sort((a, b) => a.day_of_month - b.day_of_month);

  const now = new Date();
  const today = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthName = now.toLocaleString('en-US', { month: 'long' });

  const dayMap = {};
  for (const s of activeSubs) {
    dayMap[s.day_of_month] = (dayMap[s.day_of_month] || 0) + s.amount;
  }
  const maxAmt = Math.max(...Object.values(dayMap), 1);

  return (
    <div className="view-enter">
      <PageHeader title="Subscriptions" sub="Recurring charges across all sources" />

      <div className="grid grid-2" style={{ marginBottom: 20 }}>
        <div className="card card-pad-lg">
          <span className="meta-label">Monthly burn</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }}>
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>{monthlyTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>{activeSubs.length} active</span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">Annualized</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }}>
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>{annualized.toFixed(0)}
          </div>
          <span className="chip idg" style={{ marginTop: 6 }}>
            <Icon name="repeat" size={11} /> projected
          </span>
        </div>
      </div>

      <div className="card card-pad-lg" style={{ marginBottom: 20 }}>
        <div className="between" style={{ marginBottom: 14 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{monthName} timeline</span>
          <span className="muted-2" style={{ fontSize: 12 }}>day {today} / {daysInMonth}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 52 }}>
          {Array.from({ length: daysInMonth }, (_, i) => {
            const day = i + 1;
            const amt = dayMap[day] || 0;
            const isPast = day <= today;
            const hasSub = amt > 0;
            const barH = hasSub ? Math.max(14, Math.round((amt / maxAmt) * 44)) : 0;
            const color = isPast ? 'var(--emerald)' : 'var(--indigo)';
            return (
              <div key={day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                {hasSub
                  ? <div style={{ width: '100%', maxWidth: 7, minWidth: 3, height: barH, borderRadius: 3, background: color }} />
                  : <div style={{ width: 3, height: 3, borderRadius: '50%', background: day === today ? 'var(--emerald)' : 'var(--border)' }} />
                }
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          <span className="muted-2" style={{ fontSize: 10 }}>1</span>
          <span className="muted-2" style={{ fontSize: 10 }}>10</span>
          <span className="muted-2" style={{ fontSize: 10 }}>20</span>
          <span className="muted-2" style={{ fontSize: 10 }}>{daysInMonth}</span>
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="between" style={{ padding: '18px 22px' }}>
          <h3 className="h2">All subscriptions</h3>
          <button className="btn primary" onClick={openAdd}>
            <Icon name="plus" size={14} /> Add
          </button>
        </div>
        {loading ? (
          <div style={{ padding: '24px 22px' }}>
            {[1, 2, 3, 4].map(i => (
              <div key={i} style={{ height: 56, background: 'var(--hover-bg)', borderRadius: 8, marginBottom: 8, animation: 'pulse 1.5s ease infinite' }} />
            ))}
            <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }`}</style>
          </div>
        ) : sorted.length === 0 ? (
          <div style={{ padding: '24px 22px', color: 'var(--text-3)', fontSize: 13 }}>
            No subscriptions yet. Click Add to create one.
          </div>
        ) : (
          <div style={{ padding: '0 22px 14px' }}>
            {sorted.map(s => (
              <div key={s.subscription_id} className="sub-row">
                <div style={{
                  width: 36, height: 36, borderRadius: 9,
                  background: 'var(--hover-bg-2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--text-1)', flexShrink: 0,
                }}>
                  <Icon name={subIcon(s.name)} size={16} />
                </div>
                <div className="stack" style={{ flex: 1, minWidth: 0, opacity: s.paused ? 0.6 : 1 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span style={{ fontWeight: 500, fontSize: 13.5 }}>{s.name}</span>
                    {!!s.paused && <span className="chip" style={{ fontSize: 9, padding: '2px 6px', background: 'var(--hover-bg)' }}>paused</span>}
                  </div>
                  <span className="muted-2" style={{ fontSize: 11 }}>
                    Monthly · next on the {ordinal(s.day_of_month)}
                    {s.category ? ` · ${s.category}` : ''}
                  </span>
                </div>
                <span className="mono tnum" style={{ fontSize: 13, opacity: s.paused ? 0.6 : 1 }}>
                  {fmt(s.amount, s.amount % 1 ? 2 : 0)}
                </span>
                <button
                  className="btn ghost icon"
                  style={{ width: 32, height: 32, color: 'var(--text-1)' }}
                  onClick={() => handleTogglePause(s)}
                  title={s.paused ? "Resume" : "Pause"}
                >
                  <Icon name={s.paused ? "play" : "pause"} size={16} style={{ fill: 'currentColor' }} />
                </button>
                <button
                  className="btn ghost icon sub-row-edit"
                  style={{ width: 32, height: 32 }}
                  onClick={() => openEdit(s)}
                  title="Edit"
                >
                  <Icon name="pencil" size={13} />
                </button>
                <button
                  className="btn ghost icon sub-row-delete"
                  style={{ width: 32, height: 32, color: 'var(--rose)' }}
                  onClick={() => setDeleteTarget(s)}
                  title="Delete"
                >
                  <Icon name="trash-2" size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add / Edit Modal */}
      <Modal open={modalOpen} onClose={closeModal}>
        <div style={{ padding: '24px 28px', minWidth: 360 }}>
          <h3 className="h2" style={{ marginBottom: 20 }}>
            {editing ? 'Edit subscription' : 'New subscription'}
          </h3>
          <form onSubmit={handleSave} className="stack" style={{ gap: 14 }}>
            <div className="field">
              <label>Name</label>
              <input
                className="input"
                placeholder="e.g. Netflix"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                autoFocus
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 12 }}>
              <div className="field">
                <label>Amount</label>
                <input
                  className="input mono"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Currency</label>
                <select
                  className="select"
                  value={form.currency}
                  onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}
                >
                  <option value="ILS">ILS</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field">
                <label>Billing day</label>
                <input
                  className="input mono"
                  type="number"
                  min="1"
                  max="28"
                  placeholder="1–28"
                  value={form.day_of_month}
                  onChange={e => setForm(f => ({ ...f, day_of_month: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Category</label>
                <select
                  className="select"
                  value={form.category_id}
                  onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))}
                >
                  <option value="">None</option>
                  {cats.map(c => (
                    <option key={c.category_id} value={c.category_id}>{c.name}</option>
                  ))}
                </select>
              </div>
            </div>
            {error && (
              <div style={{
                background: '#450a0a', border: '1px solid #7f1d1d',
                borderRadius: 8, padding: '8px 12px',
                color: '#fca5a5', fontSize: 12,
              }}>{error}</div>
            )}
            <div className="row" style={{ gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
              <button type="button" className="btn" onClick={closeModal}>Cancel</button>
              <button type="submit" className="btn primary" disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Add subscription'}
              </button>
            </div>
          </form>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <div style={{ padding: '24px 28px', minWidth: 320 }}>
          <h3 className="h2" style={{ marginBottom: 10 }}>Delete subscription</h3>
          <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 20 }}>
            Remove <strong style={{ color: 'var(--text-0)' }}>{deleteTarget?.name}</strong>?
            Auto-charges will stop.
          </p>
          <div className="row" style={{ gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setDeleteTarget(null)}>Cancel</button>
            <button className="btn danger" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
