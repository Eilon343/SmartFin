import { useEffect, useState, useCallback } from 'react';
import { useI18n } from '../context/I18nContext';
import { currentMonth } from '../lib/month';
import { useSettings } from '../context/SettingsContext';
import { currentCycle, getCycleOptions, incomeMonthOf } from '../lib/cycle';
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
  month: currentMonth(),
  description: '',
};

/**
 * The month list for the ADD/EDIT FORM, which writes `income.month`.
 *
 * Deliberately still calendar months, and deliberately not the cycle picker at the top of
 * the page: `income.month` records WHICH SALARY a row is ("my September pay"), while the
 * page filter selects which CYCLE is being viewed. The mapping between the two is the
 * user's salary_day, and the backend owns it — see cycle.incomeMonthOf.
 */
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

// The amount alone. Wrapped in LRMs so a number never reorders inside the RTL layout.
// Every amount on this page renders ₪ as its own styled glyph or a currency
// prefix, so the formatter must not add one — doing both printed it twice.
function fmtNum(n) {
  return `‎${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}‎`;
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
  const { settings } = useSettings();
  // The page filter selects a CYCLE; the form below writes a calendar income.month.
  // Derived, not synced — see Dashboard.
  const [picked, setPicked] = useState(null);
  const month = picked ?? currentCycle(settings);
  const setMonth = setPicked;
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
    // Pre-fill with the salary the VIEWED CYCLE is funded by, not the cycle key itself:
    // with a payday before the anchor those are different months.
    setForm({ ...EMPTY_FORM, month: incomeMonthOf(month, settings) });
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
        <div className="period-select-wrap">
          <select
            className="input period-select"
            style={{ appearance: 'none', paddingRight: lang === 'he' ? 12 : 36, paddingLeft: lang === 'he' ? 36 : 12, cursor: 'pointer' }}
            value={month}
            onChange={e => setMonth(e.target.value)}
          >
            {getCycleOptions(settings, lang).map(o => (
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
            {fmtNum(summary?.fixed_total ?? 0)}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>{t('inc_this_month')}</span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">{t('inc_var_this_mo')}</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }} dir="ltr">
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>
            {fmtNum(summary?.variable_total ?? 0)}
          </div>
          <span className="chip idg" style={{ marginTop: 6, fontSize: 10 }}>{t('inc_current_month')}</span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">{t('inc_total')}</span>
          <div className="big-num" style={{ fontSize: 36, marginTop: 8 }} dir="ltr">
            <span className="ccy" style={{ fontSize: 20 }}>₪</span>
            {fmtNum(summary?.total ?? 0)}
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
              <div key={entry.income_id} className="inc-row">
                <div className="inc-icon">
                  <Icon name="trending-up" size={16} />
                </div>
                <div className="stack inc-text">
                  <span className="inc-source">{entry.source}</span>
                  <span className="muted-2 inc-meta">
                    {entry.month}
                    {entry.description ? ` · ${entry.description}` : ''}
                  </span>
                </div>
                <span className="mono tnum inc-amount" style={{ fontSize: 13 }} dir="ltr">
                  {entry.currency !== 'ILS' ? `${entry.currency} ` : '₪'}{fmtNum(entry.amount)}
                </span>
                {/* Badge and the two actions travel together so they can drop to a second
                    line as one group on a phone, instead of squeezing the source name to
                    nothing between them. */}
                <div className="inc-actions">
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
              </div>
            ))}
          </div>
        )}
      </div>

      <style>{`
        .inc-row {
          display: grid;
          grid-template-columns: 36px minmax(0, 1fr) auto auto;
          align-items: center;
          gap: 12px;
          padding: 10px 0;
          border-bottom: 1px solid var(--line);
        }
        .inc-icon {
          width: 36px; height: 36px; border-radius: 9px;
          background: var(--hover-bg-2);
          display: flex; align-items: center; justify-content: center;
          color: var(--emerald); flex-shrink: 0;
        }
        .inc-text { min-width: 0; }
        .inc-source { font-weight: 500; font-size: 13.5px; }
        .inc-meta { font-size: 11px; }
        /* Both lines ellipsize rather than wrapping: a two-line source name and a
           description clipped mid-word are what made these rows look broken. */
        .inc-source, .inc-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .inc-actions { display: flex; align-items: center; gap: 8px; }

        @media (max-width: 640px) {
          /* Amount stays on line one beside the name; badge and actions take line two, which
             gives the name the full width of the card instead of ~30px of leftovers. */
          .inc-row {
            grid-template-columns: 36px minmax(0, 1fr) auto;
            row-gap: 6px;
            column-gap: 10px;
          }
          .inc-actions { grid-column: 2 / -1; grid-row: 2; justify-content: flex-end; }
        }
      `}</style>


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
