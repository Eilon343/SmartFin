-- Migration 009: one connection per provider per user, enforced by the database.
--
-- createConnection checks for an existing row and then inserts. Two requests that
-- interleave between the check and the insert both pass the check, and the user ends up
-- with the same provider connected twice. Both connections then scrape the same account
-- into separate staging rows — the UNIQUE key on bank_transactions_raw is per-connection,
-- so nothing dedupes them and every transaction is imported and counted twice.
--
-- Easy to hit without meaning to: a double-clicked Connect button, or a retried request
-- on a slow first sync.
--
-- The application check stays, because it produces the friendly 409 message. This is the
-- backstop that makes the race unrepresentable rather than merely unlikely.
--
-- Idempotent: safe to run repeatedly.

-- Collapse any duplicates that already exist, keeping the oldest connection — it is the
-- one whose staged rows and imports are already linked. Deleting the newer row cascades
-- its bank_transactions_raw away; the expenses it created are left in place rather than
-- silently removing a user's data, and can be cleaned up from Settings if unwanted.
DELETE c FROM bank_connections c
JOIN bank_connections keep
  ON keep.user_id = c.user_id
 AND keep.company_id = c.company_id
 AND keep.id < c.id;

SET @sql := IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'bank_connections'
        AND INDEX_NAME   = 'uq_bank_conn_user_company') > 0,
    'SELECT "uq_bank_conn_user_company already exists"',
    'ALTER TABLE bank_connections ADD UNIQUE KEY uq_bank_conn_user_company (user_id, company_id)'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
