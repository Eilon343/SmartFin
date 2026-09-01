import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import { DEFAULT_SETTINGS } from '../lib/cycle';

/**
 * The user's financial-cycle settings — the two days that decide what a "period" means
 * everywhere in the app.
 *
 * Loaded once, here, rather than per page: every month picker is built from the anchor
 * day, and four pages independently fetching it would let them disagree for a moment.
 * `ready` is false until the first load settles, and the pages that show a period hold
 * their render until it flips — a dashboard that flashes calendar-month figures and then
 * silently corrects itself is worse than one that takes another moment to appear.
 *
 * A failed load falls back to anchor 1, which is exactly the pre-cycle calendar month.
 */
const SettingsContext = createContext();

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/settings');
      setSettings(res.data);
    } catch {
      setSettings(DEFAULT_SETTINGS);
    } finally {
      setReady(true);
    }
  }, []);

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
