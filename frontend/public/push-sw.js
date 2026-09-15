/* global self, clients */
/**
 * Push-notification handlers, imported into the Workbox-generated service worker via
 * `workbox.importScripts` (see vite.config.js). Kept as a plain classic script because a
 * service worker's importScripts cannot load ES modules.
 *
 * Payload contract — the backend sends JSON (all fields optional except title):
 *   {
 *     "title": "Budget alert",
 *     "body": "You've used 90% of Groceries",
 *     "url": "/budget",            // same-origin path to open on click
 *     "tag": "budget-groceries",   // same tag replaces an older notification instead of stacking
 *     "renotify": false,
 *     "requireInteraction": false,
 *     "silent": false,
 *     "icon": "/pwa-192x192.png",
 *     "badge": "/pwa-64x64.png",
 *     "image": null,
 *     "actions": [{ "action": "open", "title": "View", "url": "/budget" }],
 *     "data": {}                   // anything else the app wants back on click
 *   }
 * A non-JSON payload is shown as the body text under the app name.
 */

const DEFAULT_TITLE = 'SmartFin';
const DEFAULT_ICON = '/pwa-192x192.png';
const DEFAULT_BADGE = '/pwa-64x64.png';

function parsePayload(event) {
  if (!event.data) return { title: DEFAULT_TITLE };
  try {
    const json = event.data.json();
    return json && typeof json === 'object' ? json : { title: DEFAULT_TITLE, body: String(json) };
  } catch {
    return { title: DEFAULT_TITLE, body: event.data.text() };
  }
}

// Only ever open paths on our own origin: a push payload must not be able to turn a
// notification tap into a redirect to some other site.
function safeUrl(raw) {
  try {
    const url = new URL(raw || '/', self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL('/', self.location.origin).href;
  } catch {
    return new URL('/', self.location.origin).href;
  }
}

self.addEventListener('push', (event) => {
  const p = parsePayload(event);
  const actions = Array.isArray(p.actions) ? p.actions : [];

  const options = {
    body: p.body || '',
    icon: p.icon || DEFAULT_ICON,
    badge: p.badge || DEFAULT_BADGE,
    image: p.image || undefined,
    tag: p.tag || undefined,
    renotify: Boolean(p.tag && p.renotify),
    requireInteraction: Boolean(p.requireInteraction),
    silent: Boolean(p.silent),
    timestamp: p.timestamp || Date.now(),
    actions: actions.map(({ action, title, icon }) => ({ action, title, icon })),
    data: {
      ...(p.data || {}),
      url: p.url || '/',
      actionUrls: Object.fromEntries(actions.filter((a) => a.url).map((a) => [a.action, a.url])),
    },
  };

  // waitUntil is mandatory: without it the worker may be killed before the notification is
  // shown, and Chrome then displays its own generic "site updated in the background" one.
  event.waitUntil(self.registration.showNotification(p.title || DEFAULT_TITLE, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = safeUrl((event.action && data.actionUrls?.[event.action]) || data.url);

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((c) => new URL(c.url).origin === self.location.origin);

    if (existing) {
      // Reuse the open window rather than stacking a second one.
      await existing.focus();
      if (existing.url !== target) {
        try { await existing.navigate(target); } catch { /* uncontrolled client — focus is enough */ }
      }
      return;
    }
    await clients.openWindow(target);
  })());
});

// The push service rotated or expired the subscription. Re-subscribe with the same key and
// hand the new one to any open window; the app forwards it to the backend (see lib/push.js).
// With no open window the backend will see the old endpoint fail with 404/410 and should
// drop it; the app re-syncs on its next launch.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const key = event.oldSubscription?.options?.applicationServerKey;
    const next = event.newSubscription
      || (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);

    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of windows) {
      c.postMessage({
        type: 'PUSH_SUBSCRIPTION_CHANGED',
        oldEndpoint: event.oldSubscription?.endpoint || null,
        subscription: next ? next.toJSON() : null,
      });
    }
  })());
});
