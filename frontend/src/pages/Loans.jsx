import { useEffect, useState, useCallback } from 'react';
import { useI18n } from '../context/I18nContext';
import api from '../api/client';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader';
import Modal from '../components/ui/Modal';
import Sk from '../components/ui/Skeleton';

// Loans are manual entry: the bank scraper does not report balances, rates or remaining
// payments. What sync does see — the monthly repayment debit — is offered as a starting
// point ("detected repayments") so a new loan begins from real numbers.

function fmt(n, dp = 0) {
  if (n == null) return '—';
  return `‎₪${Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}‎`;
}

const TYPES = ['loan', 'mortgage', 'overdraft', 'other'];
const TYPE_ICON = { loan: 'landmark', mortgage: 'home', overdraft: 'minus-circle', other: 'file-text' };
const EMPTY_FORM = {
  lender: '', loan_type: 'loan', original_amount: '', outstanding_balance: '', interest_rate: '',
  monthly_payment: '', remaining_payments: '', payment_day: '', notes: '', match_key: '',
};

const toNum = (v) => (v === '' || v == null ? null : Number(v));

export default function Loans() {
  const { t } = useI18n();
  const [data, setData] = useState({ loans: [], summary: null, detected_repayments: [], repayment_payees: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);

  // State is only set from the promise callbacks, so this can run straight from an effect.
  const reload = useCallback(() => {
    api.get('/loans')
      .then(r => { setData(r.data); setLoadError(''); })
      .catch(() => setLoadError(t('loan_err_load')))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => { reload(); }, [reload]);

  function openAdd(prefill = {}) {
    setEditing(null);
    setForm({ ...EMPTY_FORM, ...prefill });
    setError('');
    setModalOpen(true);
  }

  function openEdit(l) {
    setDetail(null);
    setEditing(l);
    const s = (v) => (v == null ? '' : String(v));
    setForm({
      lender: l.lender, loan_type: l.loan_type,
      original_amount: s(l.original_amount), outstanding_balance: s(l.outstanding_balance),
      interest_rate: s(l.interest_rate), monthly_payment: s(l.monthly_payment),
      remaining_payments: s(l.remaining_payments), payment_day: s(l.payment_day),
      notes: l.notes || '', match_key: l.match_key || '',
    });
    setError('');
    setModalOpen(true);
  }

  function fromDetected(d) {
    openAdd({
      lender: d.description,
      monthly_payment: String(d.last_amount ?? d.average_amount ?? ''),
      payment_day: String(Math.min(28, d.payment_day || 1)),
      match_key: d.match_key,
    });
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    const payload = {
      lender: form.lender.trim(),
      loan_type: form.loan_type,
      original_amount: toNum(form.original_amount),
      outstanding_balance: toNum(form.outstanding_balance) ?? 0,
      interest_rate: toNum(form.interest_rate),
      monthly_payment: toNum(form.monthly_payment) ?? 0,
      remaining_payments: toNum(form.remaining_payments),
      payment_day: toNum(form.payment_day),
      notes: form.notes.trim() || null,
      match_key: form.match_key || null,
    };
    if (!payload.lender) { setError(t('loan_err_lender')); return; }
    setSaving(true);
    try {
      if (editing) await api.put(`/loans/${editing.loan_id}`, payload);
      else await api.post('/loans', payload);
      setModalOpen(false);
      reload();
    } catch (err) {
      setError(err.response?.data?.error || t('loan_err_save'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await api.delete(`/loans/${deleteTarget.loan_id}`);
      setDeleteTarget(null);
      setDetail(null);
      reload();
    } catch {
      setError(t('loan_err_save'));
    }
  }

  const { loans, summary, detected_repayments: detected, repayment_payees: payees = [] } = data;

  if (loading) return (
    <div className="view-enter">
      <Sk width="38%" height={28} style={{ marginBottom: 24 }} />
      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        {[1, 2, 3].map(i => <div key={i} className="card card-pad-lg"><Sk width="50%" height={11} style={{ marginBottom: 12 }} /><Sk width="60%" height={30} /></div>)}
      </div>
      <Sk height={180} radius={12} />
    </div>
  );

  const field = (key, label, props = {}) => (
    <div className="field">
      <label htmlFor={`loan-${key}`}>{label}</label>
      <input
        id={`loan-${key}`}
        className={`input${props.type === 'number' ? ' mono' : ''}`}
        value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        {...props}
      />
    </div>
  );

  return (
    <div className="view-enter">
      <PageHeader title={t('loan_title')} sub={t('loan_sub')} />

      {loadError && <div className="card card-pad" style={{ marginBottom: 16, color: 'var(--rose)' }}>{loadError}</div>}

      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <div className="card card-pad-lg">
          <span className="meta-label">{t('loan_total_outstanding')}</span>
          <div className="big-num" style={{ fontSize: 32, marginTop: 8 }} dir="ltr">{fmt(summary?.total_outstanding ?? 0)}</div>
          <span className="muted" style={{ fontSize: 12 }}>{loans.length} {t('loan_count')}</span>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">{t('loan_total_monthly')}</span>
          <div className="big-num" style={{ fontSize: 32, marginTop: 8 }} dir="ltr">{fmt(summary?.total_monthly_payment ?? 0)}</div>
        </div>
        <div className="card card-pad-lg">
          <span className="meta-label">{t('loan_next_payment')}</span>
          {summary?.next_payment ? (
            <>
              <div className="big-num" style={{ fontSize: 32, marginTop: 8 }} dir="ltr">{fmt(summary.next_payment.amount)}</div>
              <span className="muted" style={{ fontSize: 12 }}>{summary.next_payment.date} · {summary.next_payment.lender}</span>
            </>
          ) : <div className="muted" style={{ marginTop: 12, fontSize: 13 }}>—</div>}
        </div>
      </div>

      {detected?.length > 0 && (
        <div className="card card-pad-lg" style={{ marginBottom: 20 }}>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <Icon name="sparkles" size={16} />
            <span style={{ fontWeight: 600, fontSize: 14 }}>{t('loan_detected_title')}</span>
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>{t('loan_detected_sub')}</p>
          {detected.map(d => (
            <div key={d.match_key} className="sub-row">
              <div className="stack" style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 500, fontSize: 13.5 }}>{d.description}</span>
                <span className="muted-2" style={{ fontSize: 11 }}>
                  {t('loan_detected_meta').replace('{n}', d.payments_seen).replace('{day}', d.payment_day).replace('{date}', d.last_date)}
                </span>
              </div>
              <span className="mono tnum" style={{ fontSize: 13 }} dir="ltr">{fmt(d.last_amount, 2)}</span>
              <button className="btn" onClick={() => fromDetected(d)}>
                <Icon name="plus" size={14} /> {t('loan_add_from_detected')}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="between" style={{ padding: '18px 22px' }}>
          <h3 className="h2">{t('loan_all')}</h3>
          <button className="btn primary" onClick={() => openAdd()}>
            <Icon name="plus" size={14} /> {t('common_add')}
          </button>
        </div>
        {loans.length === 0 ? (
          <div style={{ padding: '0 22px 22px', color: 'var(--text-3)', fontSize: 13 }}>{t('loan_none')}</div>
        ) : (
          <div style={{ padding: '0 22px 14px' }}>
            {loans.map(l => (
              <button
                key={l.loan_id}
                className="sub-row"
                style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'start', color: 'inherit', font: 'inherit' }}
                onClick={() => setDetail(l)}
                aria-label={`${l.lender} — ${t('loan_details')}`}
              >
                <div style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--hover-bg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name={TYPE_ICON[l.loan_type] || 'landmark'} size={16} />
                </div>
                <div className="stack" style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 500, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.lender}</span>
                  <span className="muted-2" style={{ fontSize: 11 }}>
                    {l.finished ? `${t('loan_finished')} · ` : ''}{t(`loan_type_${l.loan_type}`)}
                    {l.monthly_payment ? ` · ${fmt(l.monthly_payment)}/${t('loan_per_month')}` : ''}
                    {l.next_payment_date ? ` · ${t('loan_next')} ${l.next_payment_date}` : ''}
                  </span>
                </div>
                <div className="stack" style={{ alignItems: 'flex-end' }}>
                  <span className="mono tnum" style={{ fontSize: 13 }} dir="ltr">{fmt(l.outstanding_balance)}</span>
                  <span className="muted-2" style={{ fontSize: 11 }}>{t('loan_outstanding')}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="muted-2" style={{ fontSize: 11.5, marginTop: 12 }}>
        <Icon name="info" size={11} /> {t('loan_manual_note')}
      </p>

      {/* Detail screen */}
      <Modal open={!!detail} onClose={() => setDetail(null)}>
        {detail && (
          <div style={{ padding: '24px 28px', minWidth: 340 }}>
            <h3 className="h2" style={{ marginBottom: 4 }}>{detail.lender}</h3>
            <span className="chip" style={{ marginBottom: 16 }}>{t(`loan_type_${detail.loan_type}`)}</span>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', fontSize: 13, margin: '12px 0 20px' }}>
              {[
                ['loan_outstanding', fmt(detail.outstanding_balance, 2)],
                ['loan_original', fmt(detail.original_amount, 2)],
                ['loan_monthly', fmt(detail.monthly_payment, 2)],
                ['loan_rate', detail.interest_rate == null ? '—' : `${detail.interest_rate}%`],
                ['loan_remaining', detail.remaining_payments ?? '—'],
                ['loan_next', detail.next_payment_date || '—'],
                ['loan_balance_as_of', detail.balance_updated_at || '—'],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt className="muted">{t(k)}</dt>
                  <dd className="mono tnum" style={{ margin: 0 }} dir="ltr">{v}</dd>
                </div>
              ))}
            </dl>
            {detail.notes && <p className="muted" style={{ fontSize: 12.5, marginBottom: 16 }}>{detail.notes}</p>}
            <div style={{ marginBottom: 18 }}>
              <span className="meta-label">{t('loan_auto_payments')}</span>
              {!detail.match_key ? (
                <p className="muted-2" style={{ fontSize: 12, marginTop: 6 }}>{t('loan_not_linked')}</p>
              ) : detail.payments.length === 0 ? (
                <p className="muted-2" style={{ fontSize: 12, marginTop: 6 }}>{t('loan_no_payments_yet')}</p>
              ) : (
                <div style={{ marginTop: 6 }}>
                  {detail.payments.map(p => (
                    <div key={p.date + p.amount} className="between" style={{ fontSize: 12.5, padding: '4px 0' }}>
                      <span className="muted">{p.date}</span>
                      <span className="mono tnum" dir="ltr">−{fmt(p.principal, 2)} → {fmt(p.balance_after, 2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="row" style={{ gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn danger" onClick={() => setDeleteTarget(detail)}>{t('common_delete')}</button>
              <button className="btn primary" onClick={() => openEdit(detail)}>
                <Icon name="pencil" size={13} /> {t('loan_update')}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Add / edit */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)}>
        <div style={{ padding: '24px 28px', minWidth: 360, maxWidth: 520 }}>
          <h3 className="h2" style={{ marginBottom: 6 }}>{editing ? t('loan_edit') : t('loan_new')}</h3>
          <p className="muted-2" style={{ fontSize: 11.5, marginBottom: 16 }}>{t('loan_manual_note')}</p>
          <form onSubmit={handleSave} className="stack" style={{ gap: 12 }}>
            {field('lender', t('loan_lender'), { autoFocus: true, placeholder: t('loan_eg_lender') })}
            <div className="field">
              <label htmlFor="loan-type">{t('loan_type')}</label>
              <select id="loan-type" className="select" value={form.loan_type} onChange={e => setForm(f => ({ ...f, loan_type: e.target.value }))}>
                {TYPES.map(tp => <option key={tp} value={tp}>{t(`loan_type_${tp}`)}</option>)}
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {field('outstanding_balance', t('loan_outstanding'), { type: 'number', step: '0.01', min: '0' })}
              {field('original_amount', t('loan_original'), { type: 'number', step: '0.01', min: '0' })}
              {field('monthly_payment', t('loan_monthly'), { type: 'number', step: '0.01', min: '0' })}
              {field('interest_rate', t('loan_rate'), { type: 'number', step: '0.001', min: '0', max: '100' })}
              {field('remaining_payments', t('loan_remaining'), { type: 'number', step: '1', min: '0' })}
              {field('payment_day', t('loan_payment_day'), { type: 'number', step: '1', min: '1', max: '28', placeholder: '1–28' })}
            </div>
            <div className="field">
              <label htmlFor="loan-link">{t('loan_link')}</label>
              <select id="loan-link" className="select" value={form.match_key} onChange={e => setForm(f => ({ ...f, match_key: e.target.value }))}>
                <option value="">{t('loan_link_none')}</option>
                {[...new Map([...payees, ...(form.match_key ? [{ match_key: form.match_key, description: form.match_key }] : [])].map(p => [p.match_key, p])).values()]
                  .map(p => <option key={p.match_key} value={p.match_key}>{p.description}</option>)}
              </select>
              <span className="muted-2" style={{ fontSize: 11 }}>{t('loan_link_hint')}</span>
            </div>
            {field('notes', t('loan_notes'))}
            {error && <div style={{ color: 'var(--rose)', fontSize: 12 }}>{error}</div>}
            <div className="row" style={{ gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
              <button type="button" className="btn" onClick={() => setModalOpen(false)}>{t('common_cancel')}</button>
              <button type="submit" className="btn primary" disabled={saving}>{saving ? t('common_saving') : t('loan_save')}</button>
            </div>
          </form>
        </div>
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <div style={{ padding: '24px 28px', minWidth: 320 }}>
          <h3 className="h2" style={{ marginBottom: 10 }}>{t('loan_del_title')}</h3>
          <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 20 }}>{deleteTarget?.lender}</p>
          <div className="row" style={{ gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setDeleteTarget(null)}>{t('common_cancel')}</button>
            <button className="btn danger" onClick={handleDelete}>{t('common_delete')}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
