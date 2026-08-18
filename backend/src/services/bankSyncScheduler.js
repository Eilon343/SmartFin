const crypto = require('crypto');
const db = require('../config/db');
const { decrypt } = require('../utils/cryptoUtil');
const { notifyUser } = require('../utils/telegram');
const bankCompanies = require('../config/bankCompanies');
const { scrapeAccount } = require('./bankScraperService');

// A current account shows one lump settlement per card per month ("2624 - ישראכרט בע\"מ"),
// while the card connection shows the individual purchases behind it. Importing both would
// double-count, so a settlement row is skipped — but ONLY when that card is actually
// connected, otherwise the money would vanish from the books entirely.
const CARD_SETTLEMENT_PATTERNS = [
    { companyId: 'isracard', pattern: /ישראכרט|isracard/i },
    { companyId: 'max', pattern: /מקס איט|max it|לאומי קארד/i },
    // "כאל" must stand alone — it is a substring of ordinary words like מיכאל,
    // and a false match here silently deletes a real transaction.
    { companyId: 'visaCal', pattern: /ויזה כאל|כ\.א\.ל|(?<![א-ת])כאל(?![א-ת])|כרטיסי אשראי לישראל/i },
    { companyId: 'amex', pattern: /אמריקן אקספרס|american express|amex/i },
];

/**
 * Money coming back that is NOT income — it reverses spending you already recorded.
 * Classic case: you pay ₪200 for a shared meal, three friends send ₪50 each via Bit,
 * you move it to the bank. Booking that as income inflates earnings and, because
 * P&L uses max(variable_actual, variable_avg), inflates future forecasts too. It is
 * a negative expense instead, mirroring how card refunds are handled.
 *
 * Patterns must be the FULL phrase. Matching bare "ביט" would also match "ביטוח"
 * (insurance) — "מגדל חברה לביטוח" is a real ₪1,000 payment in this account.
 */
const REFUND_PATTERNS = [
    /זיכוי מביט/,   // Bit transfer credited to the account
    /החזר זיכוי/,   // a transfer that bounced and was credited back
];

function isRefund(description) {
    return REFUND_PATTERNS.some((p) => p.test(description || ''));
}

function settlementIssuerOf(description) {
    const match = CARD_SETTLEMENT_PATTERNS.find((p) => p.pattern.test(description || ''));
    return match ? match.companyId : null;
}

/**
 * Decides what a staged transaction becomes. Pure — no DB, no network — so every
 * rule below is unit-testable.
 *
 * @param {object} row  a bank_transactions_raw row joined with its connection's company_id
 * @param {Set<string>} connectedCardIssuers  company ids of cards this user has connected
 * @returns {{action: 'expense'|'income'|'skip', amount: number, reason: string}}
 */
