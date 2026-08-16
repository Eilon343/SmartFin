const db = require('../config/db');
const crypto = require('crypto');
const { matchDuplicates, USER_ENTERED_SOURCES } = require('../services/duplicateMatcher');

/**
 * Duplicate cleanup: removing hand-logged rows that bank/card sync now imports itself.
 *
 * Shape of the flow, and why:
 *
 *  GET  /api/cleanup/duplicates  — preview. Returns the actual PAIRS, not a count.
 *  POST /api/cleanup/duplicates  — archive the ids the user ticked. The client sends
 *                                  explicit ids, so a sync that lands between preview and
 *                                  confirm can never widen the deletion beyond what was
 *                                  shown and approved.
 *  GET  /api/cleanup/archive     — what is still restorable.
 *  POST /api/cleanup/restore     — put a batch, or single rows, back.
 *
 * Nothing here is a hard DELETE. Rows move to `deleted_expenses` / `deleted_income` and
 * are purged after RESTORE_WINDOW_DAYS. See migrate_008 for why an archive table rather
 * than a deleted_at flag.
 */

const RESTORE_WINDOW_DAYS = 30;

// Column lists are read from INFORMATION_SCHEMA rather than hard-coded so archive and
// restore keep working when a column is added to expenses/income. Cached per process —
// the schema does not change under a running backend.
const columnCache = new Map();
async function liveColumns(table) {
    if (columnCache.has(table)) return columnCache.get(table);
    const [rows] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [table]
    );
    const cols = rows.map((r) => r.COLUMN_NAME);
    columnCache.set(table, cols);
    return cols;
}

// ── Gathering the two sides ──────────────────────────────────────────────────

/**
 * Hand-logged expenses: what a person entered themselves.
 * is_virtual rows are savings transfers, not spending, and no bank feed will ever
 * contain them — they must never become deletion candidates.
 */
async function loadLoggedExpenses(user_id) {
    const placeholders = USER_ENTERED_SOURCES.map(() => '?').join(', ');
    const [rows] = await db.query(
        `SELECT e.expense_id AS id, e.amount, DATE(e.created_at) AS date, e.description,
                e.source, e.category_id, c.name AS category_name
           FROM expenses e
           LEFT JOIN categories c ON e.category_id = c.category_id
          WHERE e.user_id = ? AND e.source IN (${placeholders}) AND e.is_virtual = FALSE`,
        [user_id, ...USER_ENTERED_SOURCES]
    );
    return rows;
}

/**
 * Imported expenses, taken from the staging table rather than from `expenses.source`.
 *
 * Only staged rows that actually became an expense count. A skipped credit-card
 * settlement (`2624 - ישראכרט בע"מ`) has no expense_id: it is the lump monthly bill, not
 * the purchase, and letting it act as a counterpart would authorise deleting a real
 * hand-logged row against money that was never separately imported.
 *
 * The amount comes from the imported EXPENSE row, not from `charged_amount`. Both sides
 * of the comparison are then the same quantity — what SmartFin actually recorded — and
 * anything classifyRow() did on the way in is already reflected in it. Using the staged
 * amount instead needed an ABS() to flip debits positive, and that silently broke
 * reimbursements: a credit like `זיכוי` arrives as a POSITIVE charged_amount and is
 * written as a NEGATIVE expense, so ABS() compared +250 against −250 and never matched.
 */
async function loadSyncedExpenses(user_id) {
    const [rows] = await db.query(
        `SELECT t.expense_id AS id, e.amount AS amount, t.txn_date AS date,
                t.description, t.account_number AS account
           FROM bank_transactions_raw t
           JOIN expenses e ON e.expense_id = t.expense_id
          WHERE t.user_id = ? AND t.import_status = 'imported' AND t.expense_id IS NOT NULL`,
        [user_id]
    );
    return rows;
}

/**
 * Income has no provenance column — `income.source` is a user-facing label like
 * 'Salary', not an origin. Provenance comes from the staging table instead: an income row
 * is imported exactly when a bank_transactions_raw row points at it, and hand-logged
 * otherwise. That needs no schema change.
 */
