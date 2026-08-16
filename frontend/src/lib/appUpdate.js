/**
 * Notices when the app has been updated since this browser last ran it.
 *
 * The service worker updates and reloads silently, which is indistinguishable from a
 * broken updater — you open the app, see the old version number, and conclude nothing is
 * happening. This turns that into a visible confirmation.
 *
 * Detection is by comparing a stored version against the running one, NOT by hooking the
 * reload path: the page that triggers the update is the OLD bundle and cannot know what
 * version is arriving. Comparing after the fact also covers updates that came from a
 * plain browser refresh rather than the service worker.
 */

const KEY = 'sf_app_version';

function computeNotice() {
  try {
    const seen = localStorage.getItem(KEY);
    if (seen === __APP_VERSION__) return null;
    localStorage.setItem(KEY, __APP_VERSION__);
    // No stored version means a first run or a cleared browser — record it, but do not
    // announce an "update" to someone who has never seen an earlier build.
    return seen || null;
  } catch {
    // Private mode or blocked storage: never let a nicety break the app.
    return null;
  }
}

// Evaluated once at import. Keeping it out of React means StrictMode's double-invoked
// initialisers cannot consume the notice before it is rendered.
let notice = computeNotice();

/** The version upgraded FROM, or null. Idempotent — safe to call on every render. */
export function upgradeNotice() {
  return notice;
}

export function dismissUpgradeNotice() {
  notice = null;
}
