import { createContext, useContext, useState } from 'react';
import api from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('sf_token'));

  async function login(userId, pin) {
    const { data } = await api.post('/auth/login', { user_id: userId, pin });
    localStorage.setItem('sf_token', data.token);
    setToken(data.token);
  }

  function logout() {
    localStorage.removeItem('sf_token');
    setToken(null);
  }

  return (
    <AuthContext.Provider value={{ token, login, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