async function loadLoggedIncome(user_id) {
    const [rows] = await db.query(
        `SELECT i.income_id AS id, i.amount, DATE(i.created_at) AS date,
                i.description, i.source, i.type, i.month
           FROM income i
           LEFT JOIN bank_transactions_raw t
                  ON t.income_id = i.income_id AND t.import_status = 'imported'
          WHERE i.user_id = ? AND t.id IS NULL`,
        [user_id]
    );
    return rows;
}

// Amount taken from the imported income row for the same reason as above: it is the
// figure SmartFin recorded, so both sides of the comparison mean the same thing.
async function loadSyncedIncome(user_id) {
    const [rows] = await db.query(
        `SELECT t.income_id AS id, i.amount AS amount, t.txn_date AS date,
                t.description, t.account_number AS account
           FROM bank_transactions_raw t
           JOIN income i ON i.income_id = t.income_id
          WHERE t.user_id = ? AND t.import_status = 'imported' AND t.income_id IS NOT NULL`,
        [user_id]
    );
    return rows;
}

// ── Preview ──────────────────────────────────────────────────────────────────

function summarise({ matched, unmatched }) {
    const sum = (rows) => Math.round(rows.reduce((t, r) => t + Number(r.amount), 0) * 100) / 100;
    return {
        matched,
        matched_count: matched.length,
        matched_amount: sum(matched),
        // The full unmatched list is not sent — it can be hundreds of rows the user is
        // not being asked to decide anything about. A sample is enough to show the rule
        // is working ("cash and Bit were left alone").
        unmatched_sample: unmatched.slice(0, 8),
        unmatched_count: unmatched.length,
        unmatched_amount: sum(unmatched),
    };
}

exports.getDuplicates = async (req, res) => {
    const user_id = req.user.user_id;
    try {
        const [loggedExp, syncedExp, loggedInc, syncedInc] = await Promise.all([
            loadLoggedExpenses(user_id),
            loadSyncedExpenses(user_id),
            loadLoggedIncome(user_id),
            loadSyncedIncome(user_id),
        ]);

        res.json({
            expenses: summarise(matchDuplicates(loggedExp, syncedExp)),
            income: summarise(matchDuplicates(loggedInc, syncedInc)),
            restore_window_days: RESTORE_WINDOW_DAYS,
            // Nothing imported yet means there is nothing to compare against, and every
            // hand-logged row correctly looks unmatched. Say so, so the UI can explain
            // an empty result instead of implying the data is clean.
            has_synced_data: syncedExp.length > 0 || syncedInc.length > 0,
        });
    } catch (err) {
        console.error('getDuplicates error:', err);
        res.status(500).json({ error: 'Failed to find duplicates' });
    }
};

// ── Archive (the "delete") ───────────────────────────────────────────────────

/**
 * Moves one row into its archive table, preserving the primary key so a restore is an
 * exact put-back rather than a new row wearing the old data.
 */
async function archiveRow(conn, { table, archive, pk, id, user_id, batch_id, matched_row_id }) {
    const cols = await liveColumns(table);
    const list = cols.map((c) => `\`${c}\``).join(', ');
    await conn.query(
        `INSERT INTO ${archive} (${list}, batch_id, matched_row_id)
         SELECT ${list}, ?, ? FROM ${table} WHERE ${pk} = ? AND user_id = ?`,
        [batch_id, matched_row_id ?? null, id, user_id]
    );
    const [result] = await conn.query(
        `DELETE FROM ${table} WHERE ${pk} = ? AND user_id = ?`,
        [id, user_id]
    );
    return result.affectedRows > 0;
}

