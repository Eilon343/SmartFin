-- Migration 011: remember whether an account has seen the welcome tour.
--
-- WHY A COLUMN AND NOT localStorage
-- The what's-new tour keys off localStorage (lib/whatsNew.js), which is right for it: it
-- announces a release, and seeing it once per browser is harmless. A welcome tour is
-- different — it explains what the app IS, which a returning user only needs once ever.
-- Keyed to the browser it would reappear on their phone, then again after clearing site
-- data, each time implying they are new. Keyed to the account it happens exactly once.
--
-- Idempotent: safe to run repeatedly.

SET @dbname = DATABASE();

-- Captured BEFORE the ALTER: it is the only reliable "this is the first run" signal.
SET @had_column = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = @dbname
       AND TABLE_NAME   = 'users'
       AND COLUMN_NAME  = 'onboarded_at'
);

SET @addCol = IF(@had_column > 0,
    'SELECT ''onboarded_at already exists''',
    'ALTER TABLE users ADD COLUMN onboarded_at DATETIME NULL'
);
PREPARE stmt FROM @addCol; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Backfill everyone who already exists, on the first run ONLY.
--
-- NULL means "has never been welcomed", so without this every current user would be shown
-- an introduction to an app they have been using for months. The tour stays reachable on
-- demand from Settings for anyone who wants to read it.
--
-- The guard is @had_column, not "does any row have a value yet". The latter looks
-- equivalent and is not: once real sign-ups exist, a re-run at a moment when every user
-- happens to be mid-tour would stamp them all as onboarded and silently close it.
SET @backfill = IF(@had_column > 0,
    'SELECT ''onboarding backfill already applied''',
    'UPDATE users SET onboarded_at = NOW() WHERE onboarded_at IS NULL'
);
PREPARE stmt FROM @backfill; EXECUTE stmt; DEALLOCATE PREPARE stmt;
