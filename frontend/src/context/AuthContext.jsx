import { createContext, useContext, useState } from 'react';
import api from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('sf_token'));

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
    <AuthContext.Provider value={{ token, googleLogin, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
