import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { registerSW } from 'virtual:pwa-register'

// Poll for SW updates every 60 s and on tab focus — critical for iPhone PWA
// which doesn't re-check the SW file unless explicitly told to.
registerSW({
  onRegisteredSW(swUrl, r) {
    if (!r) return;
    // Check once immediately, then every 60 seconds
    setInterval(() => r.update(), 60_000);
    // Also check when the user returns to the app
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') r.update();
    });
  },
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
