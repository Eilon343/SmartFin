import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Layout() {
  const { logout } = useAuth();
  return (
    <div style={styles.shell}>
      <nav style={styles.nav}>
        <span style={styles.logo}>SmartFin</span>
        <div style={styles.links}>
          <NavLink to="/" end style={navStyle}>Dashboard</NavLink>
          <NavLink to="/expenses" style={navStyle}>Expenses</NavLink>
        </div>
        <button onClick={logout} style={styles.logoutBtn}>Sign out</button>
      </nav>
      <main style={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}

function navStyle({ isActive }) {
  return {
    color: isActive ? '#38bdf8' : '#94a3b8',
    textDecoration: 'none',
    fontSize: 14,
    fontWeight: 500,
  };
}

const styles = {
  shell: { minHeight: '100vh', background: '#0f172a', display: 'flex', flexDirection: 'column', fontFamily: 'sans-serif' },
  nav: { display: 'flex', alignItems: 'center', gap: 24, padding: '0 32px', height: 56, borderBottom: '1px solid #1e293b', background: '#0f172a' },
  logo: { color: '#38bdf8', fontWeight: 700, fontSize: 18, marginRight: 'auto' },
  links: { display: 'flex', gap: 24 },
  logoutBtn: { padding: '5px 14px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 },
  main: { flex: 1, padding: '0' },
};
