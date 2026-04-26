import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
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

  const rows = [
    {
      icon: 'message-circle',
      name: 'Telegram bot',
      sub: 'Connect SmartFin to your Telegram for expense logging',
      val: <span className="chip up"><span className="dot" style={{ background: 'var(--emerald)' }} /> connected</span>,
    },
    {
      icon: 'banknote',
      name: 'Currency',
      sub: 'New Israeli Shekel (₪)',
      val: <span className="muted">ILS</span>,
    },
    {
      icon: 'calendar',
      name: 'Budget cycle',
      sub: 'Resets on the 1st of each month',
      val: <span className="muted">Monthly</span>,
    },
    {
      icon: 'sparkles',
      name: 'Variable income averaging',
      sub: 'Rolling 3-month mean used in P&L forecast',
      val: <span className="muted">3 mo</span>,
    },
    {
      icon: theme === 'dark' ? 'moon' : 'sun',
      name: 'Theme',
      sub: theme === 'dark' ? 'Dark mode — easy on the eyes' : 'Light mode — bright and clear',
      val: <ThemeToggle />,
    },
  ];

  return (
    <div className="view-enter">
      <PageHeader title="Settings" sub="Configure SmartFin to your workflow" />

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
        <h3 className="h2" style={{ marginBottom: 4 }}>Account</h3>
        <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>Manage your SmartFin account</div>
        <button
          className="btn"
          style={{ color: 'var(--rose)', borderColor: 'var(--rose-soft)' }}
          onClick={logout}
        >
          <Icon name="log-out" size={14} /> Sign out
        </button>
      </div>
    </div>
  );
}
