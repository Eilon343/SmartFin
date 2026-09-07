const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
    SCRAPER_ERROR_TYPES, ERROR_MESSAGES,
} = require('../../backend/src/services/bankScraperService');

/**
 * The bug these cover.
 *
 * A Max card started returning the plan name 'תשלומים צמוד דולר' (dollar-linked
 * installments). israeli-bank-scrapers does not know it, throws from inside the per-row
 * loop, and one unknown row aborts the whole scrape — every account, every month.
 * The scheduler then retried hourly and forwarded the scraper's raw internal message
 * to Telegram verbatim, so the user got
 *
 *     ⚠️ Bank sync failed
 *     Max: Unknown transaction type תשלומים צמוד דולר
 *
 * once an hour, forever, while importing nothing.
 */

describe('scraper error types — the values the library really emits', () => {
    // Straight from israeli-bank-scrapers' ScraperErrorTypes enum. If a library upgrade
    // renames one of these, the mapping below goes quiet again and raw scraper text
    // starts reaching users, so pin the exact strings we depend on.
    const EMITTED = [
        'INVALID_PASSWORD', 'CHANGE_PASSWORD', 'TIMEOUT',
        'ACCOUNT_BLOCKED', 'TWO_FACTOR_RETRIEVER_MISSING', 'GENERIC', 'GENERAL_ERROR',
    ];

    it.each(EMITTED)('has a human-readable message for %s', (errorType) => {
        expect(ERROR_MESSAGES[errorType]).toBeTruthy();
    });

    it('is keyed by enum values, not enum member names', () => {
        // The original table was keyed 'InvalidPassword' / 'Generic'. Nothing ever
        // looked those up, which is exactly how the raw message escaped.
        expect(ERROR_MESSAGES.InvalidPassword).toBeUndefined();
        expect(ERROR_MESSAGES.Generic).toBeUndefined();
    });

    it('exposes the constants the scheduler compares against', () => {
        expect(SCRAPER_ERROR_TYPES.INVALID_PASSWORD).toBe('INVALID_PASSWORD');
        expect(SCRAPER_ERROR_TYPES.TIMEOUT).toBe('TIMEOUT');
    });

    // The whole point: a GENERIC failure must be described in our own words. Without
    // this, whatever the scraper threw — a Hebrew plan name, a puppeteer selector, a
    // stack fragment — is what lands in the user's chat.
    it('never lets a GENERIC failure fall through to the raw scraper message', () => {
        const raw = 'Unknown transaction type תשלומים צמוד דולר';
        const shown = ERROR_MESSAGES[SCRAPER_ERROR_TYPES.GENERIC] || raw;
        expect(shown).toBe('Scraping failed for an unknown reason');
        expect(shown).not.toContain('תשלומים');
    });
});

describe('patchMaxPlanNames — unknown Max plan names must not abort a scrape', () => {
    const SCRIPT = path.join(__dirname, '../../backend/scripts/patchMaxPlanNames.js');
    const REAL_MAX = path.join(
        __dirname, '../../backend/node_modules/israeli-bank-scrapers/lib/scrapers/max.js'
    );

    // Runs the script against a throwaway tree so the test never mutates node_modules.
    const runOn = (contents) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maxpatch-'));
        const dir = path.join(root, 'node_modules/israeli-bank-scrapers/lib/scrapers');
        fs.mkdirSync(dir, { recursive: true });
        fs.mkdirSync(path.join(root, 'scripts'));
        const copy = path.join(root, 'scripts/patchMaxPlanNames.js');
        fs.copyFileSync(SCRIPT, copy);
        const target = path.join(dir, 'max.js');
        fs.writeFileSync(target, contents);
        const run = () => execFileSync(process.execPath, [copy], { encoding: 'utf8' });
        return { run, read: () => fs.readFileSync(target, 'utf8') };
    };

    const PRISTINE = [
        'function getTransactionType(planName, planTypeId) {',
        '  const cleanedUpTxnTypeStr = planName.replace(\'\\t\', \' \').trim();',
        '        default:',
        '          throw new Error(`Unknown transaction type ${cleanedUpTxnTypeStr}`);',
        '}',
    ].join('\n');

    it('replaces the throw with a fallback', () => {
        const { run, read } = runOn(PRISTINE);
        run();
        const patched = read();
        expect(patched).not.toContain('throw new Error(`Unknown transaction type');
        expect(patched).toContain("return 'normal';");
    });

    it('is idempotent, so repeated installs are safe', () => {
        const { run, read } = runOn(PRISTINE);
        run();
        const once = read();
        expect(run()).toContain('already applied');
        expect(read()).toBe(once);
    });

    // A patch that silently no-ops is worse than none: sync would break again on the
    // next unknown plan name with nobody aware the guard had stopped applying.
    it('fails loudly when the library no longer matches, instead of skipping', () => {
        const { run } = runOn('function getTransactionType() { return "normal"; }');
        expect(run).toThrow();
    });

    it('leaves the installed library patched', () => {
        if (!fs.existsSync(REAL_MAX)) return; // backend deps not installed
        const src = fs.readFileSync(REAL_MAX, 'utf8');
        expect(src).not.toContain('throw new Error(`Unknown transaction type');
    });
});
