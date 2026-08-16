import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import Icon from './ui/Icon';
import Toast from './ui/Toast';
import api from '../api/client';

/**
 * Links a Telegram chat to this account by issuing a short-lived, single-use code that the
 * user sends to the bot as `/link <code>`.
 *
 * This direction matters. The bot used to accept `/link_google <email>`, which took the
 * sender's word for the address — so anyone could bind their chat to an account that had
 * never linked Telegram. Issuing the code from an authenticated session means only someone
 * already signed in to the account can produce one.
 */
export default function TelegramLinkCard() {
  const { t } = useI18n();
  const [linked, setLinked] = useState(null);   // null = not loaded yet
  const [code, setCode] = useState(null);       // { code, expires_at }
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState('');
  const pollRef = useRef(null);
  const tickRef = useRef(null);

  const load = useCallback(async () => {
    const res = await api.get('/me');
    return res.data;
  }, []);

  useEffect(() => {
    load().then(d => setLinked(d.telegram_linked)).catch(() => {});
  }, [load]);

  // Poll only while a code is live: the bot redeems it out-of-band, so there is nothing to
  // notice at any other time. Stopping when the code expires keeps an idle Settings tab
  // from polling forever.
  useEffect(() => {
    clearInterval(pollRef.current);
    if (!code || linked) return undefined;

    pollRef.current = setInterval(async () => {
      try {
        const data = await load();
        if (data.telegram_linked) {
          setLinked(true);
          setCode(null);
          setToast(t('settings_tg_linked_toast'));
        }
      } catch { /* transient — keep polling */ }
    }, 5000);

    return () => clearInterval(pollRef.current);
  }, [code, linked, load, t]);

  // Countdown, so the user knows whether the code on screen is still worth sending.
  useEffect(() => {
    clearInterval(tickRef.current);
    if (!code) return undefined;

    const update = () => {
      const left = Math.max(0, Math.floor((new Date(code.expires_at) - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) clearInterval(tickRef.current);
    };
    update();
    tickRef.current = setInterval(update, 1000);

    return () => clearInterval(tickRef.current);
  }, [code]);

  const generate = async () => {
    setBusy(true);
    try {
      const res = await api.post('/auth/telegram/link-code');
      setCode(res.data);
      setCopied(false);
    } catch {
      setToast(t('auth_err_generic'));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    if (!window.confirm(t('settings_tg_unlink_confirm'))) return;
    setBusy(true);
    try {
      await api.delete('/auth/telegram/link');
      setLinked(false);
      setCode(null);
      setToast(t('settings_tg_unlinked_toast'));
    } catch {
      setToast(t('auth_err_generic'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`/link ${code.code}`);
      setCopied(true);
    } catch { /* clipboard blocked — the code is on screen to type */ }
  };

  const mmss = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  const expired = code && remaining === 0;

  return (
    <div className="card card-pad-lg" style={{ marginBottom: 20 }}>
      <h3 className="h2" style={{ marginBottom: 4 }}>{t('settings_tg')}</h3>
      <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>{t('settings_tg_sub')}</div>

      <div className="between" style={{ paddingTop: 14, borderTop: '1px solid var(--line)' }}>
        <div className="row">
          <span
            style={{
              width: 8, height: 8, borderRadius: 999,
              background: linked ? 'var(--emerald)' : 'var(--text-3)',
            }}
          />
          <span style={{ fontSize: 14 }}>
            {linked ? t('settings_tg_connected') : t('settings_tg_not_connected')}
          </span>
        </div>

        {linked ? (
          <button className="btn" onClick={unlink} disabled={busy}>
            {t('settings_tg_unlink')}
          </button>
        ) : (
          <button className="btn primary" onClick={generate} disabled={busy}>
            <Icon name="link" size={14} /> {t('settings_tg_generate')}
          </button>
        )}
      </div>

      {!linked && code && (
        <div style={{ marginTop: 16 }}>
          <div className="muted-2" style={{ fontSize: 12, marginBottom: 8 }}>
            {t('settings_tg_code_intro')}
          </div>

          <div
            className="between"
            style={{
              background: 'var(--input-bg)', border: '1px solid var(--line)',
              borderRadius: 12, padding: '12px 14px', gap: 12,
            }}
          >
            <code
              className="mono"
              dir="ltr"
              style={{
                fontSize: 16, fontWeight: 600, letterSpacing: '0.08em',
                color: expired ? 'var(--text-3)' : 'var(--text-0)',
                textDecoration: expired ? 'line-through' : 'none',
                userSelect: 'text',
              }}
            >
              /link {code.code}
            </code>
            <button className="btn" onClick={copy} disabled={expired} style={{ flexShrink: 0 }}>
              {copied ? t('settings_tg_copied') : t('settings_tg_copy')}
            </button>
          </div>

          <div className="between" style={{ marginTop: 8 }}>
            <span className="muted-2" style={{ fontSize: 11.5 }}>
              {expired
                ? t('settings_tg_code_expired')
                : t('settings_tg_code_expires').replace('{time}', mmss)}
            </span>
            {!expired && (
              <span className="muted-2" style={{ fontSize: 11.5 }}>{t('settings_tg_waiting')}</span>
            )}
          </div>
        </div>
      )}

      <Toast msg={toast} onDone={() => setToast('')} />
    </div>
  );
}
