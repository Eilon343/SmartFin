-- Migration 005: add is_ongoing flag to savings_goals + allow nullable target_amount
-- Safe to re-run (INFORMATION_SCHEMA check). MySQL 5.7+ compatible.

SET @dbname = DATABASE();

-- Add is_ongoing column if missing
SET @addCol = (
    SELECT IF(
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = @dbname
           AND TABLE_NAME   = 'savings_goals'
           AND COLUMN_NAME  = 'is_ongoing') > 0,
        'SELECT ''column already exists''',
        'ALTER TABLE savings_goals ADD COLUMN is_ongoing TINYINT NOT NULL DEFAULT 0 AFTER monthly_allocation'
    )
);
PREPARE stmt FROM @addCol;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Allow target_amount to be NULL (ongoing investments have no target)
-- MODIFY COLUMN is idempotent — safe to run on already-nullable column
ALTER TABLE savings_goals MODIFY COLUMN target_amount DECIMAL(10,2) NULL;
