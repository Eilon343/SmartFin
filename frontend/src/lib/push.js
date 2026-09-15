/**
 * Client side of Web Push.
 *
 * Responsibilities stop at the browser boundary: detect support, ask permission, create /
 * read / remove the PushSubscription, and mirror it to the backend (/api/push/subscriptions).
 *
 * Platform notes that shape this API:
 *  - iOS/iPadOS (16.4+) only exposes PushManager inside an app installed to the Home
 *    Screen. In Safari tabs `getPushSupport()` reports `needsInstall`.
 *  - Safari and Firefox reject requestPermission() outside a user gesture, and Chrome
 *    quietly blocks sites that prompt on load. Call enablePush() from a click handler.
 *  - The public key comes from VITE_VAPID_PUBLIC_KEY at build time (the private key lives
 *    only on the backend).
 */
import { urlBase64ToUint8Array } from './vapid';
import api from '../api/client';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || '';

const adapter = {
  save: async (sub) => {
    // Subscriptions belong to an account; a signed-out device has nowhere to file one.
    if (!localStorage.getItem('sf_token')) return;
    await api.post('/push/subscriptions', sub);
  },
  remove: (endpoint) => api.delete('/push/subscriptions', { data: { endpoint } }),
};

/** Asks the backend to push a test notification to every device on this account. */
export function sendTestPush() {
  return api.post('/push/test');
}

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOS() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

/**
 * @returns {{ supported: boolean, reason: null|'no-service-worker'|'no-push'|'needs-install'|'no-key'|'insecure', permission: NotificationPermission|'unsupported' }}
 */
export function getPushSupport() {
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  const result = (supported, reason) => ({ supported, reason, permission });

  if (!window.isSecureContext) return result(false, 'insecure');
  if (!('serviceWorker' in navigator)) return result(false, 'no-service-worker');
  if (!('PushManager' in window) || !('Notification' in window)) {
    return result(false, isIOS() && !isStandalone() ? 'needs-install' : 'no-push');
  }
  if (!VAPID_PUBLIC_KEY) return result(false, 'no-key');
  return result(true, null);
}

/** Resolves to 'granted' | 'denied' | 'default'. Must be called from a user gesture. */
export async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  // Older Safari only supports the callback form; the promise form returns undefined there.
  return new Promise((resolve) => {
    const maybe = Notification.requestPermission(resolve);
    if (maybe?.then) maybe.then(resolve);
  });
}

async function registration() {
  // `ready` never rejects; it waits until a worker is active (registered in main.jsx).
  return navigator.serviceWorker.ready;
}

/** The current subscription, or null. Does not prompt. */
export async function getPushSubscription() {
  if (!getPushSupport().supported) return null;
  const reg = await registration();
  return reg.pushManager.getSubscription();
}

function sameKey(subscription) {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true; // browser doesn't expose it — assume it matches
  const expected = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
  const actual = new Uint8Array(current);
  return actual.length === expected.length && actual.every((b, i) => b === expected[i]);
}

/**
 * Ask permission (if needed), subscribe, and hand the subscription to the server adapter.
 * Idempotent: re-running reuses an existing subscription and re-syncs it.
 * @returns {Promise<{ ok: true, subscription: PushSubscriptionJSON } | { ok: false, reason: string }>}
 */
export async function enablePush() {
  const support = getPushSupport();
  if (!support.supported) return { ok: false, reason: support.reason };

  const permission = await requestNotificationPermission();
  if (permission !== 'granted') return { ok: false, reason: permission === 'denied' ? 'denied' : 'dismissed' };

  try {
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();

    // A subscription made with a rotated VAPID key can no longer be pushed to by the backend.
    if (sub && !sameKey(sub)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, // required by Chrome/Safari: every push must show a notification
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const json = sub.toJSON();
    await adapter.save(json);
    return { ok: true, subscription: json };
  } catch (err) {
    return { ok: false, reason: err?.name === 'NotAllowedError' ? 'denied' : 'subscribe-failed' };
  }
}

/** Remove the browser subscription and tell the server. Safe to call when not subscribed. */
export async function disablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const { endpoint } = sub;
    await sub.unsubscribe();
    await adapter.remove(endpoint);
  } catch { /* best effort: a stale endpoint is dropped by the backend on its first 410 */ }
}

/**
 * Keeps the server in step with the browser. Call once at startup: forwards subscriptions
 * the service worker renewed (pushsubscriptionchange) and re-syncs the current one, which
 * also covers a renewal that happened while no window was open.
 */
export function initPushSync() {
  if (!getPushSupport().supported) return;

  navigator.serviceWorker.addEventListener('message', async (event) => {
    if (event.data?.type !== 'PUSH_SUBSCRIPTION_CHANGED') return;
    try {
      if (event.data.oldEndpoint) await adapter.remove(event.data.oldEndpoint);
      if (event.data.subscription) await adapter.save(event.data.subscription);
    } catch { /* retried by the next startup sync */ }
  });

  if (Notification.permission === 'granted') {
    getPushSubscription()
      .then((sub) => sub && adapter.save(sub.toJSON()))
      .catch(() => {});
  }
}
