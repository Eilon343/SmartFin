-- Migration 014: remember which week each user last received their weekly summary for.
--
-- The summary moved from the bot's scheduler to the backend, whose job ticks all Sunday
-- morning rather than firing once. Without a stored marker, a restart or the next tick
-- would send the same week's message again.
--
-- Holds the first day (a Sunday) of the week last sent. NULL = never sent.
--
-- Idempotent: safe to run repeatedly.

SET @dbname = DATABASE();

SET @addCol = IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @dbname
        AND TABLE_NAME   = 'users'
        AND COLUMN_NAME  = 'weekly_score_sent_for') > 0,
    'SELECT ''weekly_score_sent_for already exists''',
    'ALTER TABLE users ADD COLUMN weekly_score_sent_for DATE NULL'
);
PREPARE stmt FROM @addCol; EXECUTE stmt; DEALLOCATE PREPARE stmt;
