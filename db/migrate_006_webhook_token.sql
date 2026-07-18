-- Migration 006: add users.webhook_token — per-user secret for the Apple Pay webhook
-- Replaces the single shared WEBHOOK_SECRET, which could not tell users apart.
-- Safe to re-run (INFORMATION_SCHEMA check). MySQL 5.7+ compatible.
-- New installs: init.sql already includes this column.

SET @dbname = DATABASE();

SET @addCol = (
    SELECT IF(
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = @dbname
           AND TABLE_NAME   = 'users'
           AND COLUMN_NAME  = 'webhook_token') > 0,
        'SELECT ''column already exists''',
        'ALTER TABLE users ADD COLUMN webhook_token VARCHAR(64) UNIQUE'
    )
);
PREPARE stmt FROM @addCol;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
