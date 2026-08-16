import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { registerSW } from 'virtual:pwa-register'

/**
 * Last-resort recovery for a client stuck on an old build.
 *
 * The service-worker path below is the normal mechanism, but it depends on browser
 * lifecycle behaviour that does not hold in an installed iOS PWA: one that is resumed
 * rather than launched can stay on a stale bundle indefinitely, and the only way out was
 * deleting and re-adding the app to the home screen.
 *
 * So we ask the server directly what version is deployed. If it disagrees with the bundle
 * we are running, tear down every cache and registration and reload — which is exactly
 * what a manual reinstall did, minus the manual part.
 *
 * Guarded by a once-per-session flag: if a reload somehow does NOT change the running
 * version, this must not become an infinite refresh loop. Failing to update is annoying;
 * a boot loop is unusable.
 */
const HARD_RELOAD_FLAG = 'sf_forced_reload_for';

async function recoverIfStale() {
  let deployed;
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    ({ version: deployed } = await res.json());
  } catch {
    return; // offline, or an older build with no version.json — nothing to do
  }
  if (!deployed || deployed === __APP_VERSION__) return;

  try {
    if (sessionStorage.getItem(HARD_RELOAD_FLAG) === deployed) return; // already tried
    sessionStorage.setItem(HARD_RELOAD_FLAG, deployed);
  } catch { /* storage blocked — proceed, the worst case is one extra reload */ }

  try {
    if (window.caches) {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    await Promise.all(regs.map((reg) => reg.unregister()));
  } catch { /* best effort — reload regardless */ }

  window.location.reload();
}

registerSW({
  onRegisteredSW(swUrl, r) {
    // Runs even when registration failed: that is precisely a case where the service
    // worker cannot rescue itself and the version check is the only way back.
    recoverIfStale();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') recoverIfStale();
    });

    if (!r) return;

    // Reload the moment the new SW claims this client — gets fresh JS chunks.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });


    // Safari caches the SW file aggressively via HTTP cache.
    // Fetching with cache:'no-store' forces a byte-fresh response before update().
    async function checkForUpdate() {
      try { await fetch(swUrl, { cache: 'no-store' }); } catch (_) { /* offline */ }
      await r.update();
    }

    // Check straight away, not only after the first interval tick. An installed PWA is
    // usually resumed rather than launched, so without this the app could sit on a stale
    // build for a full minute after opening — long enough to look like the updater is
    // broken and send you to the browser to check.
    checkForUpdate();

    setInterval(checkForUpdate, 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    });
  },
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
