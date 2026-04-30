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
  const user = token ? decodeJwt(token) : null;

  async function googleLogin(idToken) {
    const { data } = await api.post('/auth/google', { id_token: idToken });
    localStorage.setItem('sf_token', data.token);
    setToken(data.token);
  }

  function logout() {
    localStorage.removeItem('sf_token');
    setToken(null);
  }

  return (
    <AuthContext.Provider value={{ token, user, googleLogin, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
