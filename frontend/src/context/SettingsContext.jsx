import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import { useAuth } from './AuthContext';
import { DEFAULT_SETTINGS } from '../lib/cycle';

/**
 * The user's financial-cycle settings — the two days that decide what a "period" means
 * everywhere in the app.
 *
 * Loaded once, here, rather than per page: every month picker is built from the anchor
 * day, and four pages independently fetching it would let them disagree for a moment.
 *
 * Keyed on the auth token, not on mount alone. `/settings` is an authenticated endpoint,
 * so a session that begins with a login rather than a stored token would otherwise spend
 * its whole life on the anchor-1 fallback the 401 left behind — every picker quoting
 * calendar months at a user whose figures the server is scoping to the 10th. Re-running on
 * the token also drops the previous account's days when someone signs out and back in.
 *
 * `ready` marks the first settled load. Pages derive their period from `settings` rather
 * than copying it into state, so they correct themselves when it arrives; `ready` is for
 * anything that needs to know it is looking at the real anchor and not the fallback.
 *
 * A failed load falls back to anchor 1, which is exactly the pre-cycle calendar month.
 */
const SettingsContext = createContext();

export function SettingsProvider({ children }) {
  const { token } = useAuth();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    if (!token) {
      setSettings(DEFAULT_SETTINGS);
      setReady(true);
      return;
    }
    try {
      const res = await api.get('/settings');
      setSettings(res.data);
    } catch {
      setSettings(DEFAULT_SETTINGS);
    } finally {
      setReady(true);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // Returns the updated settings so the Settings page can render the new cycle without a
  // second round trip; PATCH /api/settings responds with the same body as GET.
  const saveSettings = useCallback(async (patch) => {
    const res = await api.patch('/settings', patch);
    setSettings(res.data);
    return res.data;
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, ready, saveSettings, reloadSettings: load }}>
      {children}
    </SettingsContext.Provider>
  );
}

export const useSettings = () => useContext(SettingsContext);
