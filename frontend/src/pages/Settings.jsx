import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useI18n } from '../context/I18nContext';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader';
import Modal from '../components/ui/Modal';
import Toast from '../components/ui/Toast';
import DuplicateCleanupCard from '../components/DuplicateCleanupCard';
import WhatsNewModal from '../components/WhatsNewModal';
import api from '../api/client';

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const isDark = theme === 'dark';
  return (
    <button
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        height: 36, padding: '0 12px', borderRadius: 999,
        background: 'var(--input-bg)', border: '1px solid var(--line-2)',
        color: 'var(--text-1)', cursor: 'pointer',
        font: '500 12.5px Inter, sans-serif',
        transition: 'background .2s',
      }}>
      {isDark ? <Icon name="moon" size={15} color="var(--indigo)" /> : <Icon name="sun" size={15} color="var(--amber)" />}
      <span>{isDark ? t('settings_theme_btn_dark') : t('settings_theme_btn_light')}</span>
    </button>
  );
}

function BankConnectModal({ open, onClose, onSave }) {
  const { t } = useI18n();
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [credentials, setCredentials] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCredentials({});
    setSaving(false);
    api.get('/bank-connections/companies').then(res => {
      setCompanies(res.data || []);
      if (res.data?.length) setCompanyId(res.data[0].id);
    });
  }, [open]);

  const company = companies.find(c => c.id === companyId);

  const submit = async (e) => {
    e.preventDefault();
    if (!company) return;
    setSaving(true);
    try {
      await onSave(companyId, credentials);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
        <div className="between">
          <h3 className="h2" style={{ fontSize: 17 }}>{t('settings_bank_connect')}</h3>
          <button type="button" className="btn ghost icon" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className="field">
          <label>{t('settings_bank_company')}</label>
          <select className="select" value={companyId} onChange={e => { setCompanyId(e.target.value); setCredentials({}); }}>
            <optgroup label={t('settings_bank_group_bank')}>
              {companies.filter(c => c.kind !== 'card').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </optgroup>
            <optgroup label={t('settings_bank_group_card')}>
              {companies.filter(c => c.kind === 'card').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </optgroup>
          </select>
        </div>
        {company?.loginFields.map(field => (
          <div className="field" key={field}>
            <label>{t(`settings_bank_field_${field}`)}</label>
            <input
              className="input"
              type={field.toLowerCase().includes('password') ? 'password' : 'text'}
              value={credentials[field] || ''}
              onChange={e => setCredentials(c => ({ ...c, [field]: e.target.value }))}
            />
          </div>
        ))}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>{t('common_cancel')}</button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? t('common_saving') : <><Icon name="check" size={13} /> {t('settings_bank_connect')}</>}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function statusColor(status) {
  if (status === 'active') return 'var(--emerald)';
  if (status === 'pending_first_sync') return 'var(--amber)';
  return 'var(--rose)';
}

/**
 * Explains a failed sync in terms of what the user can do about it.
 *
 * The bare status word was all this screen used to show. "Error" is indistinguishable
 * from a bank outage, and hides the fact that some failures never clear on their own —
 * a mistyped username retries hourly forever, spending a real login attempt each time.
 * So each failure states the cause, whether it will retry by itself, and the fix.
 *
 * The raw scraper message is kept behind a disclosure: useless to most people, but the
 * first thing you want when something unmapped goes wrong.
 */
function SyncFailureNotice({ failure }) {
  const { t } = useI18n();
  if (!failure) return null;

  // A failure nothing will retry needs the user now, so it is coloured as such.
  const urgent = !failure.retrying;

  return (
    <div
      className="stack"
      style={{
        gap: 6, marginTop: 10, padding: '10px 12px', borderRadius: 8,
        background: 'var(--hover-bg-2)',
        borderInlineStart: `3px solid ${urgent ? 'var(--rose)' : 'var(--amber)'}`,
      }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 500 }}>
        {t(`settings_bank_fail_${failure.code}`)}
      </span>
      <span className="muted-2" style={{ fontSize: 12 }}>
        {t(`settings_bank_fix_${failure.code}`)}
      </span>
      <span className="muted-2" style={{ fontSize: 11.5, opacity: 0.8 }}>
        {failure.retrying ? t('settings_bank_fail_will_retry') : t('settings_bank_fail_no_retry')}
      </span>
      {failure.detail && (
        <details style={{ fontSize: 11.5 }}>
          <summary className="muted-2" style={{ cursor: 'pointer' }}>
            {t('settings_bank_fail_details')}
          </summary>
          <code
            dir="ltr"
            style={{
              display: 'block', marginTop: 6, padding: 8, borderRadius: 6,
              background: 'var(--input-bg)', color: 'var(--text-1)',
              fontSize: 11, lineHeight: 1.5, wordBreak: 'break-all', whiteSpace: 'pre-wrap',
            }}
          >
            {failure.detail}
          </code>
        </details>
      )}
    </div>
  );
}

function BankSyncCard() {
  const { t } = useI18n();
  const [connections, setConnections] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState('');
  const pollRef = useRef(null);

  const load = useCallback(() => {
    api.get('/bank-connections').then(res => setConnections(res.data || []));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const anyPending = connections.some(c => c.status === 'pending_first_sync');
    clearInterval(pollRef.current);
    if (anyPending) {
      pollRef.current = setInterval(load, 5000);
    }
    return () => clearInterval(pollRef.current);
  }, [connections, load]);

  const connect = async (companyId, credentials) => {
    try {
      await api.post('/bank-connections', { companyId, credentials });
      setToast(t('settings_bank_toast_connected'));
      load();
    } catch (err) {
      setToast(err.response?.data?.error || t('settings_bank_err_connect'));
      throw err;
    }
  };

  const syncNow = async (id) => {
    try {
      await api.post(`/bank-connections/${id}/sync`);
      setToast(t('settings_bank_toast_sync'));
      load();
    } catch (err) {
      setToast(err.response?.data?.error || t('settings_bank_err_sync'));
    }
  };

  const disconnect = async (id) => {
    if (!window.confirm(t('settings_bank_confirm_disconnect'))) return;
    await api.delete(`/bank-connections/${id}`);
    setToast(t('settings_bank_toast_disconnected'));
    load();
  };

  return (
    <div className="card card-pad-lg" style={{ marginBottom: 20 }}>
      <h3 className="h2" style={{ marginBottom: 4 }}>{t('settings_bank')}</h3>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>{t('settings_bank_sub')}</div>
      <div className="muted-2" style={{ fontSize: 12, marginBottom: 16 }}>{t('settings_bank_card_hint')}</div>

      {connections.length === 0 && (
        <div className="muted-2" style={{ fontSize: 13, marginBottom: 16 }}>{t('settings_bank_none')}</div>
      )}

      {connections.map(c => (
        <div key={c.id} style={{ padding: '12px 0', borderTop: '1px solid var(--line)' }}>
          {/* Wraps on a phone: the name plus a full timestamp plus two buttons does not
              fit 360px, and without wrapping the buttons were pushed off the card. */}
          <div className="between conn-row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <div className="stack" style={{ minWidth: 0, flex: '1 1 180px' }}>
              <span style={{ fontWeight: 500, fontSize: 14 }}>{c.display_name || c.company_id}</span>
              <span className="muted-2" style={{ fontSize: 12 }}>
                <span style={{ color: statusColor(c.status) }}>{t(`settings_bank_status_${c.status}`)}</span>
                {' · '}
                {t('settings_bank_last_sync')}: {c.last_sync_at ? new Date(c.last_sync_at).toLocaleString() : t('settings_bank_last_sync_never')}
              </span>
            </div>
            <div className="row conn-actions" style={{ gap: 8 }}>
              <button className="btn" onClick={() => syncNow(c.id)}>{t('settings_bank_sync_now')}</button>
              <button className="btn" style={{ color: 'var(--rose)', borderColor: 'var(--rose-soft)' }} onClick={() => disconnect(c.id)}>
                {t('settings_bank_disconnect')}
              </button>
            </div>
          </div>
          <SyncFailureNotice failure={c.failure} />
        </div>
      ))}

      <button className="btn primary" style={{ marginTop: 16 }} onClick={() => setModalOpen(true)}>
        <Icon name="link" size={14} /> {t('settings_bank_connect')}
      </button>

      <BankConnectModal open={modalOpen} onClose={() => setModalOpen(false)} onSave={connect} />
      <Toast msg={toast} onDone={() => setToast('')} />
    </div>
  );
}

export default function Settings() {
  const { logout } = useAuth();
  const { theme } = useTheme();
  const { lang, setLang, t } = useI18n();
  // The tour is shown once automatically after the update; this is how someone finds it
  // again afterwards.
  const [tourOpen, setTourOpen] = useState(false);

  const rows = [
    {
      icon: 'globe',
      name: t('settings_lang'),
      sub: t('settings_lang_sub'),
      val: (
        <select 
          className="select" 
          style={{ height: 32, padding: '0 8px', fontSize: 13 }}
          value={lang} 
          onChange={e => setLang(e.target.value)}
        >
          <option value="en">English</option>
          <option value="he">עברית</option>
        </select>
      ),
    },
    {
      icon: 'banknote',
      name: t('settings_currency'),
      sub: t('settings_currency_sub'),
      val: <span className="muted">ILS</span>,
    },
    {
      icon: 'calendar',
      name: t('settings_cycle'),
      sub: t('settings_cycle_sub'),
      val: <span className="muted">{t('settings_cycle_val')}</span>,
    },
    {
      icon: 'sparkles',
      name: t('settings_avg'),
      sub: t('settings_avg_sub'),
      val: <span className="muted">3 mo</span>,
    },
    {
      icon: 'gift',
      name: t('whatsnew_eyebrow'),
      sub: `v${__APP_VERSION__}`,
      val: (
        <button className="btn" onClick={() => setTourOpen(true)}>
          {t('whatsnew_open')}
        </button>
      ),
    },
    {
      icon: theme === 'dark' ? 'moon' : 'sun',
      name: t('settings_theme'),
      sub: theme === 'dark' ? t('settings_theme_dark') : t('settings_theme_light'),
      val: <ThemeToggle />,
    },
  ];

  return (
    <div className="view-enter">
      <PageHeader title={t('settings_title')} sub={t('settings_sub')} />

      <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
        {rows.map((r, i) => (
          <div key={i} className="between" style={{ padding: '16px 22px', borderTop: i ? '1px solid var(--line)' : 'none' }}>
            <div className="row" style={{ gap: 14 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 9,
                background: 'var(--hover-bg-2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon name={r.icon} size={16} color="var(--text-1)" />
              </div>
              <div className="stack">
                <span style={{ fontWeight: 500, fontSize: 14 }}>{r.name}</span>
                <span className="muted-2" style={{ fontSize: 12 }}>{r.sub}</span>
              </div>
            </div>
            <div className="row" style={{ gap: 12 }}>
              {r.val}
            </div>
          </div>
        ))}
      </div>

      <BankSyncCard />

      <DuplicateCleanupCard />

      <WhatsNewModal open={tourOpen} onClose={() => setTourOpen(false)} />

      <div className="card card-pad-lg">
        <h3 className="h2" style={{ marginBottom: 4 }}>{t('settings_account')}</h3>
        <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>{t('settings_account_sub')}</div>
        <button
          className="btn"
          style={{ color: 'var(--rose)', borderColor: 'var(--rose-soft)' }}
          onClick={logout}
        >
          <Icon name="log-out" size={14} /> {t('settings_signout')}
        </button>
      </div>
    </div>
  );
}
