-- Migration 002: add is_virtual to expenses + Savings base category
-- Safe to re-run (INFORMATION_SCHEMA checks). MySQL 5.7+ compatible.

SET @dbname = DATABASE();

-- Add is_virtual column if missing
SET @addCol = (
    SELECT IF(
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = @dbname
           AND TABLE_NAME   = 'expenses'
           AND COLUMN_NAME  = 'is_virtual') > 0,
        'SELECT ''column already exists''',
        'ALTER TABLE expenses ADD COLUMN is_virtual BOOLEAN NOT NULL DEFAULT FALSE'
    )
);
PREPARE stmt FROM @addCol;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add Savings base category if missing
INSERT INTO categories (user_id, name, is_base, is_fixed)
SELECT NULL, 'Savings', TRUE, TRUE
WHERE NOT EXISTS (
    SELECT 1 FROM categories WHERE user_id IS NULL AND name = 'Savings'
);
