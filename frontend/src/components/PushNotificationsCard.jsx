import { useEffect, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import Icon from './ui/Icon';
import Toast from './ui/Toast';
import { getPushSupport, getPushSubscription, enablePush, disablePush, sendTestPush } from '../lib/push';

export default function PushNotificationsCard() {
  const { t } = useI18n();
  const [support, setSupport] = useState(() => getPushSupport());
  const [enabled, setEnabled] = useState(null); // null = not loaded yet
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    // Permission granted with no live subscription still reads as "off": nothing would arrive.
    getPushSubscription()
      .then((sub) => setEnabled(Boolean(sub) && Notification.permission === 'granted'))
      .catch(() => setEnabled(false));
  }, []);

  const toggle = async () => {
    setBusy(true);
    try {
      if (enabled) {
        await disablePush();
        setEnabled(false);
        setToast(t('settings_push_off_toast'));
      } else {
        const res = await enablePush();
        setSupport(getPushSupport());
        if (res.ok) {
          setEnabled(true);
          setToast(t('settings_push_on_toast'));
        } else {
          setToast(t(`settings_push_reason_${res.reason}`));
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await sendTestPush();
      setToast(t('settings_push_test_sent'));
    } catch (err) {
      setToast(err.response?.data?.error || t('settings_push_test_failed'));
    } finally {
      setTesting(false);
    }
  };

  const blocked = support.permission === 'denied';
  const unavailable = !support.supported || blocked;
  const hint = !support.supported
    ? t(`settings_push_reason_${support.reason}`)
    : blocked ? t('settings_push_reason_denied') : null;

  return (
    <div className="card card-pad-lg" style={{ marginBottom: 20 }}>
      <h3 className="h2" style={{ marginBottom: 4 }}>{t('settings_push')}</h3>
      <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>{t('settings_push_sub')}</div>

      <div className="between" style={{ paddingTop: 14, borderTop: '1px solid var(--line)', gap: 12, flexWrap: 'wrap' }}>
        <div className="row">
          <span
            style={{
              width: 8, height: 8, borderRadius: 999,
              background: enabled ? 'var(--emerald)' : 'var(--text-3)',
            }}
          />
          <span style={{ fontSize: 14 }}>
            {enabled ? t('settings_push_on') : t('settings_push_off')}
          </span>
        </div>

        <div className="row" style={{ gap: 8 }}>
          {enabled && (
            <button className="btn" onClick={test} disabled={testing || busy}>
              <Icon name="sparkles" size={14} /> {testing ? t('settings_push_testing') : t('settings_push_test')}
            </button>
          )}
          {(enabled || !unavailable) && (
            <button
              className={enabled ? 'btn' : 'btn primary'}
              onClick={toggle}
              disabled={busy || enabled === null}
              aria-pressed={Boolean(enabled)}
            >
              {enabled ? t('settings_push_disable') : t('settings_push_enable')}
            </button>
          )}
        </div>
      </div>

      {hint && !enabled && (
        <div className="muted-2" style={{ fontSize: 12, marginTop: 10 }}>{hint}</div>
      )}

      <Toast msg={toast} onDone={() => setToast('')} />
    </div>
  );
}
