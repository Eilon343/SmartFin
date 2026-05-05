import { createContext, useContext, useState } from 'react';
import api from '../api/client';

const AuthContext = createContext(null);

function decodeJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch {
    return null;
  }
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
  const user = token ? decodeJwt(token) : null;

  async function googleLogin(idToken) {
    const { data } = await api.post('/auth/google', { id_token: idToken });
    const gUser = decodeJwt(idToken);
    if (gUser) {
      const profile = { name: gUser.given_name || gUser.name, picture: gUser.picture };
      setStoredProfile(profile);
      setGoogleProfile(profile);
    }
    setStoredToken(data.token);
    setToken(data.token);
  }

  function logout() {
    setStoredToken(null);
    setStoredProfile(null);
    setToken(null);
    setGoogleProfile(null);
  }

  return (
    <AuthContext.Provider value={{ token, user, googleProfile, googleLogin, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
