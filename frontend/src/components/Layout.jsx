import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import Icon from './ui/Icon';

const NAV = [
  { id: 'dashboard',     name: 'Dashboard',     icon: 'layout-dashboard', path: '/' },
  { id: 'categories',    name: 'Categories',    icon: 'grid-2x2',         path: '/categories' },
  { id: 'subscriptions', name: 'Subscriptions', icon: 'repeat',           path: '/subscriptions' },
  { id: 'savings',       name: 'Savings',       icon: 'piggy-bank',       path: '/savings' },
  { id: 'income',        name: 'Income',        icon: 'trending-up',      path: '/income' },
  { id: 'expenses',      name: 'Expenses',      icon: 'receipt',          path: '/expenses' },
  { id: 'settings',      name: 'Settings',      icon: 'settings',         path: '/settings' },
];

function ThemeToggle({ compact }) {
  const { theme, setTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: compact ? 0 : 8,
        height: 36, padding: compact ? 0 : '0 12px', width: compact ? 36 : 'auto',
        justifyContent: 'center', borderRadius: 999,
        background: 'var(--input-bg)', border: '1px solid var(--line-2)',
        color: 'var(--text-1)', cursor: 'pointer',
        font: '500 12.5px Inter, sans-serif',
        transition: 'background .2s, color .2s',
      }}>
      {isDark
        ? <Icon name="moon" size={16} color="var(--indigo)" />
        : <Icon name="sun" size={16} color="var(--amber)" />}
      {!compact && <span>{isDark ? 'Dark' : 'Light'}</span>}
    </button>
  );
}

function useActiveNav() {
  const location = useLocation();
  const path = location.pathname;
  if (path === '/') return 'dashboard';
  const match = NAV.find(n => n.path !== '/' && path.startsWith(n.path));
  return match?.id || 'dashboard';
}

export default function Layout() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const activeNav = useActiveNav();

  return (
    <div className="app">
      <aside className="sidebar">
        <div style={{ padding: '22px 18px 14px' }}>
          <div className="row" style={{ gap: 10 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 9,
              background: 'linear-gradient(135deg, #10b981, #059669)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#ffffff', fontWeight: 800, fontSize: 14,
            }}>S</div>
            <div className="stack">
              <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.01em' }}>SmartFin</span>
              <span className="muted-2" style={{ fontSize: 10.5, letterSpacing: '0.04em', textTransform: 'uppercase' }}>personal finance OS</span>
            </div>
          </div>
        </div>

        <div style={{ padding: '6px 12px', display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
          <div className="meta-label" style={{ padding: '12px 10px 6px' }}>Navigate</div>
          {NAV.map(n => (
            <div
              key={n.id}
              className={`nav-item ${activeNav === n.id ? 'active' : ''}`}
              onClick={() => navigate(n.path)}
            >
              <Icon name={n.icon} size={16} />
              <span>{n.name}</span>
              <span className="nav-dot" />
            </div>
          ))}
        </div>

        <div style={{ padding: 12, borderTop: '1px solid var(--line)' }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <ThemeToggle />
          </div>
          <div
            className="between"
            style={{ padding: '8px 10px', borderRadius: 10, background: 'var(--input-bg)', border: '1px solid var(--line-2)', cursor: 'pointer' }}
            onClick={logout}
          >
            <span className="muted" style={{ fontSize: 12 }}>Sign out</span>
            <Icon name="log-out" size={13} color="var(--text-3)" />
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="topbar-mobile">
          <div className="row" style={{ gap: 10 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: 'linear-gradient(135deg, #10b981, #059669)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#ffffff', fontWeight: 800, fontSize: 12,
            }}>S</div>
            <span style={{ fontWeight: 700 }}>SmartFin</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <ThemeToggle compact />
            <button className="btn ghost icon" onClick={logout} title="Sign out">
              <Icon name="log-out" size={16} />
            </button>
          </div>
        </div>

        <div className="container">
          <Outlet />
        </div>
      </main>

      <nav className="mobile-nav">
        {NAV.map(n => (
          <div
            key={n.id}
            className={`nav-item ${activeNav === n.id ? 'active' : ''}`}
            onClick={() => navigate(n.path)}
          >
            <Icon name={n.icon} size={18} />
            <span>{n.name}</span>
          </div>
        ))}
      </nav>
    </div>
  );
}
