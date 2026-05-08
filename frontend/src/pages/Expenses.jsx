import { useEffect, useState, useCallback } from 'react';
import { useI18n } from '../context/I18nContext';
import api from '../api/client';
import Icon from '../components/ui/Icon';
import Modal from '../components/ui/Modal';
import PageHeader from '../components/ui/PageHeader';
import Sk from '../components/ui/Skeleton';

const EMPTY_FORM = {
  description: '',
  amount: '',
  currency: 'ILS',
  category_id: '',
};

function getMonthOptions(lang) {
  const result = [];
  const now = new Date();
  let y = now.getFullYear() + 1;
  let m = 11;
  const locale = lang === 'he' ? 'he-IL' : 'en-US';

  for (let i = 0; i < 60; i++) {
    const d = new Date(y, m, 1);
    const iso = `${y}-${String(m + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
    result.push({ iso, label });
    m--;
    if (m < 0) { m = 11; y--; }
  }
  return result;
}

function fmt(n) {
  return `\u200E₪${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\u200E`;
}

function SourceBadge({ source }) {
  const { t } = useI18n();
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
      {source === 'web' ? t('web') : source === 'manual' ? t('manual') : t('bot')}
    </span>
  );
}

export default function Expenses() {
  const { lang, t } = useI18n();
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
      .catch(() => setError(t('exp_err_load')))
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
      setError(t('exp_err_req'));
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
      setError(err.response?.data?.error || t('exp_err_load'));
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
      setError(err.response?.data?.error || t('exp_err_load'));
    } finally {
      setDeleting(false);
    }
  }

  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);

  if (loading) return (
    <div className="view-enter">
      <Sk width="32%" height={28} style={{ marginBottom: 8 }} />
      <Sk width="52%" height={13} style={{ marginBottom: 24 }} />
      <Sk width={160} height={36} radius={10} style={{ marginBottom: 20 }} />
      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        {[1,2,3].map(i => (
          <div key={i} className="card card-pad-lg">
            <Sk width="50%" height={11} style={{ marginBottom: 12 }} />
            <Sk width="65%" height={36} style={{ marginBottom: 8 }} />
            <Sk width="40%" height={11} />
          </div>
        ))}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="between" style={{ padding: '18px 22px', borderBottom: '1px solid var(--line)' }}>
          <Sk width={180} height={18} />
          <Sk width={64} height={32} radius={8} />
        </div>
        <div style={{ padding: '12px 22px 20px' }}>
          {[1,2,3,4,5].map(i => <Sk key={i} height={44} radius={8} style={{ marginBottom: 8 }} />)}
        </div>
      </div>
    </div>
  );

  return (
    <div className="view-enter">
      <PageHeader title={t('exp_title')} sub={t('exp_sub')} />
      {error && !modalOpen && !deleteTarget && (
        <div style={{ color: 'var(--rose)', padding: '10px 16px', background: 'var(--hover-bg-2)', borderRadius: 8, marginBottom: 20, fontSize: 13 }}>{error}</div>
      )}

      <div className="row" style={{ marginBottom: 20, gap: 10 }}>
        <div style={{ position: 'relative' }}>
          <select
            className="input"
            style={{ width: 160, appearance: 'none', paddingRight: lang === 'he' ? 12 : 36, paddingLeft: lang === 'he' ? 36 : 12, cursor: 'pointer' }}
            value={month}
            onChange={e => setMonth(e.target.value)}
          >
            {getMonthOptions(lang).map(o => (
              <option key={o.iso} value={o.iso}>{o.label}</option>
            ))}
          </select>
          <Icon name="calendar" size={14} color="var(--text-3)" style={{ position: 'absolute', [lang === 'he' ? 'left' : 'right']: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <div className="card card-pad-lg">
          <span className="meta-label">{t('exp_total')}</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }} dir="ltr">
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>{fmt(total)}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>{expenses.length} {t('exp_tx_count')}</span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">{t('exp_avg')}</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }} dir="ltr">
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>
            {expenses.length > 0 ? fmt(total / expenses.length) : '0.00'}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>{t('inc_this_month')}</span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">Apple Pay</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }} dir="ltr">
            {expenses.filter(e => e.source === 'apple_pay').length}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>{t('exp_tap')}</span>
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="between" style={{ padding: '18px 22px' }}>
          <h3 className="h2">{t('exp_tx_month')} — {month}</h3>
          <button className="btn primary" onClick={openAdd}>
            <Icon name="plus" size={14} /> {t('common_add')}
          </button>
        </div>

        {expenses.length === 0 ? (
          <div style={{ padding: '24px 22px', color: 'var(--text-3)', fontSize: 13 }}>
            {t('exp_no_tx')} {month}.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {[t('dash_date'), t('dash_desc'), t('dash_cat'), t('dash_amt'), t('dash_src'), ''].map((h, i) => (
                    <th key={i} style={{
                      textAlign: i >= 3 && i !== 5 ? (lang === 'he' ? 'left' : 'right') : (lang === 'he' ? 'right' : 'left'),
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
                      {t(e.description || e.category_name) || (e.description || e.category_name) || <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      <span className="chip idg" style={{ fontSize: 11 }}>
                        {t(e.category_name) || e.category_name || t('exp_uncat')}
                      </span>
                    </td>
                    <td style={{ padding: '11px 16px', textAlign: lang === 'he' ? 'left' : 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }} dir="ltr">
                      {e.currency !== 'ILS' ? `${e.currency} ` : '₪'}{fmt(e.amount)}
                    </td>
                    <td style={{ padding: '11px 16px', textAlign: lang === 'he' ? 'left' : 'right' }}>
                      <SourceBadge source={e.source} />
                    </td>
                    <td style={{ padding: '11px 16px', textAlign: lang === 'he' ? 'left' : 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn ghost icon"
                        style={{ width: 30, height: 30, color: 'var(--text-2)', marginRight: 6 }}
                        onClick={() => openEdit(e)}
                        title={t('common_edit')}
                      >
                        <Icon name="edit-2" size={13} />
                      </button>
                      <button
                        className="btn ghost icon"
                        style={{ width: 30, height: 30, color: 'var(--rose)' }}
                        onClick={() => setDeleteTarget(e)}
                        title={t('common_delete')}
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
            {form.expense_id ? t('exp_edit') : t('exp_new')}
          </h3>
          <form onSubmit={handleSave} className="stack" style={{ gap: 14 }}>
            <div className="field">
              <label>{t('inc_desc')}</label>
              <input
                className="input"
                placeholder={t('exp_eg_desc')}
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                autoFocus
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 12 }}>
              <div className="field">
                <label>{t('dash_amt')}</label>
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
                <label>{t('inc_currency')}</label>
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
              <label>{t('dash_cat')}</label>
              <select
                className="select"
                value={form.category_id}
                onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))}
              >
                <option value="">{t('exp_uncat')}</option>
                {cats.map(c => (
                  <option key={c.category_id} value={c.category_id}>{t(c.name) || c.name}</option>
                ))}
              </select>
            </div>
            {error && (
              <div style={{
                color: 'var(--rose)', fontSize: 13, marginTop: 4
              }}>{error}</div>
            )}
            <div className="row" style={{ gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
              <button type="button" className="btn" onClick={closeModal}>{t('common_cancel')}</button>
              <button type="submit" className="btn primary" disabled={saving}>
                {saving ? t('common_saving') : form.expense_id ? t('inc_save_changes') : t('exp_add_btn')}
              </button>
            </div>
          </form>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <div style={{ padding: '24px 28px', minWidth: 320 }}>
          <h3 className="h2" style={{ marginBottom: 10 }}>{t('exp_del_title')}</h3>
          <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 20 }}>
            {t('inc_del_confirm')}{' '}
            <strong style={{ color: 'var(--text-0)' }} dir="ltr">
              {t(deleteTarget?.description) || deleteTarget?.description || `₪${fmt(deleteTarget?.amount ?? 0)}`}
            </strong>{' '}
            {t('dash_from')} {deleteTarget?.created_at?.slice(0, 10)}?
          </p>
          {error && <div style={{ color: 'var(--rose)', fontSize: 13, marginBottom: 15 }}>{error}</div>}
          <div className="row" style={{ gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setDeleteTarget(null)}>{t('common_cancel')}</button>
            <button className="btn danger" onClick={handleDelete} disabled={deleting}>
              {deleting ? t('common_saving') : t('common_delete')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
