import { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useI18n } from '../context/I18nContext';
import Icon from './ui/Icon';
import Drawer from './ui/Drawer';
import LogTransaction from './LogTransaction';

const NAV = [
  { id: 'dashboard',     nameKey: 'nav_dashboard',     icon: 'layout-dashboard', path: '/' },
  { id: 'categories',    nameKey: 'nav_categories',    icon: 'grid-2x2',         path: '/categories' },
  { id: 'subscriptions', nameKey: 'nav_subscriptions', icon: 'repeat',           path: '/subscriptions' },
  { id: 'savings',       nameKey: 'nav_savings',       icon: 'piggy-bank',       path: '/savings' },
  { id: 'income',        nameKey: 'nav_income',        icon: 'trending-up',      path: '/income' },
  { id: 'expenses',      nameKey: 'nav_expenses',      icon: 'receipt',          path: '/expenses' },
  { id: 'insights',      nameKey: 'nav_insights',      icon: 'sparkles',         path: '/insights' },
  { id: 'settings',      nameKey: 'nav_settings',      icon: 'settings',         path: '/settings' },
];

// Bottom nav shows only 4 primary tabs
const BOTTOM_NAV = [
  { id: 'dashboard',     label: 'Home',  icon: 'layout-dashboard', path: '/' },
  { id: 'categories',    label: 'Cats',  icon: 'grid-2x2',         path: '/categories' },
  { id: 'subscriptions', label: 'Subs',  icon: 'repeat',           path: '/subscriptions' },
  { id: 'savings',       label: 'Save',  icon: 'piggy-bank',       path: '/savings' },
];

function ThemeToggle({ compact }) {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
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
      {!compact && <span>{isDark ? t('settings_theme_btn_dark') : t('settings_theme_btn_light')}</span>}
    </button>
  );
}

function MobileThemeBtn() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      className="btn ghost icon"
      style={{ width: 40, height: 40, background: 'none', border: 'none', boxShadow: 'none' }}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={isDark ? 'Light mode' : 'Dark mode'}
    >
      <Icon name={isDark ? 'moon' : 'sun'} size={18} color={isDark ? 'var(--indigo)' : 'var(--amber)'} />
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

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}


export default function Layout() {
  const { logout, user, googleProfile } = useAuth();
  const navigate = useNavigate();
  const activeNav = useActiveNav();
  const { t } = useI18n();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  const displayName = googleProfile?.name || user?.username?.replace(/^@/, '') || 'You';

  function handleNavClick(path) {
    navigate(path);
    setDrawerOpen(false);
  }

  function handleSaved() {
    window.dispatchEvent(new Event('smartfin:reload'));
  }

  return (
    <div className="app">
      {/* ── Desktop sidebar (unchanged, hidden on mobile) ── */}
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
              <span>{t(n.nameKey)}</span>
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
            <span className="muted" style={{ fontSize: 12 }}>{t('settings_signout')}</span>
            <Icon name="log-out" size={13} color="var(--text-3)" />
          </div>
          <div style={{ marginTop: 10, textAlign: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.03em' }}>
              v{__APP_VERSION__}
            </span>
          </div>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="main">
        {/* Mobile topbar */}
        <div className="topbar-mobile">
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            {googleProfile?.picture && (
              <img
                src={googleProfile.picture}
                alt=""
                style={{ width: 36, height: 36, borderRadius: '50%', flexShrink: 0, objectFit: 'cover' }}
                referrerPolicy="no-referrer"
              />
            )}
            <div className="stack" style={{ gap: 1 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-3)' }}>
                {greeting()}
              </span>
              <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' }}>
                {displayName}
              </span>
            </div>
          </div>
          <div className="row" style={{ gap: 4 }}>
            <MobileThemeBtn />
            <button className="btn ghost icon" style={{ width: 40, height: 40, background: 'none', border: 'none', boxShadow: 'none' }} onClick={() => setDrawerOpen(true)}>
              <Icon name="menu" size={20} color="var(--text-1)" />
            </button>
          </div>
        </div>

        <div className="container">
          <Outlet />
        </div>
      </main>

      {/* ── Mobile bottom nav (4 tabs) ── */}
      <nav className="mobile-nav">
        {BOTTOM_NAV.map(n => (
          <button
            key={n.id}
            className={`mobile-nav-item ${activeNav === n.id ? 'active' : ''}`}
            onClick={() => navigate(n.path)}
          >
            <Icon name={n.icon} size={20} />
            <span>{n.label}</span>
          </button>
        ))}
      </nav>

      {/* ── Mobile FAB ── */}
      <button className="fab mobile-only" onClick={() => setLogOpen(true)} aria-label="Log transaction">
        <Icon name="plus" size={22} />
      </button>

      {/* ── Hamburger drawer (mobile) ── */}
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <div style={{ padding: '16px 16px 0' }}>
          <div className="between" style={{ marginBottom: 16 }}>
            <div className="row" style={{ gap: 10 }}>
              <div style={{
                width: 28, height: 28, borderRadius: 8,
                background: 'linear-gradient(135deg, #10b981, #059669)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontWeight: 800, fontSize: 12,
              }}>S</div>
              <div className="stack">
                <span style={{ fontWeight: 700, fontSize: 13 }}>SmartFin</span>
                <span className="muted-2" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Personal Finance OS</span>
              </div>
            </div>
            <button className="btn ghost icon" onClick={() => setDrawerOpen(false)}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        <div style={{ padding: '0 12px', flex: 1, overflowY: 'auto' }}>
          <div className="meta-label" style={{ padding: '0 8px 8px' }}>Navigate</div>
          {NAV.map(n => (
            <button
              key={n.id}
              className={`nav-item ${activeNav === n.id ? 'active' : ''}`}
              style={{ width: '100%', border: 'none', textAlign: 'left', background: 'transparent', cursor: 'pointer', font: 'inherit' }}
              onClick={() => handleNavClick(n.path)}
            >
              <Icon name={n.icon} size={16} />
              <span>{t(n.nameKey)}</span>
              {activeNav === n.id && <span className="nav-dot" />}
            </button>
          ))}

          <div className="meta-label" style={{ padding: '20px 8px 8px' }}>Quick</div>
          <button
            className="nav-item"
            style={{ width: '100%', border: 'none', textAlign: 'left', background: 'transparent', cursor: 'pointer', font: 'inherit' }}
            onClick={() => { setDrawerOpen(false); setLogOpen(true); }}
          >
            <Icon name="plus-circle" size={16} />
            <span>Log a transaction</span>
          </button>
        </div>

        <div style={{ padding: '16px 20px 28px', borderTop: '1px solid var(--line)' }}>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <ThemeToggle />
          </div>
          <button
            className="btn"
            style={{ width: '100%', justifyContent: 'center', color: 'var(--rose)', borderColor: 'var(--rose-soft)' }}
            onClick={() => { setDrawerOpen(false); logout(); }}
          >
            <Icon name="log-out" size={14} /> {t('settings_signout')}
          </button>
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.03em' }}>
              v{__APP_VERSION__}
            </span>
          </div>
        </div>
      </Drawer>

      {/* ── Log transaction bottom sheet ── */}
      <LogTransaction
        open={logOpen}
        onClose={() => setLogOpen(false)}
        onSaved={handleSaved}
      />
    </div>
  );
}
