// Pure sign-in / sign-up field validation, kept out of the component so it can be tested
// without a JSX transform or a DOM — the same reasoning as services/duplicateMatcher.js.
//
// These checks exist for the speed of the feedback, not for safety: authController.js
// re-validates everything and is the only thing that decides what is accepted.

export const MIN_PASSWORD = 8;

/**
 * Returns an i18n key naming what is actually wrong with the address, or null.
 *
 * A single "enter a valid email" covers every case and helps with none of them — the common
 * failures are a missing @, a typo'd domain, or a stray space pasted from elsewhere, and
 * each has a different fix. Checks run outermost-first so the message names the first thing
 * the user has to correct rather than an incidental consequence of it.
 *
 * Deliberately more permissive than RFC 5322: the goal is catching typos, not adjudicating
 * exotic-but-legal addresses. Anything this accepts still has to satisfy the server.
 */
export function validateEmail(raw) {
  const value = (raw || '').trim();
  if (!value) return 'auth_err_email_empty';
  if (/\s/.test(value)) return 'auth_err_email_space';

  const parts = value.split('@');
  if (parts.length === 1) return 'auth_err_email_at';
  if (parts.length > 2) return 'auth_err_email_at_many';

  const [local, domain] = parts;
  if (!local) return 'auth_err_email_local';
  if (!domain) return 'auth_err_email_domain';
  // A domain with no dot is the "user@gmail" case: it looks finished, but is undeliverable.
  if (!domain.includes('.')) return 'auth_err_email_tld';
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    return 'auth_err_email_domain_shape';
  }
  return null;
}

/**
 * Returns an i18n key, or null.
 *
 * `enforceLength` is true for sign-UP only. On sign-in the stored password may predate the
 * rule, and refusing to submit it would lock an account out of its own front door — only
 * the server is entitled to judge an existing password.
 */
export function validatePassword(raw, enforceLength) {
  const value = raw || '';
  if (!value) return 'auth_err_password_empty';
  if (enforceLength && value.length < MIN_PASSWORD) return 'auth_err_password_short';
  return null;
}
