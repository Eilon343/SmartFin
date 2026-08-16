import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GoogleLogin } from '@react-oauth/google';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';
import Icon from '../components/ui/Icon';
import { validateEmail, validatePassword, MIN_PASSWORD } from '../lib/authValidation';

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
  const { signup, login, googleLogin } = useAuth();
  const { t, lang, setLang } = useI18n();
  const navigate = useNavigate();

  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // A field is only allowed to show an error once the user has left it (or tried to
  // submit). Validating while someone is still typing "e" flags an address that is merely
  // unfinished, which reads as the form arguing with you.
  const [touched, setTouched] = useState({ email: false, password: false });

  const isSignup = mode === 'signup';

  const emailError = validateEmail(email);
  const passwordError = validatePassword(password, isSignup);
  const showEmailError = touched.email && emailError;
  // The live meter below already communicates "too short", so surfacing it as a red error
  // as well would say the same thing twice in two different tones.
  const showPasswordError = touched.password && passwordError && passwordError !== 'auth_err_password_short';
  const remaining = MIN_PASSWORD - password.length;

  function switchMode(next) {
    setMode(next);
    setError('');
    setTouched({ email: false, password: false });
  }

  // The server's messages are deliberately uniform so they cannot be used to probe which
  // addresses exist. Mapping its error codes to our own copy keeps that property while
  // still showing the user something translated.
  function messageFor(err) {
    const status = err.response?.status;
    const code = err.response?.data?.error;
    if (status === 429) return t('auth_err_ratelimit');
    if (code === 'invalid_credentials') return t('auth_err_credentials');
    if (code === 'signup_unavailable') return t('auth_err_signup');
    if (code === 'invalid_email') return t('auth_err_email_invalid');
    if (code === 'weak_password') return t('auth_err_password_short');
    if (code === 'email_unverified') return t('auth_err_google_unverified');
    return t('auth_err_generic');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    // Reveal any field error the user hasn't seen yet, then stop. The server enforces both
    // rules regardless; this only saves a round-trip on a mistake we can already name.
    if (emailError || passwordError) {
      setTouched({ email: true, password: true });
      return;
    }

    setBusy(true);
    try {
      if (isSignup) await signup(email.trim(), password, name.trim());
      else await login(email.trim(), password);
      navigate('/');
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogleSuccess(credentialResponse) {
    setError('');
    setBusy(true);
    try {
      await googleLogin(credentialResponse.credential);
      navigate('/');
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.container}>
      {/* Language is switchable before sign-in, not only from Settings. The sign-up form is
          the first thing a new user meets, and Settings is behind the very screen they are
          trying to read. Fixed to the viewport corner so it never crowds the card, and
          mirrored under RTL. */}
      <button
        type="button"
        onClick={() => setLang(lang === 'he' ? 'en' : 'he')}
        style={styles.langBtn}
        aria-label={lang === 'he' ? 'Switch to English' : 'החלף לעברית'}
      >
        <Icon name="languages" size={14} />
        {lang === 'he' ? 'EN' : 'עב'}
      </button>

      <div className="card" style={styles.card}>
        <div style={styles.logoWrap}>
          <div style={styles.logoIcon}>S</div>
        </div>
        <h1 style={styles.title}>SmartFin</h1>
        <p style={styles.subtitle}>{t('auth_tagline')}</p>

        <div style={styles.tabs} role="tablist">
          {['signin', 'signup'].map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => switchMode(m)}
              style={{ ...styles.tab, ...(mode === m ? styles.tabActive : null) }}
            >
              {t(m === 'signin' ? 'auth_tab_signin' : 'auth_tab_signup')}
            </button>
          ))}
        </div>

        <h2 style={styles.heading}>{t(isSignup ? 'auth_signup_title' : 'auth_signin_title')}</h2>
        <p style={styles.headingSub}>{t(isSignup ? 'auth_signup_sub' : 'auth_signin_sub')}</p>

        <form className="stack" style={{ gap: 14 }} onSubmit={handleSubmit}>
          {isSignup && (
            <div className="field">
              <label htmlFor="name">{t('auth_name_optional')}</label>
              <input
                id="name"
                className="input"
                type="text"
                value={name}
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="email">{t('auth_email')}</label>
            <input
              id="email"
              className="input"
              // type="text", not "email": the browser's own bubble ("Please enter an email
              // address") would pre-empt our specific message, and its rules disagree with
              // ours on cases like user@gmail.
              type="text"
              inputMode="email"
              dir="ltr"
              value={email}
              placeholder={t('auth_email_ph')}
              autoComplete="email"
              aria-invalid={showEmailError ? 'true' : undefined}
              aria-describedby={showEmailError ? 'email-err' : undefined}
              style={showEmailError ? styles.inputBad : undefined}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched(s => ({ ...s, email: true }))}
            />
            {showEmailError && (
              <span id="email-err" style={styles.fieldErr}>{t(emailError)}</span>
            )}
          </div>

          <div className="field">
            <label htmlFor="password">{t('auth_password')}</label>
            <input
              id="password"
              className="input"
              type="password"
              dir="ltr"
              value={password}
              placeholder={t('auth_password_ph')}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              aria-invalid={showPasswordError ? 'true' : undefined}
              aria-describedby={isSignup ? 'password-hint' : undefined}
              style={showPasswordError ? styles.inputBad : undefined}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => setTouched(s => ({ ...s, password: true }))}
            />

            {/* Sign-up only. A live meter answers "am I there yet?" as the user types,
                so the length rule never has to be delivered as a failure after the fact.
                Sign-in shows nothing: the rule may post-date their password, and telling
                someone their existing password is too short is both wrong and alarming. */}
            {isSignup && (
              <div id="password-hint" style={styles.pwHint}>
                <div style={styles.pwTrack} aria-hidden="true">
                  <div
                    style={{
                      ...styles.pwFill,
                      width: `${Math.min(100, (password.length / MIN_PASSWORD) * 100)}%`,
                      background: password.length >= MIN_PASSWORD ? 'var(--emerald)' : 'var(--amber)',
                    }}
                  />
                </div>
                <span
                  style={{
                    ...styles.pwText,
                    color: password.length >= MIN_PASSWORD ? 'var(--emerald)' : 'var(--text-3)',
                  }}
                >
                  {password.length >= MIN_PASSWORD
                    ? t('auth_pw_ok')
                    : remaining === 1
                      ? t('auth_pw_progress_one')
                      : t('auth_pw_progress').replace('{n}', String(remaining))}
                </span>
              </div>
            )}

            {showPasswordError && (
              <span style={styles.fieldErr}>{t(passwordError)}</span>
            )}
          </div>

          {error && (
            <div style={styles.errorBox} role="alert">
              <p style={styles.errorText}>{error}</p>
            </div>
          )}

          <button className="btn primary" type="submit" disabled={busy} style={styles.submit}>
            {busy ? t('auth_working') : t(isSignup ? 'auth_submit_signup' : 'auth_submit_signin')}
          </button>
        </form>

        <div style={styles.divider}>
          <span style={styles.dividerLine} />
          <span className="muted-2" style={styles.dividerText}>{t('auth_or')}</span>
          <span style={styles.dividerLine} />
        </div>

        {/* The visible button is a decoy sized to the card; the real Google iframe sits on
            top at opacity 0.01 (not 0, which stops Chrome forwarding pointer events). */}
        <div style={styles.googleBtnOuter}>
          <div style={styles.googleBtn} className="google-btn">
            <GoogleIcon />
            <span style={styles.googleBtnText}>{t('auth_google')}</span>
          </div>
          <div className="google-overlay">
            <GoogleLogin
              onSuccess={handleGoogleSuccess}
              onError={() => setError(t('auth_err_google'))}
              type="standard"
              shape="rectangular"
              size="large"
              text="signin_with"
            />
          </div>
        </div>

        <p style={styles.footer}>
          <span className="muted-2">
            {t(isSignup ? 'auth_have_account' : 'auth_no_account')}{' '}
          </span>
          <button
            type="button"
            style={styles.linkBtn}
            onClick={() => switchMode(isSignup ? 'signin' : 'signup')}
          >
            {t(isSignup ? 'auth_tab_signin' : 'auth_tab_signup')}
          </button>
        </p>
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg-1)',
    padding: '24px 16px',
  },
  card: {
    borderRadius: 20,
    padding: '32px 28px',
    width: '100%',
    maxWidth: 380,
    boxShadow: 'var(--pop-shadow)',
    textAlign: 'center',
  },
  logoWrap: { display: 'flex', justifyContent: 'center', marginBottom: 14 },
  logoIcon: {
    width: 48, height: 48, borderRadius: 14,
    background: 'linear-gradient(135deg, #10b981, #059669)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#ffffff', fontWeight: 800, fontSize: 22,
  },
  title: {
    color: 'var(--text-0)', margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em',
  },
  subtitle: {
    color: 'var(--text-3)', marginTop: 4, marginBottom: 22, fontSize: 11,
    textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600,
  },
  tabs: {
    display: 'flex', gap: 4, padding: 4, marginBottom: 20,
    background: 'var(--card-2)', border: '1px solid var(--line)', borderRadius: 12,
  },
  tab: {
    flex: 1, padding: '9px 12px', fontWeight: 600,
    background: 'transparent', border: 'none', borderRadius: 9,
    color: 'var(--text-2)', cursor: 'pointer', font: 'inherit', fontSize: 13,
  },
  tabActive: { background: 'var(--card)', color: 'var(--text-0)', boxShadow: 'var(--shadow-card)' },
  heading: { color: 'var(--text-0)', margin: 0, fontSize: 17, fontWeight: 600 },
  headingSub: { color: 'var(--text-2)', margin: '4px 0 20px', fontSize: 13 },
  submit: { width: '100%', height: 42, justifyContent: 'center', marginTop: 4 },
  langBtn: {
    position: 'fixed', top: 16, insetInlineEnd: 16, zIndex: 5,
    display: 'inline-flex', alignItems: 'center', gap: 6,
    height: 32, padding: '0 12px', borderRadius: 999,
    background: 'var(--card)', border: '1px solid var(--line-2)',
    color: 'var(--text-2)', cursor: 'pointer',
    font: '600 12px Inter, sans-serif',
  },
  inputBad: { borderColor: 'var(--rose)' },
  fieldErr: {
    color: 'var(--rose)', fontSize: 11.5, lineHeight: 1.4,
    textAlign: 'start', marginTop: 2,
  },
  pwHint: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 },
  pwTrack: {
    flex: '0 0 56px', height: 3, borderRadius: 999,
    background: 'var(--track)', overflow: 'hidden',
  },
  pwFill: { height: '100%', borderRadius: 999, transition: 'width .18s ease, background .18s ease' },
  pwText: { fontSize: 11, textAlign: 'start', transition: 'color .18s ease' },
  errorBox: {
    background: 'var(--rose-soft)', border: '1px solid var(--rose)',
    borderRadius: 10, padding: '10px 12px',
  },
  errorText: { color: 'var(--rose)', fontSize: 12.5, margin: 0, textAlign: 'start', lineHeight: 1.45 },
  divider: { display: 'flex', alignItems: 'center', gap: 10, margin: '20px 0 16px' },
  dividerLine: { flex: 1, height: 1, background: 'var(--line)' },
  dividerText: { fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 },
  googleBtnOuter: { position: 'relative', width: '100%', height: 46 },
  googleBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
    width: '100%', height: 46,
    background: 'var(--card-2)', border: '1px solid var(--line-2)',
    borderRadius: 12, cursor: 'pointer', boxSizing: 'border-box',
  },
  googleBtnText: { fontSize: 14, fontWeight: 500, color: 'var(--text-1)', letterSpacing: '-0.01em' },
  footer: { marginTop: 20, marginBottom: 0, fontSize: 12.5 },
  linkBtn: {
    background: 'none', border: 'none', padding: 0, font: 'inherit', fontSize: 12.5,
    color: 'var(--emerald)', fontWeight: 600, cursor: 'pointer',
  },
};
