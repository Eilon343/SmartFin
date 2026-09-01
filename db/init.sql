-- user_id is AUTO_INCREMENT from 10^13 (migration 010). Bot-origin users predating that
-- migration have user_id = their Telegram chat id; chat ids are well under 10^11 and the
-- protocol keeps them far below the floor, so a DB-assigned id can never collide with one.
-- New accounts of every origin get their id from the DB — nothing derives it from Telegram.
--
-- email is the single identity column: both password sign-up and Google sign-in resolve to
-- it, which is what makes "same email = same account" a lookup rather than a merge.
-- Always stored and queried lowercased.
--
-- password_hash is NULL for Google-only accounts. That is a valid state, not an error.
CREATE TABLE IF NOT EXISTS users (
    user_id      BIGINT PRIMARY KEY AUTO_INCREMENT,
    username     VARCHAR(100),
    password_hash     VARCHAR(255) NULL,
    email             VARCHAR(255) UNIQUE,
    telegram_chat_id  VARCHAR(50) UNIQUE,
    webhook_token     VARCHAR(64) UNIQUE,
    -- NULL = has never finished the welcome tour. Kept per-account rather than in
    -- localStorage so an introduction to the app happens once, not once per browser.
    onboarded_at      DATETIME NULL,
    -- The user's financial cycle (migration 012). A period runs from cycle_anchor_day to
    -- the day before the next one — the day their card settlement leaves the bank — rather
    -- than from the 1st. salary_day reconstructs the missing day on `income.month`, mapping
    -- an income row to the cycle it funds. Both restricted to 1..28 so a cycle key stays
    -- recoverable from a date by a fixed day shift; see backend/src/services/cycle.js.
    -- Defaulting both to 1 makes a cycle exactly a calendar month.
    cycle_anchor_day  TINYINT UNSIGNED NOT NULL DEFAULT 1,
    salary_day        TINYINT UNSIGNED NOT NULL DEFAULT 1,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_users_cycle_anchor_day CHECK (cycle_anchor_day BETWEEN 1 AND 28),
    CONSTRAINT chk_users_salary_day       CHECK (salary_day       BETWEEN 1 AND 28)
) AUTO_INCREMENT = 10000000000000;

-- Telegram is linked FROM an authenticated web session, never the other way round: the app
-- issues a short-lived single-use code and the bot redeems it. A Telegram message can no
-- longer create an account or attach itself to one it does not already own.
--
-- code_hash is the SHA-256 of the code, so a DB read never yields a live code and redemption
-- is an indexed equality lookup on a hash — no secret-dependent comparison runs in app code.
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

