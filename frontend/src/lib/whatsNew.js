/**
 * Which release the in-app tour describes, and whether this browser has seen it.
 *
 * Lives outside the component file so that file exports only a component — mixing the
 * two breaks Vite's fast refresh for the whole module.
 *
 * Pinned to a FEATURE version rather than the app version, so shipping 1.2.1 does not
 * re-open a tour everyone has already read. Bump it only when there is genuinely
 * something new to show.
 */
export const WHATS_NEW_VERSION = '1.2.0';

const STORAGE_KEY = 'sf_seen_whatsnew';

export function shouldShowWhatsNew() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== WHATS_NEW_VERSION;
  } catch {
    // Private mode or blocked storage: never let a tour break the app.
    return false;
  }
}

export function markWhatsNewSeen() {
  try {
    localStorage.setItem(STORAGE_KEY, WHATS_NEW_VERSION);
  } catch {
    // Not worth failing over — worst case the tour appears again next visit.
  }
}
