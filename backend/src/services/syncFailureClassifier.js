/**
 * Turns a raw scrape failure into something a person can act on.
 *
 * The scraper's own output is not usable in a UI. A mistyped Max username produces:
 *
 *   status: 'error', last_sync_status: 'TIMEOUT'
 *   last_sync_error: 'waiting for redirect from https://www.max.co.il/login?ReturnURL=…'
 *
 * which the settings screen rendered as the single word "Error". The user cannot tell
 * that from a genuine outage, and the actual fix — retype the username — is nowhere on
 * screen. This maps that to a `login_failed` code the UI can explain and act on.
 *
 * Pure and dependency-free so the mapping can be tested directly.
 *
 * THE IMPORTANT CASE: a timeout while *still on the login page* is almost never a slow
 * bank. The site rejected the credentials and stayed put, so the redirect the scraper
 * waits for never came. Reporting that as "the bank timed out, we'll retry" sends the
 * user away to wait for a problem that will never clear on its own — and every hourly
 * retry spends another failed login attempt against an account most Israeli issuers
 * lock after about three. A timeout AFTER login is a real transient.
 */

// Substrings that place a failure at the login step. Matched case-insensitively against
// the raw error, which is typically a puppeteer message naming the URL it gave up on.
const LOGIN_PAGE_MARKERS = ['/login', 'redirect', 'signin', 'sign-in', 'connect.aspx'];

function normalise(value) {
    return String(value || '').trim().toLowerCase();
}

/**
 * @param {object} connection - { status, last_sync_status, last_sync_error }
 * @returns {null|{code: string, retrying: boolean, detail: string}}
 *          null when the connection is not in a failed state.
 *          `code` is stable and machine-readable; the UI owns the wording so it can be
 *          translated. `retrying` says whether the scheduler will try again on its own,
 *          which decides whether the user needs to do something now.
 */
function classifySyncFailure(connection) {
    if (!connection) return null;

    const status = normalise(connection.status);
    if (status !== 'error' && status !== 'invalid_credentials' && status !== 'disabled') {
        return null;
    }
    // A disabled connection that never failed was simply switched off by the user.
    if (status === 'disabled' && !connection.last_sync_error && !connection.last_sync_status) {
        return null;
    }

    const type = normalise(connection.last_sync_status);
    const detail = String(connection.last_sync_error || '');
    const rawDetail = normalise(detail);

    // Only an 'error' connection is retried automatically; see DUE_CONNECTIONS_QUERY.
    const retrying = status === 'error';
    const result = (code) => ({ code, retrying, detail });

    // The bank said outright that the credentials are wrong.
    if (status === 'invalid_credentials' || type.includes('invalidpassword')) {
        return { code: 'invalid_credentials', retrying: false, detail };
    }
    if (type.includes('changepassword')) return result('change_password');
    if (type.includes('accountblocked') || type.includes('blocked')) return result('blocked');
    if (type.includes('twofactor')) return result('two_factor');
    if (rawDetail.includes('decrypt')) return result('decrypt');

    if (type.includes('timeout')) {
        // Still on the login page → the credentials were rejected, not a slow site.
        if (LOGIN_PAGE_MARKERS.some((marker) => rawDetail.includes(marker))) {
            return result('login_failed');
        }
        return result('timeout');
    }

    return result('unknown');
}

module.exports = { classifySyncFailure };
