-- Migration 016: loans, credit-card installment plans, auto-detected recurring expenses,
-- and the base categories the deterministic categorizer assigns.
--
-- Idempotent: the deploy workflow runs EVERY migration on EVERY deploy, so each step
-- checks INFORMATION_SCHEMA first. The one-off installment backfill (full_resync_pending)
-- is armed only in the same branch that adds its column, so it fires exactly once.

SET @dbname = DATABASE();

-- ── Loans (manual entry) ─────────────────────────────────────────────────────────
-- No supported bank scraper returns loan details (balance, rate, remaining payments), so
-- every field here is MANUAL ENTRY. Repayment debits ("פרעון הלוואה") are still imported
-- as expenses and the Loans tab offers them as a starting point; match_key links a loan
-- to that repayment payee.
CREATE TABLE IF NOT EXISTS loans (
    loan_id             INT PRIMARY KEY AUTO_INCREMENT,
    user_id             BIGINT NOT NULL,
    lender              VARCHAR(100) NOT NULL,
    loan_type           ENUM('mortgage', 'loan', 'overdraft', 'other') NOT NULL DEFAULT 'loan',
    original_amount     DECIMAL(12, 2) NULL,
    outstanding_balance DECIMAL(12, 2) NOT NULL DEFAULT 0,
    interest_rate       DECIMAL(6, 3) NULL,
    monthly_payment     DECIMAL(10, 2) NOT NULL DEFAULT 0,
    remaining_payments  INT NULL,
    payment_day         TINYINT NULL,
    next_payment_date   DATE NULL,
    match_key           VARCHAR(190) NULL,
    notes               VARCHAR(255) NULL,
    balance_updated_at  DATE NULL,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_loans_user (user_id, active),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- ── Installment plans (derived from card sync) ───────────────────────────────────
-- Rebuilt from imported card rows after every drain (services/installments.js). Kept in
-- its own table rather than derived on read so the agent API can report installments
-- without touching a bank_* table — that is a hard rule for agentController.
CREATE TABLE IF NOT EXISTS installment_plans (
    plan_id             INT PRIMARY KEY AUTO_INCREMENT,
    user_id             BIGINT NOT NULL,
    plan_hash           CHAR(64) NOT NULL,
    merchant            VARCHAR(255) NOT NULL,
    monthly_amount      DECIMAL(10, 2) NOT NULL,
    total_amount        DECIMAL(12, 2) NOT NULL,
    total_payments      INT NOT NULL,
    last_number         INT NOT NULL,
    last_payment_date   DATE NOT NULL,
    next_payment_date   DATE NULL,
    end_date            DATE NOT NULL,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_installment_plan (user_id, plan_hash),
    INDEX idx_installment_user (user_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- ── Subscriptions: auto-detection ───────────────────────────────────────────────
-- auto_detected: inserted by services/recurringDetector.js, not by the user.
-- confirmed_at:  NULL until the user approves an auto-detected one.
-- match_key:     payee + amount identity. A removed detection keeps its row (active =
--                FALSE) precisely so this key stops it being detected again.
SET @q = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'subscriptions' AND COLUMN_NAME = 'auto_detected') > 0,
    'SELECT ''subscriptions.auto_detected already exists''',
    'ALTER TABLE subscriptions ADD COLUMN auto_detected BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN confirmed_at DATETIME NULL, ADD COLUMN match_key VARCHAR(190) NULL, ADD INDEX idx_sub_match (user_id, match_key)');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── One-off card backfill for installments ──────────────────────────────────────
-- Card scrapes ran with combineInstallments:true, which makes the library DROP payments
-- 2..N of every installment plan. Switching it off only helps from the next scrape's
-- window onward (3 days), so each card connection gets one full 3-month re-scrape. The
-- content hash dedupes everything already staged; only the missing payments are new.
SET @q = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'bank_connections' AND COLUMN_NAME = 'full_resync_pending') > 0,
    'SELECT ''bank_connections.full_resync_pending already exists''',
    'ALTER TABLE bank_connections ADD COLUMN full_resync_pending BOOLEAN NOT NULL DEFAULT FALSE');
SET @arm = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = 'bank_connections' AND COLUMN_NAME = 'full_resync_pending') > 0,
    'SELECT ''installment backfill already armed''',
    'UPDATE bank_connections SET full_resync_pending = TRUE WHERE company_id IN (''max'', ''visaCal'', ''isracard'', ''amex'', ''behatsdaa'', ''beyahadBishvilha'')');
PREPARE stmt FROM @q; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- @arm was decided BEFORE the column existed, so it runs once: on the deploy that adds it.
PREPARE stmt FROM @arm; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Base categories used by services/categoryRules.js ──────────────────────────
-- is_fixed = flat monthly cost, not run-rated by the forecast.
INSERT INTO categories (user_id, name, is_base, is_fixed)
SELECT NULL, name, TRUE, is_fixed FROM (
    SELECT 'Health'        AS name, FALSE AS is_fixed UNION ALL
    SELECT 'Insurance',         TRUE  UNION ALL
    SELECT 'Loans',             TRUE  UNION ALL
    SELECT 'Fees',              FALSE UNION ALL
    SELECT 'Subscriptions',     TRUE  UNION ALL
    SELECT 'Transfers',         FALSE UNION ALL
    SELECT 'Personal Care',     FALSE
) AS base
WHERE NOT EXISTS (SELECT 1 FROM categories c2 WHERE c2.user_id IS NULL AND c2.name = base.name);
