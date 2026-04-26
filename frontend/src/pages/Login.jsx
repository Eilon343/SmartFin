import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(userId, pin);
      navigate('/');
    } catch {
      setError('Invalid credentials. Check your Telegram user ID and PIN.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>SmartFin</h1>
        <p style={styles.subtitle}>Personal Finance Tracker</p>
        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label}>Telegram User ID</label>
          <input
            style={styles.input}
            type="number"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="938418219"
            required
          />
          <label style={styles.label}>PIN</label>
          <input
            style={styles.input}
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
            required
          />
          {error && <p style={styles.error}>{error}</p>}
          <button style={styles.button} type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles = {
  container: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a' },
  card: { background: '#1e293b', borderRadius: 16, padding: '40px 48px', width: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' },
  title: { color: '#38bdf8', margin: 0, fontSize: 28, fontWeight: 700 },
  subtitle: { color: '#94a3b8', marginTop: 4, marginBottom: 32, fontSize: 14 },
  form: { display: 'flex', flexDirection: 'column', gap: 8 },
  label: { color: '#cbd5e1', fontSize: 13, fontWeight: 500 },
  input: { padding: '10px 14px', borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#f1f5f9', fontSize: 15, outline: 'none' },
  error: { color: '#f87171', fontSize: 13, margin: 0 },
  button: { marginTop: 16, padding: '12px', borderRadius: 8, border: 'none', background: '#38bdf8', color: '#0f172a', fontWeight: 700, fontSize: 15, cursor: 'pointer' },
};
