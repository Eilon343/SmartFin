import { useEffect, useState, useCallback } from 'react';
import { useI18n } from '../context/I18nContext';
import api from '../api/client';
import Icon from '../components/ui/Icon';
import Modal from '../components/ui/Modal';
import PageHeader from '../components/ui/PageHeader';
import Sk from '../components/ui/Skeleton';

const EMPTY_FORM = {
  source: '',
  amount: '',
  currency: 'ILS',
  type: 'fixed',
  month: new Date().toISOString().slice(0, 7),
  description: '',
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

function TypeBadge({ type }) {
  const { t } = useI18n();
  return (
    <span className={`chip ${type === 'fixed' ? 'up' : 'idg'}`} style={{ fontSize: 10 }}>
      {t(type === 'fixed' ? 'dash_fixed' : 'dash_variable') || type}
    </span>
  );
}

export default function Income() {
  const { lang, t } = useI18n();
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
        setError('');
      })
      .catch(() => setError(t('inc_err_load')))
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(() => { reload(); }, [reload]);

  function openAdd() {
    setForm({ ...EMPTY_FORM, month });
    setError('');
    setModalOpen(true);
  }

  function openEdit(entry) {
    setForm({
      income_id: entry.income_id,
      source: entry.source,
      amount: entry.amount,
      currency: entry.currency,
      type: entry.type,
      month: entry.month,
      description: entry.description || '',
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
      source: form.source.trim(),
      amount: parseFloat(form.amount),
      currency: form.currency,
      type: form.type,
      month: form.month,
      description: form.description.trim() || undefined,
    };
    if (!payload.source || isNaN(payload.amount) || !payload.month) {
      setError(t('inc_err_req'));
      return;
    }
    setSaving(true);
    try {
      if (form.income_id) {
        await api.put(`/income/${form.income_id}`, payload);
      } else {
        await api.post('/income', payload);
      }
      closeModal();
      reload();
    } catch (err) {
      setError(err.response?.data?.error || t('inc_err_load'));
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
    } catch (err) {
      setError(err.response?.data?.error || t('inc_err_load'));
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return (
    <div className="view-enter">
      <Sk width="25%" height={28} style={{ marginBottom: 8 }} />
      <Sk width="55%" height={13} style={{ marginBottom: 24 }} />
      <Sk width={160} height={36} radius={10} style={{ marginBottom: 20 }} />
      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        {[1,2,3].map(i => (
          <div key={i} className="card card-pad-lg">
            <Sk width="55%" height={11} style={{ marginBottom: 12 }} />
            <Sk width="60%" height={36} style={{ marginBottom: 8 }} />
            <Sk width="35%" height={11} />
          </div>
        ))}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="between" style={{ padding: '18px 22px', borderBottom: '1px solid var(--line)' }}>
          <Sk width={200} height={18} />
          <Sk width={64} height={32} radius={8} />
        </div>
        <div style={{ padding: '12px 22px 20px' }}>
          {[1,2,3,4].map(i => <Sk key={i} height={44} radius={8} style={{ marginBottom: 8 }} />)}
        </div>
      </div>
    </div>
  );

  return (
    <div className="view-enter">
      <PageHeader title={t('nav_income')} sub={t('inc_sub')} />
      {error && !modalOpen && !deleteTarget && (
        <div style={{ color: 'var(--rose)', padding: '10px 16px', background: 'var(--hover-bg-2)', borderRadius: 8, marginBottom: 20, fontSize: 13 }}>{error}</div>
      )}

      {/* Month picker */}
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

      {/* Summary cards */}
      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <div className="card card-pad-lg">
          <span className="meta-label">{t('inc_fixed')}</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }} dir="ltr">
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>
            {fmt(summary?.fixed_total ?? 0)}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>{t('inc_this_month')}</span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">{t('inc_var_this_mo')}</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }} dir="ltr">
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>
            {fmt(summary?.variable_total ?? 0)}
          </div>
          <span className="chip idg" style={{ marginTop: 6, fontSize: 10 }}>{t('inc_current_month')}</span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">{t('inc_total')}</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }} dir="ltr">
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>
            {fmt(summary?.total ?? 0)}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>{t('inc_fixed_var')}</span>
        </div>
      </div>

      {/* Entries table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="between" style={{ padding: '18px 22px' }}>
          <h3 className="h2">{t('inc_entries')} — {month}</h3>
          <button className="btn primary" onClick={openAdd}>
            <Icon name="plus" size={14} /> {t('common_add')}
          </button>
        </div>

        {entries.length === 0 ? (
          <div style={{ padding: '24px 22px', color: 'var(--text-3)', fontSize: 13 }}>
            {t('inc_no_entries')} {month}. {t('inc_click_add')}
          </div>
        ) : (
          <div style={{ padding: '0 22px 14px' }}>
            {entries.map(entry => (
              <div
                key={entry.income_id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '36px 1fr auto auto 32px 32px',
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
                <span className="mono tnum" style={{ fontSize: 13 }} dir="ltr">
                  {entry.currency !== 'ILS' ? `${entry.currency} ` : '₪'}{fmt(entry.amount)}
                </span>
                <TypeBadge type={entry.type} />
                <button
                  className="btn ghost icon"
                  style={{ width: 32, height: 32, color: 'var(--text-2)' }}
                  onClick={() => openEdit(entry)}
                  title={t('common_edit')}
                >
                  <Icon name="edit-2" size={13} />
                </button>
                <button
                  className="btn ghost icon"
                  style={{ width: 32, height: 32, color: 'var(--rose)' }}
                  onClick={() => setDeleteTarget(entry)}
                  title={t('common_delete')}
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
          <h3 className="h2" style={{ marginBottom: 20 }}>
            {form.income_id ? t('inc_edit') : t('inc_new')}
          </h3>
          <form onSubmit={handleSave} className="stack" style={{ gap: 14 }}>
            <div className="field">
              <label>{t('inc_source')}</label>
              <input
                className="input"
                placeholder={t('inc_eg_source')}
                value={form.source}
                onChange={e => setForm(f => ({ ...f, source: e.target.value }))}
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field">
                <label>{t('inc_type')}</label>
                <select
                  className="select"
                  value={form.type}
                  onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                >
                  <option value="fixed">{t('dash_fixed')}</option>
                  <option value="variable">{t('dash_variable')}</option>
                </select>
              </div>
              <div className="field">
                <label>{t('inc_month')}</label>
                <div style={{ position: 'relative' }}>
                  <select
                    className="input"
                    style={{ appearance: 'none', paddingRight: lang === 'he' ? 12 : 36, paddingLeft: lang === 'he' ? 36 : 12, cursor: 'pointer', width: '100%' }}
                    value={form.month}
                    onChange={e => setForm(f => ({ ...f, month: e.target.value }))}
                  >
                    {getMonthOptions(lang).map(o => (
                      <option key={o.iso} value={o.iso}>{o.label}</option>
                    ))}
                  </select>
                  <Icon name="calendar" size={14} color="var(--text-3)" style={{ position: 'absolute', [lang === 'he' ? 'left' : 'right']: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
                </div>
              </div>
            </div>
            <div className="field">
              <label>{t('inc_desc')}</label>
              <input
                className="input"
                placeholder={t('inc_eg_desc')}
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              />
            </div>
            {error && (
              <div style={{
                color: 'var(--rose)', fontSize: 13, marginTop: 4
              }}>{error}</div>
            )}
            <div className="row" style={{ gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
              <button type="button" className="btn" onClick={closeModal}>{t('common_cancel')}</button>
              <button type="submit" className="btn primary" disabled={saving}>
                {saving ? t('common_saving') : form.income_id ? t('inc_save_changes') : t('inc_add_btn')}
              </button>
            </div>
          </form>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <div style={{ padding: '24px 28px', minWidth: 320 }}>
          <h3 className="h2" style={{ marginBottom: 10 }}>{t('inc_del_title')}</h3>
          <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 20 }}>
            {t('inc_del_confirm')} <strong style={{ color: 'var(--text-0)' }}>{deleteTarget?.source}</strong> ({deleteTarget?.month})?
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