exports.confirmCleanup = async (req, res) => {
    const user_id = req.user.user_id;
    const expense_ids = Array.isArray(req.body?.expense_ids) ? req.body.expense_ids : [];
    const income_ids = Array.isArray(req.body?.income_ids) ? req.body.income_ids : [];

    if (expense_ids.length === 0 && income_ids.length === 0) {
        return res.status(400).json({ error: 'Select at least one row to remove' });
    }

    try {
        // Re-derive the matches server-side and keep only ids that are STILL genuine
        // duplicates. The client's list is a request, never an authority: a stale tab
        // must not be able to delete a row that no longer has a counterpart, and an
        // id belonging to someone else simply will not appear here.
        const [loggedExp, syncedExp, loggedInc, syncedInc] = await Promise.all([
            loadLoggedExpenses(user_id),
            loadSyncedExpenses(user_id),
            loadLoggedIncome(user_id),
            loadSyncedIncome(user_id),
        ]);
        const expMatched = matchDuplicates(loggedExp, syncedExp).matched;
        const incMatched = matchDuplicates(loggedInc, syncedInc).matched;

        const requestedExp = new Set(expense_ids.map(Number));
        const requestedInc = new Set(income_ids.map(Number));
        const okExp = expMatched.filter((r) => requestedExp.has(Number(r.id)));
        const okInc = incMatched.filter((r) => requestedInc.has(Number(r.id)));

        const rejected =
            (expense_ids.length - okExp.length) + (income_ids.length - okInc.length);

        if (okExp.length === 0 && okInc.length === 0) {
            return res.status(409).json({
                error: 'None of those rows are duplicates any more — refresh and try again',
                rejected,
            });
        }

        const batch_id = crypto.randomUUID();
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();

            for (const row of okExp) {
                // Carry the user's category onto the imported row before the hand-logged
                // one goes. The import guesses a category from the merchant name; the
                // user's own choice is better evidence, and without this a cleanup
                // silently undoes months of categorising. Only fills a gap — never
                // overwrites a category the import already got right.
                if (row.category_id != null) {
                    await conn.query(
                        'UPDATE expenses SET category_id = ? WHERE expense_id = ? AND user_id = ? AND category_id IS NULL',
                        [row.category_id, row.match.id, user_id]
                    );
                }
                await archiveRow(conn, {
                    table: 'expenses', archive: 'deleted_expenses', pk: 'expense_id',
                    id: row.id, user_id, batch_id, matched_row_id: row.match.id,
                });
            }

            for (const row of okInc) {
                await archiveRow(conn, {
                    table: 'income', archive: 'deleted_income', pk: 'income_id',
                    id: row.id, user_id, batch_id, matched_row_id: row.match.id,
                });
            }

            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

        res.json({
            batch_id,
            removed_expenses: okExp.length,
            removed_income: okInc.length,
            rejected,
            restore_window_days: RESTORE_WINDOW_DAYS,
        });
    } catch (err) {
        console.error('confirmCleanup error:', err);
        res.status(500).json({ error: 'Cleanup failed — nothing was removed' });
    }
};

// ── Archive listing and restore ──────────────────────────────────────────────

exports.getArchive = async (req, res) => {
    const user_id = req.user.user_id;
    try {
        const [expenses] = await db.query(
            `SELECT expense_id AS id, amount, DATE(created_at) AS date, description,
                    source, batch_id, deleted_at
               FROM deleted_expenses
              WHERE user_id = ? AND deleted_at > NOW() - INTERVAL ? DAY
              ORDER BY deleted_at DESC, created_at DESC`,
            [user_id, RESTORE_WINDOW_DAYS]
        );
        const [income] = await db.query(
            `SELECT income_id AS id, amount, DATE(created_at) AS date, description,
                    source, batch_id, deleted_at
               FROM deleted_income
              WHERE user_id = ? AND deleted_at > NOW() - INTERVAL ? DAY
              ORDER BY deleted_at DESC, created_at DESC`,
            [user_id, RESTORE_WINDOW_DAYS]
        );
        res.json({ expenses, income, restore_window_days: RESTORE_WINDOW_DAYS });
    } catch (err) {
        console.error('getArchive error:', err);
        res.status(500).json({ error: 'Failed to load removed items' });
    }
};

/**
 * Restores rows out of an archive table, keeping their original ids.
 *
 * The archive copy is only dropped once every row it held is confirmed back in the live
 * table. `INSERT IGNORE` is needed for the genuinely harmless collision — the same
 * restore fired twice, where the row is already back — but IGNORE also downgrades a
 * foreign-key failure to a warning, and deleting the archive on that basis would destroy
 * the only remaining copy. So the counts are compared and a shortfall aborts the
 * transaction with the archive intact.
 */
