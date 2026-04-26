import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GoogleLogin } from '@react-oauth/google';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { googleLogin } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  async function handleGoogleSuccess(credentialResponse) {
    setError('');
    try {
      await googleLogin(credentialResponse.credential);
      navigate('/');
    } catch (err) {
      const msg = err.response?.data?.message || err.response?.data?.error;
      if (err.response?.status === 404) {
        setError(msg || 'Account not linked. Send /link_google your@email.com to the bot first.');
      } else {
        setError('Sign in failed. Please try again.');
      }
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>SmartFin</h1>
        <p style={styles.subtitle}>Personal Finance Tracker</p>

        <div style={styles.googleWrapper}>
          <GoogleLogin
            onSuccess={handleGoogleSuccess}
            onError={() => setError('Google sign-in failed. Try again.')}
            theme="filled_black"
            shape="pill"
            size="large"
            text="signin_with"
          />
        </div>

        {error && (
          <div style={styles.errorBox}>
            <p style={styles.errorText}>{error}</p>
          </div>
        )}

        <p style={styles.hint}>
          First time? Send <code style={styles.code}>/link_google your@email.com</code> to the bot.
        </p>
      </div>
    </div>
  );
}

const styles = {
  container: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a' },
  card: { background: '#1e293b', borderRadius: 16, padding: '40px 48px', width: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.4)', textAlign: 'center' },
  title: { color: '#38bdf8', margin: 0, fontSize: 28, fontWeight: 700 },
  subtitle: { color: '#94a3b8', marginTop: 4, marginBottom: 36, fontSize: 14 },
  googleWrapper: { display: 'flex', justifyContent: 'center', marginBottom: 20 },
  errorBox: { background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 8, padding: '10px 14px', marginBottom: 16 },
  errorText: { color: '#fca5a5', fontSize: 13, margin: 0, textAlign: 'left' },
  hint: { color: '#475569', fontSize: 12, marginTop: 24 },
  code: { background: '#0f172a', padding: '2px 6px', borderRadius: 4, color: '#94a3b8', fontSize: 11 },
};
