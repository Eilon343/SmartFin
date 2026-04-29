import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useI18n } from '../context/I18nContext';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader';

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
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
      <span>{isDark ? 'Dark' : 'Light'}</span>
    </button>
  );
}

export default function Settings() {
  const { logout } = useAuth();
  const { theme } = useTheme();
  const { lang, setLang, t } = useI18n();

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
      icon: 'message-circle',
      name: t('settings_tg'),
      sub: t('settings_tg_sub'),
      val: <span className="chip up"><span className="dot" style={{ background: 'var(--emerald)' }} /> {t('settings_tg_connected')}</span>,
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
