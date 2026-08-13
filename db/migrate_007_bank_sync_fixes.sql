-- Migration 007: bank-sync corrections on top of migrate_003_bank_sync.sql.
--   1. bank_transactions_raw.expense_id / income_id become ON DELETE SET NULL, so a
--      user can delete a bank-imported expense in the web UI. They were RESTRICT, and
--      deleteExpense() returned a 500 for every row bank sync had created.
--   2. bank_connections.last_attempt_at — when a sync was last ATTEMPTED, as opposed to
--      last_sync_at which must keep pointing at the last success (it drives the
--      incremental scrape window). Paces the retry of an errored connection.
--   3. bank_transactions_raw.import_attempts — bounded retries before a row is parked
--      as 'failed', instead of failing permanently on one transient error.
-- Safe to re-run (INFORMATION_SCHEMA checks). MySQL 5.7+ compatible.

SET @dbname = DATABASE();

-- ── 1. Re-point the expense_id / income_id foreign keys ──────────────────────────
-- Constraint names are whatever MySQL auto-assigned (…_ibfk_3 / _ibfk_4 on a stock
-- 003 install), so they are looked up rather than assumed.
SET @fkExpense = (
    SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'bank_transactions_raw'
      AND COLUMN_NAME = 'expense_id' AND REFERENCED_TABLE_NAME = 'expenses'
    LIMIT 1
);
SET @needsExpenseFix = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @dbname AND TABLE_NAME = 'bank_transactions_raw'
      AND CONSTRAINT_NAME = @fkExpense AND DELETE_RULE <> 'SET NULL'
);

SET @sql = IF(@needsExpenseFix > 0,
    CONCAT('ALTER TABLE bank_transactions_raw DROP FOREIGN KEY ', @fkExpense),
    'SELECT ''expense_id FK already ON DELETE SET NULL''');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(@needsExpenseFix > 0,
    'ALTER TABLE bank_transactions_raw ADD CONSTRAINT fk_btr_expense FOREIGN KEY (expense_id) REFERENCES expenses(expense_id) ON DELETE SET NULL',
    'SELECT ''expense_id FK already ON DELETE SET NULL''');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fkIncome = (
    SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'bank_transactions_raw'
      AND COLUMN_NAME = 'income_id' AND REFERENCED_TABLE_NAME = 'income'
    LIMIT 1
);
SET @needsIncomeFix = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @dbname AND TABLE_NAME = 'bank_transactions_raw'
      AND CONSTRAINT_NAME = @fkIncome AND DELETE_RULE <> 'SET NULL'
);

SET @sql = IF(@needsIncomeFix > 0,
    CONCAT('ALTER TABLE bank_transactions_raw DROP FOREIGN KEY ', @fkIncome),
    'SELECT ''income_id FK already ON DELETE SET NULL''');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(@needsIncomeFix > 0,
    'ALTER TABLE bank_transactions_raw ADD CONSTRAINT fk_btr_income FOREIGN KEY (income_id) REFERENCES income(income_id) ON DELETE SET NULL',
    'SELECT ''income_id FK already ON DELETE SET NULL''');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. bank_connections.last_attempt_at ──────────────────────────────────────────
SET @sql = IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'bank_connections'
       AND COLUMN_NAME = 'last_attempt_at') > 0,
    'SELECT ''last_attempt_at already exists''',
    'ALTER TABLE bank_connections ADD COLUMN last_attempt_at TIMESTAMP NULL AFTER last_sync_at');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 3. bank_transactions_raw.import_attempts ─────────────────────────────────────
SET @sql = IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'bank_transactions_raw'
       AND COLUMN_NAME = 'import_attempts') > 0,
    'SELECT ''import_attempts already exists''',
    'ALTER TABLE bank_transactions_raw ADD COLUMN import_attempts INT NOT NULL DEFAULT 0 AFTER import_status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 4. Backfill the one-day date shift ───────────────────────────────────────────
-- Every row imported before this migration was dated with .toISOString() on a date the
-- scraper reports as Israel-local midnight in UTC (2026-08-09T00:00+03:00 serializes to
-- 2026-08-08T21:00:00.000Z), so the calendar date came out one day early — including
-- month-boundary rows, which landed in the wrong month's totals.
-- CONVERT_TZ is used rather than a blanket +1 day so only genuinely shifted rows move.
-- Guarded on the mysql.time_zone tables being loaded; if CONVERT_TZ returns NULL the
-- row is left alone (verify with: SELECT CONVERT_TZ(NOW(),'UTC','Asia/Jerusalem');).
UPDATE bank_transactions_raw
SET txn_date = DATE(CONVERT_TZ(
        STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.date')), '%Y-%m-%dT%H:%i:%s.%fZ'),
        'UTC', 'Asia/Jerusalem'))
WHERE raw_json IS NOT NULL
  AND CONVERT_TZ(
        STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.date')), '%Y-%m-%dT%H:%i:%s.%fZ'),
        'UTC', 'Asia/Jerusalem') IS NOT NULL;

-- Re-date the ledger rows those staged rows produced. expenses/income are dated by
-- created_at, and the time-of-day component is meaningless for an imported row.
UPDATE expenses e
JOIN bank_transactions_raw t ON t.expense_id = e.expense_id
SET e.created_at = t.txn_date
WHERE e.source = 'bank_sync' AND DATE(e.created_at) <> t.txn_date;

UPDATE income i
JOIN bank_transactions_raw t ON t.income_id = i.income_id
SET i.created_at = t.txn_date,
    i.month = DATE_FORMAT(t.txn_date, '%Y-%m')
WHERE DATE(i.created_at) <> t.txn_date;
