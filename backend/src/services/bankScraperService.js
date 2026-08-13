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
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    try {
        const scraper = createScraper(options);
        const result = await scraper.scrape(credentials);

        if (!result.success) {
            return {
                success: false,
                errorType: result.errorType,
                errorMessage: ERROR_MESSAGES[result.errorType] || result.errorMessage || 'Scraping failed',
            };
        }

        return { success: true, accounts: result.accounts };
    } finally {
        await forceCloseBrowser(browser);
    }
}

module.exports = { scrapeAccount };
