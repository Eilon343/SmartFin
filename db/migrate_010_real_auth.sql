-- Migration 010: real authentication. Email+password and Google sign-up in the web app;
-- Telegram demoted to an opt-in integration linked from an authenticated session.
--
-- WHY
-- Before this migration the only way to obtain an account was sending `/link_google <email>`
-- to the Telegram bot. That had two flaws:
--   1. The re-link guard only fired when telegram_chat_id was already set. For every
--      Google-only account it is NULL, so any Telegram user who knew the email could bind
--      their chat to that account and read/write its finances through the bot.
--   2. Nothing ever proved the sender controlled the mailbox, so an attacker could claim an
--      address before its real owner signed up; the owner's later Google sign-in then
--      handed them a token for the attacker's row.
-- Neither is patchable in place, because "account exists, Telegram not yet linked" is
-- exactly the state /link_google existed to serve. This builds the missing front door.
--
-- Idempotent: safe to run repeatedly. The deploy workflow re-applies every migration on each
-- run, and there is no migrations-applied tracking table — idempotency is the whole
-- mechanism. New installs get all of this from init.sql instead.

SET @dbname = DATABASE();

-- ── 1. user_id becomes AUTO_INCREMENT above the Telegram chat-id range ───────────────────
--
-- users.user_id had no AUTO_INCREMENT: bot-origin users were keyed by their Telegram chat
-- id. New sign-ups need an id that cannot collide with a chat id, so the counter starts at
-- 10^13. Telegram chat ids are currently below 10^11 and the protocol keeps them far under
-- 10^13, so the two ranges cannot meet.
--
-- Chosen over generating ids in application code because the DB is then the single
-- allocator — no read-then-insert race, no collision-retry loop to get wrong.
--
-- Existing rows are NOT renumbered. Eight tables carry
-- FOREIGN KEY (user_id) REFERENCES users(user_id) (expenses, income, subscriptions,
-- budgets, savings_goals, bank_connections, bank_transactions_raw — plus categories and
-- webhook_queue by column without an FK), so renumbering would either break those rows or
-- require rewriting all of them. Migrating forward around the existing ids costs nothing:
-- the old chat-id keys stay valid, they simply sit below the floor.
--
-- FOREIGN_KEY_CHECKS is dropped only for the MODIFY. The column type is unchanged (BIGINT);
-- InnoDB otherwise refuses to alter a column that FK children point at.
SET FOREIGN_KEY_CHECKS = 0;

SET @autoInc = (
    SELECT IF(
        (SELECT EXTRA FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = @dbname
            AND TABLE_NAME   = 'users'
            AND COLUMN_NAME  = 'user_id') LIKE '%auto_increment%',
        'SELECT ''user_id is already AUTO_INCREMENT''',
        'ALTER TABLE users MODIFY user_id BIGINT NOT NULL AUTO_INCREMENT'
    )
);
PREPARE stmt FROM @autoInc; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET FOREIGN_KEY_CHECKS = 1;

-- MySQL silently refuses to lower AUTO_INCREMENT below max(user_id)+1, so this is a no-op
-- once real sign-ups exist above the floor, and sets the floor before they do.
ALTER TABLE users AUTO_INCREMENT = 10000000000000;

-- ── 2. google_email → email, one canonical identity column ───────────────────────────────
--
-- Requirement: signing up with a password and later using Google (or vice versa) must reach
-- ONE account. A single UNIQUE email column makes that a lookup instead of a merge
-- algorithm — there is no second column for the two routes to disagree about.
--
-- This also fixes a latent bug: /link_google stored the address lowercased while googleLogin
-- looked it up unnormalized. All application code now lowercases on both write and read.
-- Note the absence of UNIQUE here. Writing `CHANGE COLUMN ... VARCHAR(255) UNIQUE` ADDS a
-- second unique index rather than reusing the one the column already carries, leaving two
-- identical indexes on the same column. The uniqueness constraint survives the rename on its
-- own; the index is renamed separately below.
SET @renameEmail = (
    SELECT IF(
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = @dbname
            AND TABLE_NAME   = 'users'
            AND COLUMN_NAME  = 'email') > 0,
        'SELECT ''email column already exists''',
        'ALTER TABLE users CHANGE COLUMN google_email email VARCHAR(255)'
    )
);
PREPARE stmt FROM @renameEmail; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE users SET email = LOWER(TRIM(email)) WHERE email IS NOT NULL AND email <> LOWER(TRIM(email));