async function restoreRows(conn, { table, archive, pk, user_id, batch_id, ids }) {
    const cols = await liveColumns(table);
    const list = cols.map((c) => `\`${c}\``).join(', ');

    const where = ['user_id = ?'];
    const params = [user_id];
    if (batch_id) { where.push('batch_id = ?'); params.push(batch_id); }
    if (ids && ids.length) {
        where.push(`${pk} IN (${ids.map(() => '?').join(', ')})`);
        params.push(...ids.map(Number));
    }
    const clause = where.join(' AND ');

    const [[{ n: archived }]] = await conn.query(
        `SELECT COUNT(*) AS n FROM ${archive} WHERE ${clause}`, params
    );
    if (archived === 0) return 0;

    await conn.query(
        `INSERT IGNORE INTO ${table} (${list}) SELECT ${list} FROM ${archive} WHERE ${clause}`,
        params
    );

    // Count what is actually present now rather than trusting affectedRows, which reports
    // 0 for the already-restored rows a retry legitimately re-sends.
    const [[{ n: live }]] = await conn.query(
        `SELECT COUNT(*) AS n FROM ${table} t
          WHERE t.user_id = ? AND t.${pk} IN (SELECT ${pk} FROM ${archive} WHERE ${clause})`,
        [user_id, ...params]
    );
    if (live < archived) {
        throw new Error(
            `Restore incomplete: ${live} of ${archived} rows landed in ${table}. Archive left intact.`
        );
    }

    await conn.query(`DELETE FROM ${archive} WHERE ${clause}`, params);
    return archived;
}

exports.restoreCleanup = async (req, res) => {
    const user_id = req.user.user_id;
    const { batch_id } = req.body || {};
    const expense_ids = Array.isArray(req.body?.expense_ids) ? req.body.expense_ids : [];
    const income_ids = Array.isArray(req.body?.income_ids) ? req.body.income_ids : [];

    if (!batch_id && expense_ids.length === 0 && income_ids.length === 0) {
        return res.status(400).json({ error: 'Nothing to restore' });
    }

    try {
        const conn = await db.getConnection();
        let restored_expenses = 0;
        let restored_income = 0;
        try {
            await conn.beginTransaction();
            if (batch_id || expense_ids.length) {
                restored_expenses = await restoreRows(conn, {
                    table: 'expenses', archive: 'deleted_expenses', pk: 'expense_id',
                    user_id, batch_id, ids: expense_ids,
                });
            }
            if (batch_id || income_ids.length) {
                restored_income = await restoreRows(conn, {
                    table: 'income', archive: 'deleted_income', pk: 'income_id',
                    user_id, batch_id, ids: income_ids,
                });
            }
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

        res.json({ restored_expenses, restored_income });
    } catch (err) {
        console.error('restoreCleanup error:', err);
        res.status(500).json({ error: 'Restore failed — nothing was changed' });
    }
};

/**
 * Drops archived rows past the restore window. Called on an interval from index.js.
 * Deliberately not exposed as a route — nothing should be able to shorten a user's
 * undo window by request.
 */
exports.purgeExpiredArchives = async () => {
    try {
        const [exp] = await db.query(
            'DELETE FROM deleted_expenses WHERE deleted_at < NOW() - INTERVAL ? DAY',
            [RESTORE_WINDOW_DAYS]
        );
        const [inc] = await db.query(
            'DELETE FROM deleted_income WHERE deleted_at < NOW() - INTERVAL ? DAY',
            [RESTORE_WINDOW_DAYS]
        );
        const total = (exp.affectedRows || 0) + (inc.affectedRows || 0);
        if (total > 0) console.log(`[cleanup] purged ${total} archived rows past the ${RESTORE_WINDOW_DAYS}-day window`);
    } catch (err) {
        console.error('purgeExpiredArchives error:', err);
    }
};

exports.RESTORE_WINDOW_DAYS = RESTORE_WINDOW_DAYS;