function classifyRow(row, connectedCardIssuers = new Set()) {
    const amount = Number(row.charged_amount);
    const isCard = bankCompanies[row.company_id]?.kind === 'card';

    if (isCard) {
        // Everything on a card is spending. A positive amount is a refund, which becomes
        // a negative expense so it nets out correctly in every SUM().
        return { action: 'expense', amount: -amount, reason: amount > 0 ? 'card_refund' : 'card_purchase' };
    }

    // A bank settlement duplicates the card's own transactions — but only skip it when
    // that card is actually connected, otherwise the money would vanish from the books.
    const issuer = settlementIssuerOf(row.description);
    if (issuer && connectedCardIssuers.has(issuer)) {
        return { action: 'skip', amount: 0, reason: `settlement_of_${issuer}` };
    }

    if (amount < 0) {
        return { action: 'expense', amount: Math.abs(amount), reason: 'bank_debit' };
    }

    // Money in that reverses spending rather than earning it.
    if (isRefund(row.description)) {
        return { action: 'expense', amount: -amount, reason: 'reimbursement' };
    }

    return { action: 'income', amount, reason: 'bank_credit' };
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// How often the scheduler CHECKS whether anything is due — not how often a bank is
// scraped. Most ticks find nothing and cost one indexed query.
const SYNC_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const DRAIN_INTERVAL_MS = 60 * 1000; // 1 minute
const DRAIN_BATCH_SIZE = 40; // categorized in a single Gemini call, so this is 1 request per tick
// When an active connection is scraped, as local wall-clock hours in BANK_TIMEZONE:
// morning and evening, twice a day. A connection is due once it has not synced since
// the most recent of these that has passed, so the times stay put instead of drifting.
//
// This replaced a rolling 24h interval measured from the last SUCCESS. That cadence
// slid a few minutes later every day (each sync's stamp includes however long the
// scrape took), so over a few months the sync time walked all the way around the clock.
const SYNC_HOURS_LOCAL = [7, 19];
const FIRST_SYNC_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000; // 3 months
const INCREMENTAL_OVERLAP_MS = 3 * 24 * 60 * 60 * 1000; // 3 days, late-settling txns
const RETRY_ERRORED_AFTER_MS = 60 * 60 * 1000; // a transient scrape failure gets another go in an hour
const MAX_IMPORT_ATTEMPTS = 3; // tries before a staged row is parked as 'failed'
const BANK_TIMEZONE = 'Asia/Jerusalem';
// A cycle is presumed wedged after this long and the lock is broken. Must comfortably
// exceed one full pass over every connection at SCRAPE_TIMEOUT_MS each.
const STALE_CYCLE_MS = 30 * 60 * 1000;
// Consecutive failed sends before an import notification is given up on, so a
// permanently unreachable chat cannot grow `unannounced` without bound.
const MAX_NOTIFY_ATTEMPTS = 5;

// When the running cycle started, or null when idle. A timestamp rather than a boolean
// so a cycle that somehow never returns cannot leave the flag stuck and silently
// suppress every future sync.
let syncingSince = null;
let cycleToken = 0;
const forceSyncIds = new Set();
// user_id -> { count, parked, attempts } for transactions imported but not yet
// announced, accumulated across drain ticks and RETAINED until Telegram actually
// accepts the message.
const unannounced = new Map();

// A manual sync is a queued request, not an immediate one: the caller registers the
// connection and the next cycle (≤2 min) picks it up. Queuing rather than refusing means
// one user's slow scrape no longer makes every other user's "Sync now" fail.
exports.requestSyncNow = (connectionId) => forceSyncIds.add(connectionId);
exports.isSyncQueued = (connectionId) => forceSyncIds.has(connectionId);

/**
 * Stable identity for a scraped transaction, backing the UNIQUE key on
 * bank_transactions_raw so re-syncing never re-imports the same row.
 *
 * Deliberately content-based. The scraper's `txn.identifier` looks like a transaction
 * id but is NOT one — on Otsar HaHayal it identifies the counterparty/standing order,
 * so 51 real transactions shared only 11 identifiers (every monthly Isracard
 * settlement carries the same one). Keying on it would merge distinct transactions
 * and destroy data.
 *
 * `occurrence` disambiguates genuinely identical transactions — two ₪19.90 coffees at
 * the same shop on the same day are two expenses, not one. It is the index of the
 * transaction among its identical siblings within a single scrape, so a re-sync
 * returning the same list reproduces the same hashes and dedupes correctly.
 */
function hashTxn({ accountNumber, date, chargedAmount, description, occurrence = 0 }) {
    return crypto
        .createHash('sha256')
        .update(`${accountNumber}|${date}|${chargedAmount}|${description}|${occurrence}`)
        .digest('hex');
}

/**
 * The calendar date a scraped transaction belongs to, in the bank's own timezone.
 *
 * The scraper reports each date as Israel-local midnight expressed in UTC —
 * `2026-08-09T00:00+03:00` serializes to `2026-08-08T21:00:00.000Z`. Truncating that
 * ISO string in UTC (`.toISOString().slice(0,10)`) dated EVERY transaction one day
 * early, which silently moved month-boundary transactions into the wrong month and
 * corrupted that month's summaries, budgets and P&L.
 */
function bankDateOf(value) {
    // en-CA formats as YYYY-MM-DD, which is exactly MySQL's DATE literal.
    return new Date(value).toLocaleDateString('en-CA', { timeZone: BANK_TIMEZONE });
}

/**
 * ON DUPLICATE KEY UPDATE rather than INSERT IGNORE: a transaction first seen while
 * still pending must flip to 'completed' when a later scrape returns it settled,
 * otherwise it stays staged forever and the transaction is lost rather than delayed.
 * Only `status`/`raw_json` are refreshed — every other column feeds the hash, so a row
 * that changed anything else is a different transaction by definition.
 */
const STAGE_TXN_QUERY =
    `INSERT INTO bank_transactions_raw
      (bank_connection_id, user_id, external_hash, account_number, txn_date, description, memo, charged_amount, currency, status, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), raw_json = VALUES(raw_json)`;

/**
 * Pending transactions are deliberately left staged. A pending charge can still change
 * its amount or date when it settles (restaurant tips, foreign currency), and since the
 * dedup hash is content-based the settled version arrives as a NEW row — importing the
 * pending one first would double-count the purchase.
 */
const DRAIN_QUERY =
    `SELECT t.*, c.company_id FROM bank_transactions_raw t
     JOIN bank_connections c ON c.id = t.bank_connection_id
     WHERE t.import_status = 'pending_categorization' AND t.status = 'completed'
     ORDER BY t.created_at ASC LIMIT ${DRAIN_BATCH_SIZE}`;

/**
 * The wall-clock fields BANK_TIMEZONE shows at a given instant.
 *
 * The containers run on UTC (nothing sets TZ), so local time cannot be read off a Date
 * directly — Intl is what knows about Israel's DST, which is what makes 07:00 mean 07:00
 * in both winter and summer rather than sliding an hour twice a year.
 */
function zonedParts(instant, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant);
    const at = (type) => Number(parts.find((p) => p.type === type).value);
    return {
        year: at('year'), month: at('month'), day: at('day'),
        hour: at('hour'), minute: at('minute'), second: at('second'),
    };
}

