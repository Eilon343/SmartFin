const { createScraper } = require('israeli-bank-scrapers');

const ERROR_MESSAGES = {
    InvalidPassword: 'Invalid username/password',
    ChangePassword: 'Bank requires a password change before scraping can continue',
    Timeout: 'Bank website timed out',
    AccountBlocked: 'Bank account appears to be blocked',
    TwoFactorRetrieverMissing: 'This bank requires two-factor authentication, which is not supported yet',
    Generic: 'Scraping failed for an unknown reason',
    General: 'Scraping failed for an unknown reason',
};

// Chromium runs as root inside the backend container, which it refuses to do with its
// sandbox enabled. --disable-dev-shm-usage keeps it off Docker's 64MB /dev/shm, which
// Chromium otherwise exhausts and crashes on. --disable-crash-reporter stops the
// crashpad handler processes that were being left behind after every scrape.
const CONTAINER_BROWSER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
];

const CLOSE_TIMEOUT_MS = 10000;

/**
 * How long a single scrape may run before it is abandoned.
 *
 * Nothing in the library bounds a scrape, and an unbounded one is not merely slow — it
 * is fatal to auto-sync as a whole. The scheduler queues its next cycle only after the
 * current one resolves, while holding a "busy" flag, so one bank page that hangs stops
 * syncing for EVERY user until the container is restarted, with no error and no log
 * line to notice. Generous enough for a slow three-month backfill.
 */
const SCRAPE_TIMEOUT_MS = 5 * 60 * 1000;

class ScrapeTimeoutError extends Error {}

/**
 * Rejects with a ScrapeTimeoutError if `promise` has not settled within `ms`.
 *
 * The losing promise keeps running — it cannot be cancelled — so its eventual rejection
 * is swallowed here. Left unhandled it would surface as an unhandled rejection and, on
 * Node 20's default, take the whole API process down long after the scrape was given up on.
 */
function withTimeout(promise, ms, message) {
    let timer;
    promise.catch(() => {});
    const expiry = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ScrapeTimeoutError(message)), ms);
    });
    return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Guarantees the browser process is gone once a scrape finishes.
 *
 * The library does close the browser in its own `terminate()`, but that isn't enough:
 * `scrape()` can throw before `terminate()` is reached, and the library's cleanup
 * helper swallows a failed `browser.close()` silently — leaving a live Chromium with
 * no error to notice. On a nightly-syncing box those accumulate until the container
 * exhausts its memory or PID budget, which takes the whole API down, not just sync.
 *
 * So: always await close, bound it with a timeout in case it hangs, then SIGKILL the
 * process if it somehow survived.
 */
async function forceCloseBrowser(browser) {
    if (!browser) return;
    const proc = typeof browser.process === 'function' ? browser.process() : null;

    try {
        await Promise.race([
            browser.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('browser.close() timed out')), CLOSE_TIMEOUT_MS)),
        ]);
    } catch (err) {
        console.error('Bank scraper: browser close failed, killing process —', err.message);
    }

    if (proc && proc.exitCode === null && proc.signalCode === null && !proc.killed) {
        try {
            proc.kill('SIGKILL');
        } catch (err) {
            console.error('Bank scraper: could not kill browser process —', err.message);
        }
    }
}

/**
 * Logs what a rejected navigation actually returned.
 *
 * The library reduces a failed navigation to 'Failed to navigate to url <url>, status
 * code: <n>' and drops the response itself, which is the only thing that says WHY.
 * Isracard sits behind Cloudflare bot management, so the discriminating evidence is in
 * the response headers — 'cf-mitigated' names a bot decision outright and 'cf-ray'
 * identifies the request in Cloudflare's own logs — plus the first bytes of the body,
 * which separate a challenge page from a plain origin error.
 *
 * Attached via 'preparePage', which the library runs before login, so it is in place
 * for the very first navigation — the one that is failing. Document responses only: a
 * blocked page drags in a pile of failed subresources, and logging every one of them
 * buries the single line that matters.
 */
function attachFailureCapture(page, companyId) {
    page.on('response', (response) => {
        void (async () => {
            try {
                if (response.ok() || response.request().resourceType() !== 'document') return;
                const headers = response.headers();
                let body;
                try {
                    body = (await response.text()).slice(0, 300).replace(/\s+/g, ' ');
                } catch {
                    body = '<body unavailable>';
                }
                console.error(
                    `Bank scraper: ${companyId} — ${response.status()} on ${response.url()}\n` +
                    `  cf-ray=${headers['cf-ray'] || '-'} ` +
                    `cf-mitigated=${headers['cf-mitigated'] || '-'} ` +
                    `server=${headers.server || '-'}\n` +
                    `  ua-sent=${response.request().headers()['user-agent'] || '-'}\n` +
                    `  body=${body}`
                );
            } catch {
                // Diagnostics must never be the thing that fails a scrape.
            }
        })();
    });
}

async function scrapeAccount({ companyId, credentials, startDate }) {
    let browser = null;

    const options = {
        companyId,
        startDate,
        combineInstallments: true,
        showBrowser: false,
        args: CONTAINER_BROWSER_ARGS,
        // The library's only hook that hands back the browser it launched.
        prepareBrowser: (launched) => { browser = launched; },
        // Diagnostic only — see attachFailureCapture.
        preparePage: (page) => attachFailureCapture(page, companyId),
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    try {
        const scraper = createScraper(options);
        const result = await withTimeout(
            scraper.scrape(credentials),
            SCRAPE_TIMEOUT_MS,
            `Bank scrape exceeded ${SCRAPE_TIMEOUT_MS / 60000} minutes and was abandoned`
        );

        if (!result.success) {
            return {
                success: false,
                errorType: result.errorType,
                errorMessage: ERROR_MESSAGES[result.errorType] || result.errorMessage || 'Scraping failed',
            };
        }

        return { success: true, accounts: result.accounts };
    } catch (err) {
        if (!(err instanceof ScrapeTimeoutError)) throw err;
        // Reported as the library's own 'Timeout' type so it flows through the normal
        // transient-failure path and is retried on the usual backoff.
        //
        // The wording matters: syncFailureClassifier reads '/login', 'redirect' and
        // 'signin' in the error detail as "stuck on the login page", which parks the
        // connection as a credentials problem and STOPS the retries. None of those
        // words may appear here — an abandoned scrape is not a rejected password.
        console.error(`Bank scraper: ${companyId} —`, err.message);
        return { success: false, errorType: 'Timeout', errorMessage: err.message };
    } finally {
        // Runs on the timeout path too, which is the point: `prepareBrowser` has
        // already handed us the Chromium the abandoned scrape is still holding, and
        // nothing else will ever close it.
        await forceCloseBrowser(browser);
    }
}

module.exports = { scrapeAccount, SCRAPE_TIMEOUT_MS };
