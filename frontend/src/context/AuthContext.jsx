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

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('sf_token'));
  const [googleProfile, setGoogleProfile] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sf_gprofile') || 'null'); } catch { return null; }
  });
  const user = token ? decodeJwt(token) : null;

  async function googleLogin(idToken) {
    const gUser = decodeJwt(idToken);
    if (gUser) {
      const profile = { name: gUser.name || gUser.given_name, picture: gUser.picture };
      localStorage.setItem('sf_gprofile', JSON.stringify(profile));
      setGoogleProfile(profile);
    }
    const { data } = await api.post('/auth/google', { id_token: idToken });
    localStorage.setItem('sf_token', data.token);
    setToken(data.token);
  }

  function logout() {
    localStorage.removeItem('sf_token');
    localStorage.removeItem('sf_gprofile');
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
