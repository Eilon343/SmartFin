import { useState, useEffect, useCallback } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useI18n } from '../context/I18nContext';
import Icon from './ui/Icon';
import Drawer from './ui/Drawer';
import LogTransaction from './LogTransaction';
import WhatsNewModal from './WhatsNewModal';
import WelcomeModal from './WelcomeModal';
import { shouldShowWhatsNew, markWhatsNewSeen } from '../lib/whatsNew';
import { upgradeNotice, dismissUpgradeNotice } from '../lib/appUpdate';
import Toast from './ui/Toast';
import api from '../api/client';

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
  { id: 'savings',       label: 'Invest', icon: 'piggy-bank',       path: '/savings' },
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
  // Read straight from storage in the initial state rather than an effect, so the tour
  // never flashes in for someone who has already dismissed it.
  const [whatsNewOpen, setWhatsNewOpen] = useState(shouldShowWhatsNew);
  // null until /api/me answers. Tri-state on purpose: "not yet known" has to be distinct
  // from "not needed", or the what's-new tour flashes up in the gap before the welcome
  // resolves and the new user sees the wrong one first.
  const [showWelcome, setShowWelcome] = useState(null);
  // Confirms a silent service-worker update actually landed. upgradeNotice() is
  // idempotent, so StrictMode's double-invoked initialiser cannot swallow it.
  const [upgradedFrom, setUpgradedFrom] = useState(upgradeNotice);

  const displayName = googleProfile?.name || user?.username?.replace(/^@/, '') || 'You';
  // Comes from the JWT, so it is available in the same render that authentication lands.
  const userId = user?.user_id;

  // Whether this ACCOUNT has been welcomed lives on the server, so the tour does not
  // reappear on a second device or after clearing site data.
  //
  // Keyed to the user id rather than firing once on mount. Mount-only was wrong for
  // sign-in *transitions*: Layout can mount in the same commit that authentication
  // resolves, and a /me sent in that window races the token reaching storage. It answered
  // 401, the catch below marked the account "already welcomed", and a genuinely new user
  // never saw the tour. Re-running when the identity changes also covers switching
  // accounts without a reload.
  useEffect(() => {
    if (!userId) return undefined;

    let cancelled = false;

    // One retry, because the only failure worth surviving here is a transient one at the
    // moment of sign-in. A second failure is treated as a real answer.
    const load = (retry = true) => {
      api.get('/me')
        .then(res => { if (!cancelled) setShowWelcome(!res.data.onboarded); })
        .catch(() => {
          if (cancelled) return;
          if (retry) return void setTimeout(() => load(false), 600);
          // Assume welcomed: wrongly skipping an introduction is a far smaller harm than
          // wrongly showing one to an established user every time the network hiccups.
          // onboarded_at stays NULL either way, so a real new user gets it next visit.
          setShowWelcome(false);
        });
    };

    load();
    return () => { cancelled = true; };
  }, [userId]);

  const finishWelcome = useCallback(() => {
    setShowWelcome(false);
    // Retire the what's-new tour in the same breath — see the render comment below.
    markWhatsNewSeen();
    setWhatsNewOpen(false);
    // Fire-and-forget: the tour is already closed, and failing to record it only means it
    // appears once more. Blocking the UI on this would be worse than that.
    api.post('/me/onboarded').catch(() => {});
  }, []);

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

      <Toast
        msg={upgradedFrom ? t('update_toast').replace('{version}', __APP_VERSION__) : ''}
        onDone={() => { dismissUpgradeNotice(); setUpgradedFrom(null); }}
      />

      {/* ── First-run welcome, once per account ── */}
      <WelcomeModal open={showWelcome === true} onFinish={finishWelcome} />

      {/* ── One-time tour for the bank-sync update ──
          Held back until the welcome has been resolved, so a brand-new account is never
          shown two stacked tours. finishWelcome also retires this one: the welcome already
          covers sync, and following an introduction with "what's new" makes no sense to
          someone for whom all of it is new. */}
      <WhatsNewModal
        open={whatsNewOpen && showWelcome === false}
        onClose={() => setWhatsNewOpen(false)}
      />

      {/* ── Log transaction bottom sheet ── */}
      <LogTransaction
        open={logOpen}
        onClose={() => setLogOpen(false)}
        onSaved={handleSaved}
      />
    </div>
  );
}
