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
