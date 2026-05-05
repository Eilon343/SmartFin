import { useEffect, useState, useCallback } from 'react';
import api from '../api/client';
import Icon from '../components/ui/Icon';
import Modal from '../components/ui/Modal';
import PageHeader from '../components/ui/PageHeader';

const EMPTY_FORM = {
  description: '',
  amount: '',
  currency: 'ILS',
  category_id: '',
};

function fmt(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function SourceBadge({ source }) {
  if (source === 'apple_pay') {
    return (
      <span style={{
        background: 'var(--text-0)', color: 'var(--bg-0)',
        padding: '3px 10px', borderRadius: 20,
        fontSize: 11, fontWeight: 600, letterSpacing: '-0.01em',
        whiteSpace: 'nowrap',
      }}>
        &#x1F4F1; Apple Pay
      </span>
    );
  }
  return (
    <span style={{
      background: 'var(--hover-bg-2)', color: 'var(--text-2)',
      padding: '3px 10px', borderRadius: 20, fontSize: 11,
    }}>
      {source === 'web' ? 'Web' : source === 'manual' ? 'Manual' : 'Bot'}
    </span>
  );
}

export default function Expenses() {
  const now = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(now);
  const [expenses, setExpenses] = useState([]);
  const [cats, setCats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    setLoading(true);
    api.get(`/expenses?month=${month}`)
      .then(r => {
        setExpenses(r.data);
        setError('');
      })
      .catch(() => setError('Failed to load expenses.'))
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    api.get('/categories').then(r => setCats(r.data)).catch(console.error);
  }, []);

  function openAdd() {
    setForm(EMPTY_FORM);
    setError('');
    setModalOpen(true);
  }

  function openEdit(tx) {
    setForm({
      expense_id: tx.expense_id,
      description: tx.description || '',
      amount: tx.amount,
      currency: tx.currency || 'ILS',
      category_id: tx.category_id || '',
      source: tx.source || 'web',
    });
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
      amount: parseFloat(form.amount),
      currency: form.currency,
      description: form.description.trim() || undefined,
      category_id: form.category_id ? parseInt(form.category_id, 10) : null,
    };
    if (isNaN(payload.amount) || payload.amount <= 0) {
      setError('A valid amount is required.');
      return;
    }
    setSaving(true);
    try {
      if (form.expense_id) {
        await api.put(`/expenses/${form.expense_id}`, payload);
      } else {
        await api.post('/expenses', payload);
      }
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
      await api.delete(`/expenses/${deleteTarget.expense_id}`);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete.');
    } finally {
      setDeleting(false);
    }
  }

  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);

  return (
    <div className="view-enter">
      <PageHeader title="Expenses" sub="All transactions for the selected month" />
      {error && !modalOpen && !deleteTarget && (
        <div style={{ color: 'var(--rose)', padding: '10px 16px', background: 'var(--hover-bg-2)', borderRadius: 8, marginBottom: 20, fontSize: 13 }}>{error}</div>
      )}

      <div className="row" style={{ marginBottom: 20, gap: 10 }}>
        <input
          type="month"
          className="input"
          style={{ width: 160 }}
          value={month}
          onChange={e => setMonth(e.target.value)}
        />
      </div>

      {/* Summary strip */}
      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <div className="card card-pad-lg">
          <span className="meta-label">Total spent</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }}>
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>{fmt(total)}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>{expenses.length} transactions</span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">Avg per transaction</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }}>
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>
            {expenses.length > 0 ? fmt(total / expenses.length) : '0.00'}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>this month</span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">Apple Pay</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }}>
            {expenses.filter(e => e.source === 'apple_pay').length}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>tap-to-pay transactions</span>
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="between" style={{ padding: '18px 22px' }}>
          <h3 className="h2">Transactions — {month}</h3>
          <button className="btn primary" onClick={openAdd}>
            <Icon name="plus" size={14} /> Add
          </button>
        </div>

        {loading ? (
          <div style={{ padding: '24px 22px' }}>
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} style={{ height: 44, background: 'var(--hover-bg)', borderRadius: 8, marginBottom: 8, animation: 'pulse 1.5s ease infinite' }} />
            ))}
          </div>
        ) : expenses.length === 0 ? (
          <div style={{ padding: '24px 22px', color: 'var(--text-3)', fontSize: 13 }}>
            No expenses for {month}.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Date', 'Description', 'Category', 'Amount', 'Source', ''].map((h, i) => (
                    <th key={i} style={{
                      textAlign: i >= 3 ? 'right' : 'left',
                      padding: '10px 16px',
                      color: 'var(--text-3)',
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      borderBottom: '1px solid var(--line)',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {expenses.map(e => (
                  <tr
                    key={e.expense_id}
                    style={{ borderBottom: '1px solid var(--line)' }}
                  >
                    <td style={{ padding: '11px 16px', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                      {e.created_at?.slice(0, 10)}
                    </td>
                    <td style={{ padding: '11px 16px', color: 'var(--text-1)', maxWidth: 220 }}>
                      {e.description || <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      <span className="chip idg" style={{ fontSize: 11 }}>
                        {e.category_name || 'Uncategorized'}
                      </span>
                    </td>
                    <td style={{ padding: '11px 16px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {e.currency !== 'ILS' ? `${e.currency} ` : '₪'}{fmt(e.amount)}
                    </td>
                    <td style={{ padding: '11px 16px', textAlign: 'right' }}>
                      <SourceBadge source={e.source} />
                    </td>
                    <td style={{ padding: '11px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn ghost icon"
                        style={{ width: 30, height: 30, color: 'var(--text-2)', marginRight: 6 }}
                        onClick={() => openEdit(e)}
                        title="Edit"
                      >
                        <Icon name="edit-2" size={13} />
                      </button>
                      <button
                        className="btn ghost icon"
                        style={{ width: 30, height: 30, color: 'var(--rose)' }}
                        onClick={() => setDeleteTarget(e)}
                        title="Delete"
                      >
                        <Icon name="trash-2" size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add Modal */}
      <Modal open={modalOpen} onClose={closeModal}>
        <div style={{ padding: '24px 28px', minWidth: 360 }}>
          <h3 className="h2" style={{ marginBottom: 20 }}>
            {form.expense_id ? 'Edit expense' : 'New expense'}
          </h3>
          <form onSubmit={handleSave} className="stack" style={{ gap: 14 }}>
            <div className="field">
              <label>Description (optional)</label>
              <input
                className="input"
                placeholder="e.g. Coffee, Groceries"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
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
            <div className="field">
              <label>Category</label>
              <select
                className="select"
                value={form.category_id}
                onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))}
              >
                <option value="">Uncategorized</option>
                {cats.map(c => (
                  <option key={c.category_id} value={c.category_id}>{c.name}</option>
                ))}
              </select>
            </div>
            {error && (
              <div style={{
                color: 'var(--rose)', fontSize: 13, marginTop: 4
              }}>{error}</div>
            )}
            <div className="row" style={{ gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
              <button type="button" className="btn" onClick={closeModal}>Cancel</button>
              <button type="submit" className="btn primary" disabled={saving}>
                {saving ? 'Saving…' : form.expense_id ? 'Save changes' : 'Add expense'}
              </button>
            </div>
          </form>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <div style={{ padding: '24px 28px', minWidth: 320 }}>
          <h3 className="h2" style={{ marginBottom: 10 }}>Delete expense</h3>
          <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 20 }}>
            Remove{' '}
            <strong style={{ color: 'var(--text-0)' }}>
              {deleteTarget?.description || `₪${fmt(deleteTarget?.amount ?? 0)}`}
            </strong>{' '}
            from {deleteTarget?.created_at?.slice(0, 10)}?
          </p>
          {error && <div style={{ color: 'var(--rose)', fontSize: 13, marginBottom: 15 }}>{error}</div>}
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
