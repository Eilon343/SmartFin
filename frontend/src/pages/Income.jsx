import { useEffect, useState, useCallback } from 'react';
import api from '../api/client';
import Icon from '../components/ui/Icon';
import Modal from '../components/ui/Modal';
import PageHeader from '../components/ui/PageHeader';

const EMPTY_FORM = {
  source: '',
  amount: '',
  currency: 'ILS',
  type: 'fixed',
  month: new Date().toISOString().slice(0, 7),
  description: '',
};

function fmt(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function TypeBadge({ type }) {
  return (
    <span className={`chip ${type === 'fixed' ? 'up' : 'idg'}`} style={{ fontSize: 10 }}>
      {type}
    </span>
  );
}

export default function Income() {
  const now = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(now);
  const [entries, setEntries] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get(`/income?month=${month}`),
      api.get(`/income/summary?month=${month}`),
    ])
      .then(([r1, r2]) => {
        setEntries(r1.data);
        setSummary(r2.data);
      })
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(() => { reload(); }, [reload]);

  function openAdd() {
    setForm({ ...EMPTY_FORM, month });
    setError('');
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setError('');
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    const payload = {
      source: form.source.trim(),
      amount: parseFloat(form.amount),
      currency: form.currency,
      type: form.type,
      month: form.month,
      description: form.description.trim() || undefined,
    };
    if (!payload.source || isNaN(payload.amount) || !payload.month) {
      setError('Source, amount and month are required.');
      return;
    }
    setSaving(true);
    try {
      await api.post('/income', payload);
      closeModal();
      reload();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.delete(`/income/${deleteTarget.income_id}`);
      setDeleteTarget(null);
      reload();
    } catch {
      // ignore
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="view-enter">
      <PageHeader title="Income" sub="Fixed salary and variable income by month" />

      {/* Month picker */}
      <div className="row" style={{ marginBottom: 20, gap: 10 }}>
        <input
          type="month"
          className="input"
          style={{ width: 160 }}
          value={month}
          onChange={e => setMonth(e.target.value)}
        />
      </div>

      {/* Summary cards */}
      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <div className="card card-pad-lg">
          <span className="meta-label">Fixed income</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }}>
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>
            {fmt(summary?.fixed_total ?? 0)}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>this month</span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">Variable (3-mo avg)</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }}>
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>
            {fmt(summary?.variable_total ?? 0)}
          </div>
          <span className="chip idg" style={{ marginTop: 6, fontSize: 10 }}>averaged</span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">Total income</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }}>
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>
            {fmt(summary?.total ?? 0)}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>fixed + variable avg</span>
        </div>
      </div>

      {/* Entries table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="between" style={{ padding: '18px 22px' }}>
          <h3 className="h2">Income entries — {month}</h3>
          <button className="btn primary" onClick={openAdd}>
            <Icon name="plus" size={14} /> Add
          </button>
        </div>

        {loading ? (
          <div style={{ padding: '24px 22px', color: 'var(--text-3)', fontSize: 13 }}>Loading…</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: '24px 22px', color: 'var(--text-3)', fontSize: 13 }}>
            No income entries for {month}. Click Add to record one.
          </div>
        ) : (
          <div style={{ padding: '0 22px 14px' }}>
            {entries.map(entry => (
              <div
                key={entry.income_id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '36px 1fr auto auto 32px',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 0',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <div style={{
                  width: 36, height: 36, borderRadius: 9,
                  background: 'var(--hover-bg-2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--emerald)', flexShrink: 0,
                }}>
                  <Icon name="trending-up" size={16} />
                </div>
                <div className="stack" style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 500, fontSize: 13.5 }}>{entry.source}</span>
                  <span className="muted-2" style={{ fontSize: 11 }}>
                    {entry.month}
                    {entry.description ? ` · ${entry.description}` : ''}
                  </span>
                </div>
                <span className="mono tnum" style={{ fontSize: 13 }}>
                  {entry.currency !== 'ILS' ? `${entry.currency} ` : '₪'}{fmt(entry.amount)}
                </span>
                <TypeBadge type={entry.type} />
                <button
                  className="btn ghost icon"
                  style={{ width: 32, height: 32, color: 'var(--rose)' }}
                  onClick={() => setDeleteTarget(entry)}
                  title="Delete"
                >
                  <Icon name="trash-2" size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add Modal */}
      <Modal open={modalOpen} onClose={closeModal}>
        <div style={{ padding: '24px 28px', minWidth: 360 }}>
          <h3 className="h2" style={{ marginBottom: 20 }}>New income entry</h3>
          <form onSubmit={handleSave} className="stack" style={{ gap: 14 }}>
            <div className="field">
              <label>Source</label>
              <input
                className="input"
                placeholder="e.g. Salary, Freelance"
                value={form.source}
                onChange={e => setForm(f => ({ ...f, source: e.target.value }))}
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
                <label>Type</label>
                <select
                  className="select"
                  value={form.type}
                  onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                >
                  <option value="fixed">Fixed</option>
                  <option value="variable">Variable</option>
                </select>
              </div>
              <div className="field">
                <label>Month</label>
                <input
                  type="month"
                  className="input"
                  value={form.month}
                  onChange={e => setForm(f => ({ ...f, month: e.target.value }))}
                />
              </div>
            </div>
            <div className="field">
              <label>Description (optional)</label>
              <input
                className="input"
                placeholder="e.g. Bonus, Q1 invoice"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              />
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
                {saving ? 'Saving…' : 'Add income'}
              </button>
            </div>
          </form>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <div style={{ padding: '24px 28px', minWidth: 320 }}>
          <h3 className="h2" style={{ marginBottom: 10 }}>Delete income entry</h3>
          <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 20 }}>
            Remove <strong style={{ color: 'var(--text-0)' }}>{deleteTarget?.source}</strong> ({deleteTarget?.month})?
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
