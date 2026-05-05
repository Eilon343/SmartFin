import { useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { GoogleOAuthProvider, useGoogleOneTapLogin } from '@react-oauth/google';
import { AuthProvider, useAuth, isIOSStandalone } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Categories from './pages/Categories';
import Subscriptions from './pages/Subscriptions';
import Savings from './pages/Savings';
import Income from './pages/Income';
import Expenses from './pages/Expenses';
import Settings from './pages/Settings';
import Layout from './components/Layout';
import { I18nProvider } from './context/I18nContext';

// Attempts silent Google re-auth when no token in storage (e.g. iOS ITP cleared it)
function AutoGoogleAuth() {
  const { isAuthenticated, autoChecking, googleLogin, finishAutoCheck } = useAuth();
  const loginStarted = useRef(false);

  useGoogleOneTapLogin({
    disabled: isAuthenticated || !autoChecking || isIOSStandalone,
    auto_select: true,
    cancel_on_tap_outside: false,
    onSuccess: async (credentialResponse) => {
      loginStarted.current = true;
      try {
        await googleLogin(credentialResponse.credential);
      } catch {
        finishAutoCheck();
      }
    },
    onError: finishAutoCheck,
  });

  useEffect(() => {
    if (!autoChecking) return;
    // Fallback: if One Tap doesn't respond in 3s, proceed to login page
    const t = setTimeout(() => {
      if (!loginStarted.current) finishAutoCheck();
    }, 3000);
    return () => clearTimeout(t);
  }, [autoChecking, finishAutoCheck]);

  return null;
}

function PrivateRoute({ children }) {
  const { isAuthenticated, autoChecking } = useAuth();
  if (autoChecking) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg-0)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 32, height: 32, border: '3px solid var(--emerald)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
    );
  }
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

// Redirects already-authenticated users away from /login back to the app.
// Needed on iOS PWA: the OS reopens at the last URL, which may be /login,
// even when a valid token is in localStorage.
function PublicRoute({ children }) {
  const { isAuthenticated, autoChecking } = useAuth();
  if (autoChecking) return null;
  return isAuthenticated ? <Navigate to="/" replace /> : children;
}

export default function App() {
  return (
    <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID || ''}>
      <AuthProvider>
        <AutoGoogleAuth />
        <ThemeProvider>
          <I18nProvider>
            <BrowserRouter>
              <Routes>
              <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
              <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
                <Route index element={<Dashboard />} />
                <Route path="categories" element={<Categories />} />
                <Route path="subscriptions" element={<Subscriptions />} />
                <Route path="savings" element={<Savings />} />
                <Route path="income" element={<Income />} />
                <Route path="expenses" element={<Expenses />} />
                <Route path="settings" element={<Settings />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </BrowserRouter>
          </I18nProvider>
        </ThemeProvider>
      </AuthProvider>
    </GoogleOAuthProvider>
  );
}
