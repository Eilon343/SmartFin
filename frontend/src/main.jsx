import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { registerSW } from 'virtual:pwa-register'

registerSW({
  onRegisteredSW(swUrl, r) {
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
