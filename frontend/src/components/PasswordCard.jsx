import { useEffect, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import Icon from './ui/Icon';
import Toast from './ui/Toast';
import api from '../api/client';
import { MIN_PASSWORD } from '../lib/authValidation';

/**
 * Gives the account a password it can sign in with, alongside Google.
 *
 * The reason it is here rather than filed under nice-to-have: an account created by
 * signing in with Google has no password at all, and Google Sign-In does not complete
 * inside an installed iOS PWA — that app has its own storage jar, holding none of the
 * Google cookies Safari signed in with. So the phone offers a Google button that cannot
 * work and a password form the account has no password for, and the owner is locked out
 * of their own figures with no way back in from the device itself.
 *
 * Setting one here, from a session that already works, is that way back: the same address
 * reaches the same account either way, because the server keys identity off one UNIQUE
 * email column.
 */
export default function PasswordCard() {
  const { t } = useI18n();
  const [hasPassword, setHasPassword] = useState(null); // null = not loaded yet
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => {
    api.get('/me').then(res => setHasPassword(!!res.data.has_password)).catch(() => {});
  }, []);

  function reset() {
    setOpen(false);
    setCurrent('');
    setNext('');
    setError('');
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (next.length < MIN_PASSWORD) {
      setError(t('auth_err_password_short'));
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/password', {
        // Omitted entirely on an account that has none; the server only asks for it when
        // there is an existing password to protect.
        ...(hasPassword ? { current_password: current } : {}),
        new_password: next,
      });
      setHasPassword(true);
      reset();
      setToast(t('settings_pw_saved'));
    } catch (err) {
      const code = err.response?.data?.error;
      if (err.response?.status === 429) setError(t('auth_err_ratelimit'));
      else if (code === 'invalid_credentials') setError(t('settings_pw_err_current'));
      else if (code === 'weak_password') setError(t('auth_err_password_short'));
      else setError(t('auth_err_generic'));
    } finally {
      setBusy(false);
    }
  }

  if (hasPassword === null) return null;

  return (
    <div className="card card-pad-lg" style={{ marginBottom: 20 }}>
      <h3 className="h2" style={{ marginBottom: 4 }}>{t('settings_pw_title')}</h3>
      <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
        {t(hasPassword ? 'settings_pw_sub_has' : 'settings_pw_sub_none')}
      </div>

      {!open ? (
        <button className="btn" onClick={() => setOpen(true)}>
          <Icon name="key-round" size={14} />
          {t(hasPassword ? 'settings_pw_change' : 'settings_pw_set')}
        </button>
      ) : (
        <form className="stack" style={{ gap: 12, maxWidth: 360 }} onSubmit={submit}>
          {hasPassword && (
            <div className="field">
              <label htmlFor="pw-current">{t('settings_pw_current')}</label>
              <input
                id="pw-current"
                className="input"
                type="password"
                dir="ltr"
                autoComplete="current-password"
                value={current}
                onChange={e => setCurrent(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="pw-new">{t('settings_pw_new')}</label>
            <input
              id="pw-new"
              className="input"
              type="password"
              dir="ltr"
              autoComplete="new-password"
              value={next}
              onChange={e => setNext(e.target.value)}
            />
            <span className="muted-2" style={{ fontSize: 11.5, textAlign: 'start' }}>
              {t('auth_err_password_short')}
            </span>
          </div>

          {error && (
            <div style={{
              background: 'var(--rose-soft)', border: '1px solid var(--rose)',
              borderRadius: 10, padding: '10px 12px',
            }} role="alert">
              <p style={{ color: 'var(--rose)', fontSize: 12.5, margin: 0, textAlign: 'start' }}>{error}</p>
            </div>
          )}

          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? t('auth_working') : t('settings_pw_save')}
            </button>
            <button className="btn" type="button" onClick={reset} disabled={busy}>
              {t('settings_pw_cancel')}
            </button>
          </div>
        </form>
      )}

      {toast && <Toast msg={toast} onDone={() => setToast('')} />}
    </div>
  );
}
