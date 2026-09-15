/**
 * VAPID public keys are distributed as URL-safe base64 (no padding), but
 * PushManager.subscribe() wants the raw bytes. Kept free of browser globals so it can be
 * unit-tested under Node.
 */
export function urlBase64ToUint8Array(base64String) {
  if (typeof base64String !== 'string' || !base64String.trim()) {
    throw new Error('VAPID public key is missing');
  }
  const clean = base64String.trim();
  const padding = '='.repeat((4 - (clean.length % 4)) % 4);
  const base64 = (clean + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
