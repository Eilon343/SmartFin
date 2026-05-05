import { createContext, useContext, useState, useCallback } from 'react';
import api from '../api/client';

const AuthContext = createContext(null);

function decodeJwt(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(atob(base64).split('').map(c =>
      '%' + c.charCodeAt(0).toString(16).padStart(2, '0')
    ).join('')));
  } catch {
    return null;
  }
}

function isExpired(token) {
  const payload = decodeJwt(token);
  if (!payload?.exp) return true;
  return payload.exp * 1000 < Date.now();
}

function getStoredToken() {
  let token = localStorage.getItem('sf_token');
  if (!token) {
    const match = document.cookie.match(/(?:^|;)\s*sf_token=([^;]+)/);
    if (match) {
      token = match[1];
      localStorage.setItem('sf_token', token);
    }
  }
  // Treat expired tokens as missing so autoChecking kicks in and One Tap silently re-auths
  if (token && isExpired(token)) {
    localStorage.removeItem('sf_token');
    document.cookie = 'sf_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax';
    return null;
  }
  return token;
}

function getStoredProfile() {
  try {
    let profileStr = localStorage.getItem('sf_gprofile');
    if (!profileStr) {
      const match = document.cookie.match(/(?:^|;)\s*sf_gprofile=([^;]+)/);
      if (match) {
        profileStr = decodeURIComponent(match[1]);
        localStorage.setItem('sf_gprofile', profileStr);
      }
    }
    return JSON.parse(profileStr || 'null');
  } catch {
    return null;
  }
}

function setStoredToken(token) {
  if (token) {
    localStorage.setItem('sf_token', token);
    document.cookie = `sf_token=${token}; path=/; max-age=31536000; Secure; SameSite=Lax`;
  } else {
    localStorage.removeItem('sf_token');
    document.cookie = 'sf_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax';
  }
}

function setStoredProfile(profile) {
  if (profile) {
    const str = JSON.stringify(profile);
    localStorage.setItem('sf_gprofile', str);
    document.cookie = `sf_gprofile=${encodeURIComponent(str)}; path=/; max-age=31536000; Secure; SameSite=Lax`;
  } else {
    localStorage.removeItem('sf_gprofile');
    document.cookie = 'sf_gprofile=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax';
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(getStoredToken);
  const [googleProfile, setGoogleProfile] = useState(getStoredProfile);
  // true when no stored token — wait for One Tap auto-sign-in attempt before showing login
  const [autoChecking, setAutoChecking] = useState(() => !getStoredToken());
  const user = token ? decodeJwt(token) : null;

  const googleLogin = useCallback(async (idToken) => {
    const { data } = await api.post('/auth/google', { id_token: idToken });
    const gUser = decodeJwt(idToken);
    if (gUser) {
      const profile = { name: gUser.given_name || gUser.name, picture: gUser.picture };
      setStoredProfile(profile);
      setGoogleProfile(profile);
    }
    setStoredToken(data.token);
    setToken(data.token);
    setAutoChecking(false);
  }, []);

  const finishAutoCheck = useCallback(() => setAutoChecking(false), []);

  const logout = useCallback(() => {
    setStoredToken(null);
    setStoredProfile(null);
    setToken(null);
    setGoogleProfile(null);
    setAutoChecking(false);
  }, []);

  return (
    <AuthContext.Provider value={{ token, user, googleProfile, googleLogin, logout, isAuthenticated: !!token, autoChecking, finishAutoCheck }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
