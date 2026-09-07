#!/usr/bin/env node
/**
 * Makes an unrecognised Max plan name a warning instead of a fatal scrape error.
 *
 * WHY THIS EXISTS
 *
 * israeli-bank-scrapers maps each Max transaction's Hebrew `planName` to a transaction
 * type through a hard-coded switch. A name it does not know falls through to
 *
 *     throw new Error(`Unknown transaction type ${cleanedUpTxnTypeStr}`);
 *
 * and that throw happens inside the per-row `forEach` of `fetchTransactionsForMonth`.
 * There is no per-row try/catch anywhere above it, so ONE unknown row aborts the entire
 * scrape: every account, every month, zero transactions imported.
 *
 * Max adds plan names whenever it launches a product. 'תשלומים צמוד דולר'
 * (dollar-linked installments) is one the library has never known — it is still absent
 * in 6.11.0, the latest release — and it took bank sync down completely and permanently:
 * the scheduler retried hourly, hit the same row, and failed the same way every time.
 *
 * The library exports only the scraper factory, so the mapping cannot be overridden from
 * our own code. Patching the installed file is the only seam available.
 *
 * WHAT IT DOES
 *
 * Replaces the `throw` with a warn + fall back to a normal transaction. A wrong *type*
 * on one row is a trivially small error — the type only distinguishes installments from
 * a one-off, and SmartFin does not read it at all (see the staging code in
 * bankSyncScheduler, which keeps date/amount/description/status). Losing every
 * transaction for every account is not.
 *
 * WHY IT FAILS THE BUILD RATHER THAN SKIPPING
 *
 * A patch that silently no-ops is worse than no patch: sync would break again on the
 * next unknown plan name with nobody aware the guard had stopped applying. If the
 * anchor is gone, this exits non-zero so the image build fails and the code below gets
 * re-checked against whatever upstream now ships. Re-running on an already-patched
 * tree is a no-op, so repeated `npm install`s are safe.
 */

const fs = require('fs');
const path = require('path');

const TARGET = path.join(
    __dirname, '..', 'node_modules', 'israeli-bank-scrapers', 'lib', 'scrapers', 'max.js'
);

// The exact line the library ships. Matched verbatim: a loose regex could match some
// future unrelated throw and patch the wrong branch.
const ANCHOR = 'throw new Error(`Unknown transaction type ${cleanedUpTxnTypeStr}`);';

// 'normal' is TransactionTypes.Normal. Inlined as a literal on purpose — the compiled
// file reaches the enum through a minifier-chosen alias (`_transactions2`) that is not
// stable across releases, while the enum's *value* is part of the library's public API.
const REPLACEMENT =
    'console.warn(`israeli-bank-scrapers [SmartFin patch]: unknown Max plan name ' +
        '"${cleanedUpTxnTypeStr}" (planTypeId=${planTypeId}) — imported as a normal ' +
        'transaction. See backend/scripts/patchMaxPlanNames.js`);\n' +
    "          return 'normal';";

const MARKER = '[SmartFin patch]';

function main() {
    if (!fs.existsSync(TARGET)) {
        console.error(`patchMaxPlanNames: ${TARGET} not found — is israeli-bank-scrapers installed?`);
        process.exit(1);
    }

    const source = fs.readFileSync(TARGET, 'utf8');

    if (source.includes(MARKER)) {
        console.log('patchMaxPlanNames: already applied, nothing to do.');
        return;
    }

    if (!source.includes(ANCHOR)) {
        console.error(
            'patchMaxPlanNames: could not find the "Unknown transaction type" throw in\n' +
            `  ${TARGET}\n` +
            'israeli-bank-scrapers has changed. Check whether it now handles unknown Max\n' +
            'plan names on its own; if it does, delete this script and its postinstall hook.\n' +
            'If it does not, update ANCHOR to match the new code. Refusing to build unpatched.'
        );
        process.exit(1);
    }

    fs.writeFileSync(TARGET, source.replace(ANCHOR, REPLACEMENT), 'utf8');
    console.log('patchMaxPlanNames: applied — unknown Max plan names no longer abort a scrape.');
}

main();
