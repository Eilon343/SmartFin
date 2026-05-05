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

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && !reloading) {
      reloading = true;
      localStorage.removeItem('sf_token');
      document.cookie = 'sf_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax';
      // Reload current page so AutoGoogleAuth + One Tap silently re-auths.
      // If Google session is gone, falls through to /login after the 3s timeout.
      window.location.reload();
    }
    return Promise.reject(err);
  }
);

export default api;
