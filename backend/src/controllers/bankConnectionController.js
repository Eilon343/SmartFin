const db = require('../config/db');
const { encrypt } = require('../utils/cryptoUtil');
const bankCompanies = require('../config/bankCompanies');
const { requestSyncNow, isSyncQueued } = require('../services/bankSyncScheduler');
const { classifySyncFailure } = require('../services/syncFailureClassifier');

exports.listCompanies = (_req, res) => {
    const companies = Object.entries(bankCompanies).map(([id, c]) => ({
        id,
        name: c.name,
        kind: c.kind,
        loginFields: c.loginFields,
    }));
    res.json(companies);
};

exports.createConnection = async (req, res) => {
    const { companyId, credentials, displayName } = req.body;
    const company = bankCompanies[companyId];
    if (!company) {
        return res.status(400).json({ error: 'Unsupported bank/company' });
    }
    const missing = company.loginFields.filter((f) => !credentials || !credentials[f]);
    if (missing.length > 0) {
        return res.status(400).json({ error: `Missing credential fields: ${missing.join(', ')}` });
    }

    try {
        // The same provider connected twice would scrape the same transactions into two
        // connections; the UNIQUE key is per-connection, so both would import and double-count.
        const [existing] = await db.query(
            'SELECT id FROM bank_connections WHERE user_id = ? AND company_id = ?',
            [req.user.user_id, companyId]
        );
        if (existing.length > 0) {
            return res.status(409).json({
                error: `${company.name} is already connected. Disconnect it first to reconnect with different credentials.`,
                code: 'already_connected',
            });
        }

        const encrypted = encrypt(JSON.stringify(credentials));
        const [result] = await db.query(
            `INSERT INTO bank_connections (user_id, company_id, display_name, credentials_encrypted, status)
             VALUES (?, ?, ?, ?, 'pending_first_sync')`,
            [req.user.user_id, companyId, displayName || company.name, encrypted]
        );
        res.status(201).json({ id: result.insertId, status: 'pending_first_sync' });
    } catch (err) {
        // The check above is not atomic: two requests can interleave between it and the
        // insert, and a double-clicked Connect button is enough. The UNIQUE key added in
        // migration 009 is what actually prevents the duplicate; catching it here turns
        // the loser of that race into the same friendly 409 rather than a 500.
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                error: `${company.name} is already connected. Disconnect it first to reconnect with different credentials.`,
                code: 'already_connected',
            });
        }
        console.error('createConnection error:', err);
        res.status(500).json({ error: 'Failed to create bank connection' });
    }
};

exports.listConnections = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, company_id, display_name, status, last_sync_at, last_sync_status, last_sync_error, created_at
             FROM bank_connections WHERE user_id = ? ORDER BY created_at DESC`,
            [req.user.user_id]
        );
        // `failure` carries a stable code the UI can explain and translate. The raw
        // last_sync_error stays alongside it for the technical-details disclosure —
        // it is a scraper/puppeteer message, never anything the user supplied.
        res.json(rows.map((row) => ({ ...row, failure: classifySyncFailure(row) })));
    } catch (err) {
        console.error('listConnections error:', err);
        res.status(500).json({ error: 'Failed to list bank connections' });
    }
};

exports.triggerSync = async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT id, status FROM bank_connections WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.user_id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Bank connection not found' });
        }
        // Retrying known-bad credentials risks locking the real bank account —
        // most Israeli banks lock after ~3 failed logins. Force a reconnect instead.
        if (rows[0].status === 'invalid_credentials') {
            return res.status(409).json({
                error: 'The saved credentials were rejected by the bank. Syncing is paused to avoid locking your bank account — disconnect and reconnect with the correct details.',
                code: 'invalid_credentials',
            });
        }
        // Queued, not refused: the previous check rejected the request whenever ANY
        // user's scrape was running, and dropped the click instead of remembering it.
        if (isSyncQueued(rows[0].id)) {
            return res.json({ triggered: true, alreadyQueued: true });
        }
        requestSyncNow(rows[0].id);
        res.json({ triggered: true });
    } catch (err) {
        console.error('triggerSync error:', err);
        res.status(500).json({ error: 'Failed to trigger sync' });
    }
};

exports.deleteConnection = async (req, res) => {
    try {
        const [result] = await db.query(
            'DELETE FROM bank_connections WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.user_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Bank connection not found' });
        }
        res.json({ deleted: true });
    } catch (err) {
        console.error('deleteConnection error:', err);
        res.status(500).json({ error: 'Failed to delete bank connection' });
    }
};

/**
 * The real account balance, as the bank reported it on the latest sync, per account, plus
 * the change since the previous day it was seen. Only bank accounts report one; savings
 * deposits are listed separately and are not part of `current_total`.
 */
exports.getBalances = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT s.bank_connection_id, s.account_number, s.is_savings, s.snapshot_date, s.balance,
                    s.currency, s.synced_at, c.company_id, c.display_name
             FROM account_balance_snapshots s
             JOIN bank_connections c ON c.id = s.bank_connection_id AND c.user_id = s.user_id
             WHERE s.user_id = ? AND s.snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 120 DAY)
             ORDER BY s.snapshot_date DESC`,
            [req.user.user_id]
        );
        res.json(shapeBalances(rows || []));
    } catch (err) {
        console.error('getBalances error:', err);
        res.status(500).json({ error: 'Failed to load balances' });
    }
};

const pad2 = (n) => String(n).padStart(2, '0');
const dayOf = (v) => (v instanceof Date ? `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}` : String(v).slice(0, 10));
const money = (n) => Math.round(Number(n) * 100) / 100;

/** Pure: snapshot rows (newest first) → latest per account + history. Exported for tests. */
function shapeBalances(rows) {
    const byAccount = new Map();
    for (const r of rows) {
        const key = `${r.bank_connection_id}|${r.account_number}`;
        if (!byAccount.has(key)) byAccount.set(key, []);
        byAccount.get(key).push(r);
    }
    const accounts = [...byAccount.values()].map((snaps) => {
        const [latest, previous] = snaps;
        const company = bankCompanies[latest.company_id];
        return {
            bank: latest.display_name || company?.name || latest.company_id,
            // Last 4 digits only — enough to tell accounts apart on screen.
            account: String(latest.account_number).replace(/[^0-9]/g, '').slice(-4),
            is_savings: !!Number(latest.is_savings),
            balance: money(latest.balance),
            currency: latest.currency || 'ILS',
            as_of: latest.synced_at,
            previous: previous ? { date: dayOf(previous.snapshot_date), balance: money(previous.balance) } : null,
            change: previous ? money(latest.balance - previous.balance) : null,
            history: snaps.slice(0, 60).map((s) => ({ date: dayOf(s.snapshot_date), balance: money(s.balance) })).reverse(),
        };
    });
    const current = accounts.filter((a) => !a.is_savings);
    return {
        current_total: current.length ? money(current.reduce((s, a) => s + a.balance, 0)) : null,
        savings_total: money(accounts.filter((a) => a.is_savings).reduce((s, a) => s + a.balance, 0)),
        as_of: current.map((a) => a.as_of).sort().pop() || null,
        accounts,
    };
}
exports.shapeBalances = shapeBalances;
