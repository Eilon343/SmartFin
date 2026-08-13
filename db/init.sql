CREATE TABLE IF NOT EXISTS users (
    user_id      BIGINT PRIMARY KEY,
    username     VARCHAR(100),
    pin_hash     VARCHAR(255),
    google_email      VARCHAR(255) UNIQUE,
    telegram_chat_id  VARCHAR(50) UNIQUE,
    webhook_token     VARCHAR(64) UNIQUE,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
