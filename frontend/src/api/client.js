import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3000/api',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('sf_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Avoid re-entrant reloads if multiple parallel requests 401 at once
let reloading = false;

// Only wipe the token if the server explicitly rejects it — not on network errors or
// during the initial page load race where the server may not be reachable yet.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const is401 = err.response?.status === 401;
    const hasToken = !!localStorage.getItem('sf_token');
    if (is401 && hasToken && !reloading) {
      reloading = true;
      localStorage.removeItem('sf_token');
      document.cookie = 'sf_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax';
      window.location.reload();
    }
    return Promise.reject(err);
  }
);

export default api;