CREATE TABLE IF NOT EXISTS categories (
    category_id INT PRIMARY KEY AUTO_INCREMENT,
    user_id     BIGINT,
    name        VARCHAR(100) NOT NULL,
    is_base     BOOLEAN DEFAULT FALSE,
    is_fixed    BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS expenses (
    expense_id  INT PRIMARY KEY AUTO_INCREMENT,
    user_id     BIGINT NOT NULL,
    amount      DECIMAL(10, 2) NOT NULL,
    currency    VARCHAR(10) DEFAULT 'ILS',
    description VARCHAR(255),
    category_id INT,
    source      ENUM('bot', 'apple_pay', 'manual', 'web', 'bank_sync') DEFAULT 'bot',
    is_virtual  BOOLEAN NOT NULL DEFAULT FALSE,
    goal_id     INT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_expenses_goal_id (goal_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (category_id) REFERENCES categories(category_id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
    subscription_id    INT PRIMARY KEY AUTO_INCREMENT,
    user_id            BIGINT NOT NULL,
    name               VARCHAR(100) NOT NULL,
    amount             DECIMAL(10, 2) NOT NULL,
    currency           VARCHAR(10) DEFAULT 'ILS',
    category_id        INT,
    day_of_month       TINYINT NOT NULL,
    last_charged_month VARCHAR(7),
    paused             BOOLEAN DEFAULT FALSE,
    active             BOOLEAN DEFAULT TRUE,
    created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (category_id) REFERENCES categories(category_id)
);

CREATE TABLE IF NOT EXISTS budgets (
    budget_id     INT PRIMARY KEY AUTO_INCREMENT,
    user_id       BIGINT NOT NULL,
    category_id   INT NOT NULL,
    monthly_limit DECIMAL(10, 2) NOT NULL,
    carry_over    BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, category_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (category_id) REFERENCES categories(category_id)
);

CREATE TABLE IF NOT EXISTS income (
    income_id   INT PRIMARY KEY AUTO_INCREMENT,
    user_id     BIGINT NOT NULL,
    source      VARCHAR(100) NOT NULL DEFAULT 'Salary',
    amount      DECIMAL(10, 2) NOT NULL,
    currency    VARCHAR(10) DEFAULT 'ILS',
    type        ENUM('fixed', 'variable') DEFAULT 'fixed',
    month       VARCHAR(7) NOT NULL,
    description VARCHAR(255),
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- Archive tables for duplicate cleanup (migration 008).
-- Cleanup moves a hand-logged row here instead of deleting it, so the pass is undoable
-- for RESTORE_WINDOW_DAYS. Defined with LIKE so they track their source table's columns.
-- No foreign keys: the archive must outlive whatever it references.
-- MySQL 8 has no ADD COLUMN IF NOT EXISTS; init.sql only ever runs against a fresh
-- volume, where the LIKE above just created the table, so a plain ALTER is correct here.
-- Existing databases get the same shape from migrate_008, which guards on
-- INFORMATION_SCHEMA instead.
CREATE TABLE IF NOT EXISTS deleted_expenses LIKE expenses;
ALTER TABLE deleted_expenses
    ADD COLUMN deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN batch_id CHAR(36) NOT NULL,
    ADD COLUMN matched_row_id INT NULL,
    ADD INDEX idx_del_exp_user (user_id, deleted_at),
    ADD INDEX idx_del_exp_batch (batch_id);

CREATE TABLE IF NOT EXISTS deleted_income LIKE income;
ALTER TABLE deleted_income
    ADD COLUMN deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN batch_id CHAR(36) NOT NULL,
    ADD COLUMN matched_row_id INT NULL,
    ADD INDEX idx_del_inc_user (user_id, deleted_at),
    ADD INDEX idx_del_inc_batch (batch_id);

CREATE TABLE IF NOT EXISTS savings_goals (
    goal_id            INT PRIMARY KEY AUTO_INCREMENT,
    user_id            BIGINT NOT NULL,
    name               VARCHAR(100) NOT NULL,
    target_amount      DECIMAL(10, 2) NULL,
    saved_amount       DECIMAL(10, 2) DEFAULT 0.00,
    monthly_allocation DECIMAL(10, 2) DEFAULT 0.00,
    is_ongoing         TINYINT NOT NULL DEFAULT 0,
    currency           VARCHAR(10) DEFAULT 'ILS',
    active             BOOLEAN DEFAULT TRUE,
    created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS webhook_queue (
    id         INT PRIMARY KEY AUTO_INCREMENT,
    user_id    BIGINT NOT NULL,
    text       TEXT NOT NULL,
    status     ENUM('pending', 'processed', 'failed') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bank_connections (
    id                    INT PRIMARY KEY AUTO_INCREMENT,
    user_id               BIGINT NOT NULL,
    company_id            VARCHAR(50) NOT NULL,
    display_name          VARCHAR(100) NULL,
    credentials_encrypted TEXT NOT NULL,
    status                ENUM('pending_first_sync', 'active', 'invalid_credentials', 'error', 'disabled') NOT NULL DEFAULT 'pending_first_sync',
    last_sync_at          TIMESTAMP NULL,
    -- last_sync_at is the last SUCCESS (it drives the incremental scrape window);
    -- last_attempt_at is the last try, and paces the retry of an errored connection.
    last_attempt_at       TIMESTAMP NULL,
    last_sync_status      VARCHAR(50) NULL,
    last_sync_error       TEXT NULL,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- One connection per provider per user (migration 009). createConnection also checks,
    -- but two interleaved requests both pass that check and the duplicate connections then
    -- scrape the same account into separate staging rows — the UNIQUE key on
    -- bank_transactions_raw is per-connection, so nothing dedupes them.
    UNIQUE KEY uq_bank_conn_user_company (user_id, company_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS bank_transactions_raw (
    id                  INT PRIMARY KEY AUTO_INCREMENT,
    bank_connection_id  INT NOT NULL,
    user_id             BIGINT NOT NULL,
    external_hash       CHAR(64) NOT NULL,
    account_number      VARCHAR(100),
    txn_date            DATE NOT NULL,
    description         VARCHAR(255),
    memo                VARCHAR(255) NULL,
    charged_amount      DECIMAL(10, 2) NOT NULL,
    currency            VARCHAR(10) DEFAULT 'ILS',
    status              ENUM('completed', 'pending') NOT NULL,
    raw_json            JSON,
    import_status       ENUM('pending_categorization', 'imported', 'skipped', 'failed') NOT NULL DEFAULT 'pending_categorization',
    import_attempts     INT NOT NULL DEFAULT 0,
    expense_id          INT NULL,
    income_id           INT NULL,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bank_txn (bank_connection_id, external_hash),
    FOREIGN KEY (bank_connection_id) REFERENCES bank_connections(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    -- SET NULL, not the default RESTRICT: deleting a bank-imported expense in the web
    -- UI must succeed. The staged row survives, unlinked, so it is never re-imported.
    CONSTRAINT fk_btr_expense FOREIGN KEY (expense_id) REFERENCES expenses(expense_id) ON DELETE SET NULL,
    CONSTRAINT fk_btr_income  FOREIGN KEY (income_id)  REFERENCES income(income_id)   ON DELETE SET NULL
);

-- Base categories (user_id NULL = shared across all users)
-- is_fixed=TRUE for categories that recur as flat monthly costs (not run-rated in forecast)
INSERT INTO categories (user_id, name, is_base, is_fixed)
SELECT NULL, name, TRUE, is_fixed FROM (
    SELECT 'Food'          AS name, FALSE AS is_fixed UNION ALL
    SELECT 'Transport',         FALSE UNION ALL
    SELECT 'Housing',           TRUE  UNION ALL
    SELECT 'Entertainment',     FALSE UNION ALL
    SELECT 'Shopping',          FALSE UNION ALL
    SELECT 'Utilities',         TRUE  UNION ALL
    SELECT 'Savings',           TRUE
) AS base
WHERE NOT EXISTS (SELECT 1 FROM categories c2 WHERE c2.user_id IS NULL AND c2.name = base.name);