/** How far ahead of UTC `timeZone` runs at `instant`, in ms. */
function zoneOffsetMs(instant, timeZone) {
    const p = zonedParts(instant, timeZone);
    const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    // zonedParts has second resolution, so the comparison must too.
    return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which `timeZone`'s clock reads the given local date at `hour`:00. */
function instantAtLocalHour({ year, month, day }, hour, timeZone) {
    const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
    // The offset depends on the instant, and the instant on the offset. One correction
    // pass settles it everywhere except inside a DST transition itself.
    const firstPass = naive - zoneOffsetMs(new Date(naive), timeZone);
    return new Date(naive - zoneOffsetMs(new Date(firstPass), timeZone));
}

/**
 * The most recent scheduled sync time that has already passed.
 *
 * A connection is due when its last success predates this, which is what pins syncs to
 * SYNC_HOURS_LOCAL instead of letting them drift. Exported for tests.
 */
function lastDueSlot(now = new Date(), timeZone = BANK_TIMEZONE) {
    const hours = [...SYNC_HOURS_LOCAL].sort((a, b) => a - b);
    const local = zonedParts(now, timeZone);

    for (const hour of [...hours].reverse()) {
        if (local.hour >= hour) return instantAtLocalHour(local, hour, timeZone);
    }
    // Before the day's first slot, so the most recent one was yesterday's last. Stepping
    // back 24h can land on a 23h/25h DST day, but never outside the previous calendar
    // day, which is all that is read off it.
    const yesterday = zonedParts(new Date(now.getTime() - 24 * 60 * 60 * 1000), timeZone);
    return instantAtLocalHour(yesterday, hours[hours.length - 1], timeZone);
}

/**
 * Which connections are due for a scrape.
 *
 * 'error' connections MUST be included — a bank timeout is transient, and the failure
 * notification tells the user the next scheduled sync will try again. Excluding them
 * (the original behaviour) meant one blip stopped a connection permanently, until the
 * user happened to press Sync now. They retry on a shorter backoff than the scheduled
 * cadence, paced by last_attempt_at so a persistently failing bank is not hammered.
 *
 * 'invalid_credentials' is deliberately absent: retrying a password the bank already
 * rejected risks locking the real account (most Israeli banks lock after ~3 attempts),
 * so it waits for the user to reconnect.
 */
const DUE_CONNECTIONS_QUERY =
    `SELECT * FROM bank_connections
     WHERE status = 'pending_first_sync'
        OR (status = 'active' AND (last_sync_at IS NULL OR last_sync_at < ?))
        OR (status = 'error'  AND (last_attempt_at IS NULL OR last_attempt_at < ?))
        OR id IN (?)`;

async function getChatId(userId) {
    const [rows] = await db.query('SELECT telegram_chat_id FROM users WHERE user_id = ?', [userId]);
    return rows[0]?.telegram_chat_id || null;
}

/**
 * How far back a scrape should reach.
 *
 * Keyed on last_sync_at, NOT on status: a connection whose first sync failed sits in
 * 'error', and reading that as an incremental sync would look back three days instead
 * of three months and silently skip the entire backfill.
 */
function syncWindowStart(connection, now = Date.now()) {
    if (!connection.last_sync_at) return new Date(now - FIRST_SYNC_LOOKBACK_MS);
    return new Date(new Date(connection.last_sync_at).getTime() - INCREMENTAL_OVERLAP_MS);
}

async function syncConnection(connection) {
    const startDate = syncWindowStart(connection);

    // Stamped before the attempt, separately from last_sync_at (which must keep pointing
    // at the last SUCCESS so the incremental window doesn't shrink past a failure run).
    // This is what paces the retry of an errored connection.
    await db.query('UPDATE bank_connections SET last_attempt_at = NOW() WHERE id = ?', [connection.id]);

    let credentials;
    try {
        credentials = JSON.parse(decrypt(connection.credentials_encrypted));
    } catch (err) {
        console.error(`Bank connection ${connection.id}: failed to decrypt credentials`, err.message);
        await db.query(
            "UPDATE bank_connections SET status='error', last_sync_status=?, last_sync_error=? WHERE id=?",
            ['error', 'Could not decrypt stored credentials', connection.id]
        );
        return;
    }

    const result = await scrapeAccount({ companyId: connection.company_id, credentials, startDate });

    if (!result.success) {
        const status = result.errorType === 'InvalidPassword' ? 'invalid_credentials' : 'error';
        await db.query(
            'UPDATE bank_connections SET status=?, last_sync_status=?, last_sync_error=? WHERE id=?',
            [status, result.errorType || 'error', result.errorMessage, connection.id]
        );

        const chatId = await getChatId(connection.user_id);
        if (status === 'invalid_credentials') {
            // Banks lock accounts after a few bad logins, so auto-sync stays stopped
            // until the user re-enters credentials. Tell them loudly why.
            await notifyUser(
                chatId,
                `🔐 *Bank sync stopped — wrong credentials*\n\n` +
                `${connection.display_name || connection.company_id} rejected the saved username/password.\n\n` +
                `⚠️ Automatic syncing is now *paused* so repeated attempts don't lock your bank account. ` +
                `Most Israeli banks lock after about 3 failed logins.\n\n` +
                `Open SmartFin → Settings → Bank sync, disconnect, and reconnect with the correct details. ` +
                `Please double-check the password on the bank's own website first.`
            );
        } else {
            await notifyUser(
                chatId,
                `⚠️ *Bank sync failed*\n\n` +
                `${connection.display_name || connection.company_id}: ${result.errorMessage}\n\n` +
                `SmartFin will try again on the next scheduled sync.`
            );
        }
        return;
    }

    // Which transactions this connection has already staged. Counting new rows from
    // affectedRows does NOT work: mysql2 connects with CLIENT_FOUND_ROWS, so an
    // ON DUPLICATE KEY UPDATE that merely matched an existing row still reports 1 and
    // every re-sync claimed to have found new transactions.
    const [knownRows] = await db.query(
        'SELECT external_hash FROM bank_transactions_raw WHERE bank_connection_id = ?',
        [connection.id]
    );
    const knownHashes = new Set(knownRows.map((r) => r.external_hash));

    let inserted = 0;
    let seen = 0;
    for (const account of result.accounts) {
        seen += account.txns.length;
        // Counts repeats of otherwise-identical transactions so the fallback identity
        // can tell them apart (see hashTxn).
        const occurrences = new Map();
        for (const txn of account.txns) {
            const contentKey = `${txn.date}|${txn.chargedAmount}|${txn.description}`;
            const occurrence = occurrences.get(contentKey) || 0;
            occurrences.set(contentKey, occurrence + 1);

            const hash = hashTxn({
                accountNumber: account.accountNumber,
                date: txn.date,
                chargedAmount: txn.chargedAmount,
                description: txn.description,
                occurrence,
            });
            const isNew = !knownHashes.has(hash);
            knownHashes.add(hash);

            await db.query(
                STAGE_TXN_QUERY,
                [
                    connection.id,
                    connection.user_id,
                    hash,
                    account.accountNumber,
                    bankDateOf(txn.date),
                    txn.description,
                    txn.memo || null,
                    txn.chargedAmount,
                    txn.chargedCurrency || 'ILS',
                    txn.status,
                    JSON.stringify(txn),
                ]
            );
            if (isNew) inserted++;
        }
    }

    await db.query(
        "UPDATE bank_connections SET status='active', last_sync_at=NOW(), last_sync_status='ok', last_sync_error=NULL WHERE id=?",
        [connection.id]
    );
    console.log(
        `Bank connection ${connection.id}: synced from ${startDate.toISOString().slice(0, 10)}, ` +
        `${result.accounts.length} account(s), ${seen} transactions seen, ${inserted} new`
    );

    if (bankCompanies[connection.company_id]?.kind === 'card') {
        await reconcileSettlements(connection.user_id, connection.company_id);
    }

    if (inserted > 0) {
        await notifyUser(
            await getChatId(connection.user_id),
            `🏦 *Bank sync complete*\n\n` +
            `${connection.display_name || connection.company_id}: *${inserted}* new transaction${inserted === 1 ? '' : 's'} found.\n\n` +
            `They're being categorized now and will appear in SmartFin within a few minutes.`
        );
    }
}

/**
 * When a card is connected after its bank settlements were already imported, those
 * settlement expenses become duplicates of the card's own purchases. Retire them:
 * drop the expense rows and mark the staging rows 'skipped'. Runs once per successful
 * card sync and is idempotent — a second pass finds nothing left to retire.
 */
async function reconcileSettlements(userId, cardCompanyId) {
    const entry = CARD_SETTLEMENT_PATTERNS.find((p) => p.companyId === cardCompanyId);
    if (!entry) return;

    const [rows] = await db.query(
        `SELECT t.id, t.expense_id, t.description FROM bank_transactions_raw t
         JOIN bank_connections c ON c.id = t.bank_connection_id
         WHERE t.user_id = ? AND t.import_status = 'imported' AND t.expense_id IS NOT NULL
           AND c.company_id <> ?`,
        [userId, cardCompanyId]
    );
    const targets = rows.filter((r) => entry.pattern.test(r.description || ''));
    if (targets.length === 0) return;

    for (const row of targets) {
        // Unlink before deleting — bank_transactions_raw.expense_id is a FK.
        await db.query("UPDATE bank_transactions_raw SET import_status='skipped', expense_id=NULL WHERE id=?", [row.id]);
        await db.query('DELETE FROM expenses WHERE expense_id = ? AND source = ?', [row.expense_id, 'bank_sync']);
    }
    console.log(
        `Reconciled ${targets.length} ${cardCompanyId} settlement expense(s) for user ${userId} ` +
        `— replaced by card-level transactions`
    );
}

async function runSyncCycle() {
    if (syncingSince) {
        const runningFor = Date.now() - syncingSince;
        if (runningFor < STALE_CYCLE_MS) return;
        // Every scrape is individually bounded, so reaching this means something else
        // wedged. Pressing on is the lesser evil: the alternative is a lock nobody ever
        // releases and auto-sync that is silently dead until the container restarts.
        console.error(
            `runSyncCycle: previous cycle still running after ${Math.round(runningFor / 60000)} ` +
            `minutes — breaking the lock and starting a new cycle`
        );
    }
    const token = ++cycleToken;
    syncingSince = Date.now();
    try {
        const [connections] = await db.query(
            DUE_CONNECTIONS_QUERY,
            [
                lastDueSlot(),
                new Date(Date.now() - RETRY_ERRORED_AFTER_MS),
                Array.from(forceSyncIds).length ? Array.from(forceSyncIds) : [0],
            ]
        );
        for (const connection of connections) {
            forceSyncIds.delete(connection.id);
            try {
                await syncConnection(connection);
            } catch (err) {
                console.error(`Bank connection ${connection.id}: sync failed`, err);
                await db.query(
                    "UPDATE bank_connections SET status='error', last_sync_status='error', last_sync_error=? WHERE id=?",
                    [err.message, connection.id]
                );
            }
        }
    } catch (err) {
        console.error('runSyncCycle error:', err);
    } finally {
        // Guarded: if this cycle's lock was broken and a newer cycle took over, that
        // newer cycle now owns the flag and this one must not clear it.
        if (cycleToken === token) syncingSince = null;
    }
}

/**
 * Categorizes a whole batch in one request. Bank statements arrive in bulk (a 3-month
 * backfill is 50+ rows), and one Gemini call per row was both slow and needlessly
 * expensive. Returns an array of category names aligned to `descriptions` by index,
 * with null where nothing fits.
 */
async function callGeminiForCategories(descriptions, categoryNames) {
    const numbered = descriptions.map((d, i) => `${i + 1}. ${d}`).join('\n');
    const prompt =
        `You are a bank transaction categorizer for an Israeli bank account. Descriptions may be in Hebrew.\n` +
        `For EACH numbered transaction below, pick the single best matching category from this list: ` +
        `[${categoryNames.join(', ')}].\n` +
        `If nothing fits (e.g. a credit-card settlement, a transfer between own accounts, or an unclear code), use null.\n` +
        `Respond with ONLY a JSON object mapping each number to a category, like ` +
        `{"1": "Food", "2": null, "3": "Transport"}. Include every number from 1 to ${descriptions.length}.\n\n` +
        `Transactions:\n${numbered}`;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { responseMimeType: 'application/json' },
                    }),
                }
            );
            if (!res.ok) {
                const retryable = res.status === 429 || res.status >= 500;
                if (retryable && attempt < 3) {
                    await new Promise((r) => setTimeout(r, 2000 * attempt));
                    continue;
                }
                throw new Error(`Gemini HTTP error: ${res.status}`);
            }
            const data = await res.json();
            const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!raw) throw new Error('Empty Gemini response');
            const parsed = JSON.parse(raw);
            // Only accept names that actually exist, so a hallucinated category
            // can't create junk rows in `categories`.
            return descriptions.map((_, i) => {
                const name = parsed[String(i + 1)];
                return name && categoryNames.includes(name) ? name : null;
            });
        } catch (err) {
            if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 2000 * attempt));
                continue;
            }
            console.error('callGeminiForCategories failed:', err.message);
            return descriptions.map(() => null);
        }
    }
    return descriptions.map(() => null);
}

