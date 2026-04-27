import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GoogleLogin } from '@react-oauth/google';
import { useAuth } from '../context/AuthContext';

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
      <path d="M3.964 10.706A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.962L3.964 6.294C4.672 4.167 6.656 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  );
}

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
          <div style={styles.googleBtnOuter}>
            <div style={styles.googleBtn} className="google-btn">
              <GoogleIcon />
              <span style={styles.googleBtnText}>Continue with Google</span>
            </div>
            <div style={styles.googleOverlay}>
              <GoogleLogin
                onSuccess={handleGoogleSuccess}
                onError={() => setError('Google sign-in failed. Try again.')}
                width="264"
                type="standard"
                shape="rectangular"
                theme="filled_black"
                size="large"
                text="signin_with"
              />
            </div>
          </div>
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
    marginBottom: 20,
  },
  googleBtnOuter: {
    position: 'relative',
    width: '100%',
    height: 48,
  },
  googleBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    width: '100%',
    height: 48,
    background: '#1e2230',
    border: '1px solid #2e3243',
    borderRadius: 12,
    cursor: 'pointer',
    transition: 'background 0.15s, border-color 0.15s',
    boxSizing: 'border-box',
  },
  googleBtnText: {
    fontFamily: 'Inter, sans-serif',
    fontSize: 14,
    fontWeight: 500,
    color: '#cfd2dc',
    letterSpacing: '-0.01em',
  },
  googleOverlay: {
    position: 'absolute',
    inset: 0,
    opacity: 0,
    overflow: 'hidden',
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
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
