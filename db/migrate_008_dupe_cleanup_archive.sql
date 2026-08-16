-- Migration 008: archive tables for duplicate cleanup (undo window)
--
-- Once bank/card sync is connected it re-imports purchases the user already logged by
-- hand. Cleanup removes the hand-logged copy — an irreversible pass over months of real
-- money, so it must be undoable.
--
-- Why an archive table and not an `expenses.deleted_at` flag: a flag would require
-- `AND deleted_at IS NULL` on every read of expenses/income (~20 sites across five
-- controllers, the insights and savings queries, and the bot's own pool). One missed
-- filter silently inflates every total forever, with no error to notice. Moving the row
-- out keeps all existing queries correct without touching them, and restore is an exact
-- put-back: the original primary key is preserved, so nothing that referenced the row
-- comes back pointing somewhere new.
--
-- The archives are created with LIKE so they track the live column set of their source
-- table. Add a column to `expenses` and the archive gains it too — no drift.
--
-- Idempotent: safe to run repeatedly.

-- ── init.sql drift repair: expenses.goal_id ──────────────────────────────────
-- Migration 004 added expenses.goal_id but was never mirrored into init.sql, so a DB
-- built fresh from init.sql lacked the column. init.sql is fixed in this commit; this
-- guard covers any environment already built from the drifted copy.
-- MUST run before the LIKE below, or the archive inherits the drifted column set.
SET @sql := IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'expenses'
        AND COLUMN_NAME  = 'goal_id') > 0,
    'SELECT "expenses.goal_id already exists"',
    'ALTER TABLE expenses ADD COLUMN goal_id INT NULL, ADD INDEX idx_expenses_goal_id (goal_id)'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS deleted_expenses LIKE expenses;
CREATE TABLE IF NOT EXISTS deleted_income   LIKE income;

-- LIKE copies indexes but not foreign keys, which is what we want: the archive must
-- survive independently, and must not cascade anything back into live tables.

-- ── deleted_expenses: cleanup bookkeeping columns ────────────────────────────
SET @sql := IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'deleted_expenses'
        AND COLUMN_NAME  = 'deleted_at') > 0,
    'SELECT "deleted_expenses.deleted_at already exists"',
    'ALTER TABLE deleted_expenses
        ADD COLUMN deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN batch_id CHAR(36) NOT NULL,
        ADD COLUMN matched_row_id INT NULL,
        ADD INDEX idx_del_exp_user (user_id, deleted_at),
        ADD INDEX idx_del_exp_batch (batch_id)'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── deleted_income: same bookkeeping ─────────────────────────────────────────
SET @sql := IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'deleted_income'
        AND COLUMN_NAME  = 'deleted_at') > 0,
    'SELECT "deleted_income.deleted_at already exists"',
    'ALTER TABLE deleted_income
        ADD COLUMN deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN batch_id CHAR(36) NOT NULL,
        ADD COLUMN matched_row_id INT NULL,
        ADD INDEX idx_del_inc_user (user_id, deleted_at),
        ADD INDEX idx_del_inc_batch (batch_id)'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