async function resolveOrCreateCategory(userId, categoryName) {
    const [rows] = await db.query(
        'SELECT category_id FROM categories WHERE (user_id IS NULL OR user_id = ?) AND name = ? LIMIT 1',
        [userId, categoryName]
    );
    if (rows.length > 0) return rows[0].category_id;
    const [ins] = await db.query(
        'INSERT INTO categories (user_id, name, is_base) VALUES (?, ?, FALSE) ON DUPLICATE KEY UPDATE category_id=LAST_INSERT_ID(category_id)',
        [userId, categoryName]
    );
    return ins.insertId;
}

/** `expenses`/`income` date their rows by `created_at`, so it must be written
 *  explicitly from the bank's transaction date — otherwise every imported row
 *  lands on the day the sync ran instead of the day the money moved.
 *
 *  `txn_date` is a DATE column, which mysql2 hands back as a Date at midnight in the
 *  *process* timezone — so it must be read back with local getters. `toISOString()`
 *  would re-interpret that midnight as UTC and shift the date whenever the container
 *  runs on anything east of UTC. */
function txnDateOf(row) {
    if (!(row.txn_date instanceof Date)) return String(row.txn_date).slice(0, 10);
    const d = row.txn_date;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function importExpense(row, amount, categoryName) {
    const categoryId = categoryName ? await resolveOrCreateCategory(row.user_id, categoryName) : null;
    const [ins] = await db.query(
        'INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [row.user_id, amount, row.currency, row.description, categoryId, 'bank_sync', txnDateOf(row)]
    );
    await db.query(
        "UPDATE bank_transactions_raw SET import_status='imported', expense_id=? WHERE id=?",
        [ins.insertId, row.id]
    );
}

async function importIncome(row, amount) {
    const date = txnDateOf(row);
    const [ins] = await db.query(
        "INSERT INTO income (user_id, source, amount, currency, type, month, description, created_at) VALUES (?, 'Bank Sync', ?, ?, 'variable', ?, ?, ?)",
        [row.user_id, amount, row.currency, date.slice(0, 7), row.description, date]
    );
    await db.query(
        "UPDATE bank_transactions_raw SET import_status='imported', income_id=? WHERE id=?",
        [ins.insertId, row.id]
    );
}

async function runCategorizationDrain() {
    try {
        const [rows] = await db.query(
            DRAIN_QUERY
        );
        if (rows.length === 0) return;

        // Which card issuers this user has connected — a bank settlement row is only
        // safe to skip if its purchases are arriving from somewhere else.
        const [cardConns] = await db.query(
            "SELECT DISTINCT user_id, company_id FROM bank_connections WHERE status = 'active'"
        );
        const connectedCards = new Set(
            cardConns
                .filter((c) => bankCompanies[c.company_id]?.kind === 'card')
                .map((c) => `${c.user_id}:${c.company_id}`)
        );

        const issuersFor = (userId) =>
            new Set(
                [...connectedCards]
                    .filter((k) => k.startsWith(`${userId}:`))
                    .map((k) => k.slice(String(userId).length + 1))
            );
        const decisions = new Map(rows.map((r) => [r.id, classifyRow(r, issuersFor(r.user_id))]));

        // Settlements never reach Gemini or the ledger.
        const skipRows = rows.filter((r) => decisions.get(r.id).action === 'skip');
        for (const row of skipRows) {
            await db.query("UPDATE bank_transactions_raw SET import_status='skipped' WHERE id=?", [row.id]);
        }

        const liveRows = rows.filter((r) => decisions.get(r.id).action !== 'skip');
        const expenseRows = liveRows.filter((r) => decisions.get(r.id).action === 'expense');
        const incomeRows = liveRows.filter((r) => decisions.get(r.id).action === 'income');

        // One Gemini call per user, not per transaction. Reimbursements are excluded —
        // "credit from Bit" has no category, and a guess would land in the wrong budget.
        const categorizable = expenseRows.filter((r) => decisions.get(r.id).reason !== 'reimbursement');
        const categoryByRowId = new Map();
        const userIds = [...new Set(categorizable.map((r) => r.user_id))];
        for (const userId of userIds) {
            const userRows = categorizable.filter((r) => r.user_id === userId);
            const [categories] = await db.query(
                'SELECT name FROM categories WHERE user_id IS NULL OR user_id = ? ORDER BY is_base DESC, name',
                [userId]
            );
            const names = await callGeminiForCategories(
                userRows.map((r) => r.description || ''),
                categories.map((c) => c.name)
            );
            userRows.forEach((r, i) => categoryByRowId.set(r.id, names[i]));
        }

        let imported = 0;
        const importedBy = new Map(); // user_id -> count, for the "done" notification
        const parkedBy = new Map();   // user_id -> rows that exhausted their retries NOW
        for (const row of liveRows) {
            try {
                const { action, amount } = decisions.get(row.id);
                if (action === 'expense') {
                    await importExpense(row, amount, categoryByRowId.get(row.id));
                } else {
                    await importIncome(row, amount);
                }
                imported++;
                importedBy.set(row.user_id, (importedBy.get(row.user_id) || 0) + 1);
            } catch (err) {
                // A single failure is usually transient (deadlock, DB blip), so the row
                // goes back in the queue and is only parked as 'failed' once it has
                // genuinely resisted MAX_IMPORT_ATTEMPTS tries. Parking it silently on
                // the first error meant real transactions vanished with no trace
                // anywhere except the container log.
                console.error(`bank_transactions_raw ${row.id}: import failed`, err);
                await db.query(
                    `UPDATE bank_transactions_raw
                     SET import_attempts = import_attempts + 1,
                         import_status = IF(import_attempts + 1 >= ?, 'failed', 'pending_categorization')
                     WHERE id = ?`,
                    [MAX_IMPORT_ATTEMPTS, row.id]
                );
                // Only count it as lost once this attempt was the last one — an earlier
                // attempt that still has retries left may yet succeed, and warning about
                // it would cry wolf.
                if ((row.import_attempts || 0) + 1 >= MAX_IMPORT_ATTEMPTS) {
                    parkedBy.set(row.user_id, (parkedBy.get(row.user_id) || 0) + 1);
                }
            }
        }
        console.log(
            `Categorization drain: ${imported} imported ` +
            `(${expenseRows.length} expense, ${incomeRows.length} income), ` +
            `${skipRows.length} card settlement(s) skipped`
        );

        // Notify only once the user's backlog is fully drained, so a multi-tick
        // import produces one message instead of one per batch. The count has to
        // accumulate across those ticks — reporting only the final batch told a user
        // whose 177-row backfill took five ticks that 40 transactions were imported.
        for (const [userId, count] of importedBy) {
            const pending = unannounced.get(userId) || { count: 0, parked: 0, attempts: 0 };
            pending.count += count;
            unannounced.set(userId, pending);
        }
        // Rows that gave up in THIS drain ride along on the tally, so a notification
        // that has to be retried still carries the warning it was meant to carry.
        // Only users already awaiting a message are touched — a parked row on its own
        // has never triggered a notification and should not start now.
        for (const [userId, parked] of parkedBy) {
            const pending = unannounced.get(userId);
            if (pending) pending.parked += parked;
        }
        for (const [userId, pending] of unannounced) {
            // Pending rows are excluded for the same reason the drain skips them: they
            // are parked until they settle, and would otherwise hold the backlog open
            // forever and suppress the notification entirely.
            const [[{ remaining }]] = await db.query(
                `SELECT COUNT(*) AS remaining FROM bank_transactions_raw
                 WHERE user_id = ? AND import_status = 'pending_categorization' AND status = 'completed'`,
                [userId]
            );
            if (remaining > 0) continue;

            // A row that exhausted its retries is money the user believes was imported,
            // so it is called out in the same message. Only rows that gave up in THIS
            // drain trigger the warning — keying it on the standing 'failed' count would
            // repeat the same complaint after every future sync, with nothing the user
            // could do to clear it.
            const { count: total, parked } = pending;
            const warning = parked > 0
                ? `\n\n⚠️ ${parked} transaction${parked === 1 ? '' : 's'} could not be imported and ` +
                  `${parked === 1 ? 'is' : 'are'} missing from your totals.`
                : '';

            const chatId = await getChatId(userId);
            const delivered = await notifyUser(
                chatId,
                `✅ *Bank transactions added*\n\n` +
                `${total} transaction${total === 1 ? '' : 's'} imported and categorized. ` +
                `Open SmartFin to review them.${warning}`
            );

            // Cleared only once Telegram has actually taken the message. It used to be
            // cleared BEFORE the send, so a one-second network blip destroyed the only
            // signal the user gets that a sync worked — they saw nothing at all and
            // concluded sync was broken. Now it survives to the next tick and retries.
            if (delivered) {
                unannounced.delete(userId);
                continue;
            }
            pending.attempts++;
            if (pending.attempts >= MAX_NOTIFY_ATTEMPTS) {
                console.error(
                    `Categorization drain: giving up on the import notification for user ${userId} ` +
                    `after ${pending.attempts} failed sends (${total} transaction(s) went unannounced)`
                );
                unannounced.delete(userId);
            }
        }
        if (parkedBy.size > 0) {
            console.error('Categorization drain: rows parked as failed by user —', [...parkedBy.entries()]);
        }
    } catch (err) {
        console.error('runCategorizationDrain error:', err);
    }
}

// Pure helpers, exported for unit tests.
exports.classifyRow = classifyRow;
exports.settlementIssuerOf = settlementIssuerOf;
exports.isRefund = isRefund;
exports.hashTxn = hashTxn;
exports.txnDateOf = txnDateOf;
exports.bankDateOf = bankDateOf;
// Exported so the import-eligibility rules can be asserted without a live DB.
exports.DRAIN_QUERY = DRAIN_QUERY;
exports.STAGE_TXN_QUERY = STAGE_TXN_QUERY;
exports.DUE_CONNECTIONS_QUERY = DUE_CONNECTIONS_QUERY;
exports.syncWindowStart = syncWindowStart;
exports.lastDueSlot = lastDueSlot;
exports.SYNC_HOURS_LOCAL = SYNC_HOURS_LOCAL;

exports.start = () => {
    const loop = (fn, interval, label) => {
        const run = async () => {
            // The next tick is queued from `finally`, so an exception must never escape
            // — one throw here and this loop stops for the lifetime of the process.
            try {
                await fn();
            } catch (err) {
                console.error(`${label} loop error:`, err);
            } finally {
                setTimeout(run, interval);
            }
        };
        run();
    };
    console.log(
        `Bank sync scheduled for ${SYNC_HOURS_LOCAL.map((h) => `${String(h).padStart(2, '0')}:00`).join(' and ')} ` +
        `${BANK_TIMEZONE} — next due slot passed at ${lastDueSlot().toISOString()}`
    );
    loop(runSyncCycle, SYNC_INTERVAL_MS, 'runSyncCycle');
    loop(runCategorizationDrain, DRAIN_INTERVAL_MS, 'runCategorizationDrain');
};
