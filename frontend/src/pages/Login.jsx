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
        <div style={styles.logoWrap}>
          <div style={styles.logoIcon}>S</div>
        </div>
        <h1 style={styles.title}>SmartFin</h1>
        <p style={styles.subtitle}>Personal Finance OS</p>

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
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#07090d',
  },
  card: {
    background: '#181b24',
    border: '1px solid #242836',
    borderRadius: 20,
    padding: '40px 48px',
    width: 360,
    boxShadow: '0 30px 80px rgba(0,0,0,.6)',
    textAlign: 'center',
  },
  logoWrap: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: 16,
  },
  logoIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    background: 'linear-gradient(135deg, #10b981, #059669)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#ffffff',
    fontWeight: 800,
    fontSize: 22,
    fontFamily: 'Inter, sans-serif',
  },
  title: {
    color: '#f4f5f8',
    margin: 0,
    fontSize: 26,
    fontWeight: 700,
    letterSpacing: '-0.01em',
    fontFamily: 'Inter, sans-serif',
  },
  subtitle: {
    color: '#5b6171',
    marginTop: 4,
    marginBottom: 32,
    fontSize: 13,
    fontFamily: 'Inter, sans-serif',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    fontWeight: 600,
  },
  googleWrapper: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: 20,
  },
  errorBox: {
    background: '#450a0a',
    border: '1px solid #7f1d1d',
    borderRadius: 10,
    padding: '10px 14px',
    marginBottom: 16,
  },
  errorText: {
    color: '#fca5a5',
    fontSize: 13,
    margin: 0,
    textAlign: 'left',
    fontFamily: 'Inter, sans-serif',
  },
  hint: {
    color: '#5b6171',
    fontSize: 12,
    marginTop: 24,
    fontFamily: 'Inter, sans-serif',
    lineHeight: 1.5,
  },
  code: {
    background: '#11141d',
    padding: '2px 6px',
    borderRadius: 6,
    color: '#8a8f9d',
    fontSize: 11,
    fontFamily: 'JetBrains Mono, monospace',
  },
};