-- Renaming the column leaves its UNIQUE index still called `google_email`, so a duplicate
-- signup reports "Duplicate entry ... for key 'users.google_email'" — naming a column that
-- no longer exists, which sends the next person debugging it looking for the wrong thing.
--
-- Three states to reconcile, because an earlier revision of this migration created the
-- redundant second index described above:
--   both exist  -> drop the stale `google_email` one
--   only old    -> rename it
--   only new    -> nothing to do
SET @fixIdx = (
    SELECT CASE
        WHEN old_ix > 0 AND new_ix > 0 THEN 'ALTER TABLE users DROP INDEX google_email'
        WHEN old_ix > 0                THEN 'ALTER TABLE users RENAME INDEX google_email TO email'
        ELSE 'SELECT ''email index already named correctly'''
    END
    FROM (
        SELECT
            SUM(INDEX_NAME = 'google_email') AS old_ix,
            SUM(INDEX_NAME = 'email')        AS new_ix
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'users'
    ) AS ix
);
PREPARE stmt FROM @fixIdx; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 3. Passwords ─────────────────────────────────────────────────────────────────────────
--
-- pin_hash held a bcrypt hash of a numeric PIN, compared by authController.login against a
-- user_id. Nothing in the repository ever WROTE it — there was no register, set-pin or
-- change-pin endpoint anywhere, so the column was provisioned by hand and PIN login was
-- effectively dead. It is dropped rather than renamed: keeping it would leave a second
-- credential column that no code path maintains.
--
-- The existing production users authenticate with Google and are unaffected — this migration
-- does not touch any user row's identity or data.
--
-- password_hash is NULL for Google-only accounts, which is a valid state. login refuses a
-- NULL hash by running bcrypt against a dummy value first, so a Google-only address is
-- indistinguishable from an unknown one.
SET @addPw = (
    SELECT IF(
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = @dbname
            AND TABLE_NAME   = 'users'
            AND COLUMN_NAME  = 'password_hash') > 0,
        'SELECT ''password_hash already exists''',
        'ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL'
    )
);
PREPARE stmt FROM @addPw; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @dropPin = (
    SELECT IF(
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = @dbname
            AND TABLE_NAME   = 'users'
            AND COLUMN_NAME  = 'pin_hash') > 0,
        'ALTER TABLE users DROP COLUMN pin_hash',
        'SELECT ''pin_hash already dropped'''
    )
);
PREPARE stmt FROM @dropPin; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 4. Telegram link codes ───────────────────────────────────────────────────────────────
--
-- The web app issues a short-lived single-use code from an authenticated session; the bot
-- redeems it with `/link <code>`. Only code_hash (SHA-256) is stored, so a DB read never
-- yields a live code, and redemption is an indexed equality lookup on a hash rather than a
-- secret-dependent comparison in application code.
--
-- Single use is enforced by the claim itself:
--   UPDATE ... SET used_at = NOW() WHERE code_hash = ? AND used_at IS NULL AND expires_at > NOW()
-- and checking affectedRows, so two concurrent redemptions cannot both win.
CREATE TABLE IF NOT EXISTS telegram_link_codes (
    id         INT PRIMARY KEY AUTO_INCREMENT,
    user_id    BIGINT NOT NULL,
    code_hash  CHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    used_at    DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_link_code_hash (code_hash),
    INDEX idx_link_user (user_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);
