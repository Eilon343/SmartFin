-- Migration 001: add is_fixed to categories
-- Safe to re-run: checks INFORMATION_SCHEMA before altering (MySQL 5.7+ compatible).
-- New installs: init.sql already includes this column.

SET @dbname = DATABASE();

SET @addCol = (
    SELECT IF(
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = @dbname
           AND TABLE_NAME   = 'categories'
           AND COLUMN_NAME  = 'is_fixed') > 0,
        'SELECT ''column already exists''',
        'ALTER TABLE categories ADD COLUMN is_fixed BOOLEAN NOT NULL DEFAULT FALSE'
    )
);

PREPARE stmt FROM @addCol;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE categories
SET is_fixed = TRUE
WHERE user_id IS NULL
  AND name IN ('Housing', 'Utilities');
