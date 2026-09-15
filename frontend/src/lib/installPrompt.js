/**
 * "Add to Home Screen" support.
 *
 * Chromium fires `beforeinstallprompt` once, early, and only if the page grabs it is the
 * install dialog available later from our own button. This module must be imported before
 * React renders (main.jsx) so the event is never missed. Capturing does not block the
 * browser's own install affordances (banner, address-bar icon, menu entry).
 *
 * iOS Safari has no such event — installation is manual via Share → Add to Home Screen,
 * so `getInstallState()` reports `ios-manual` there for the UI to show instructions.
 */

let deferred = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn(getInstallState()));

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Deliberately no preventDefault(): that would suppress Chrome's automatic install
    // banner, and there is no in-app install button yet. The event stays usable from our
    // own UI regardless. Add preventDefault() here once such a button ships.
    deferred = e;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

/** @returns {'installed'|'available'|'ios-manual'|'unavailable'} */
export function getInstallState() {
  if (isStandalone()) return 'installed';
  if (deferred) return 'available';
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  return ios ? 'ios-manual' : 'unavailable';
}

/** Shows the native install dialog. Call from a click handler. Resolves to the user's choice. */
export async function promptInstall() {
  if (!deferred) return 'unavailable';
  const e = deferred;
  deferred = null; // the event can only be used once
  await e.prompt();
  const { outcome } = await e.userChoice;
  notify();
  return outcome; // 'accepted' | 'dismissed'
}

/** Subscribe to state changes; returns an unsubscribe function. */
export function onInstallStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
