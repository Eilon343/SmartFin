-- Migration 003: bank auto-sync (israeli-bank-scrapers) — bank_connections, bank_transactions_raw,
-- and a 'bank_sync' value on expenses.source.
-- Safe to re-run (INFORMATION_SCHEMA checks). MySQL 5.7+ compatible.

SET @dbname = DATABASE();

CREATE TABLE IF NOT EXISTS bank_connections (
    id                    INT PRIMARY KEY AUTO_INCREMENT,
    user_id               BIGINT NOT NULL,
    company_id            VARCHAR(50) NOT NULL,
    display_name          VARCHAR(100) NULL,
    credentials_encrypted TEXT NOT NULL,
    status                ENUM('pending_first_sync','active','invalid_credentials','error','disabled') NOT NULL DEFAULT 'pending_first_sync',
    last_sync_at          TIMESTAMP NULL,
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
    status               ENUM('completed', 'pending') NOT NULL,
    raw_json             JSON,
    import_status        ENUM('pending_categorization', 'imported', 'skipped', 'failed') NOT NULL DEFAULT 'pending_categorization',
    expense_id           INT NULL,
    income_id            INT NULL,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bank_txn (bank_connection_id, external_hash),
    FOREIGN KEY (bank_connection_id) REFERENCES bank_connections(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (expense_id) REFERENCES expenses(expense_id),
    FOREIGN KEY (income_id) REFERENCES income(income_id)
);

-- Add 'bank_sync' to expenses.source ENUM if not already present
SET @alterEnum = (
    SELECT IF(
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = @dbname
           AND TABLE_NAME   = 'expenses'
           AND COLUMN_NAME  = 'source'
           AND COLUMN_TYPE LIKE '%bank_sync%') > 0,
        'SELECT ''enum value already exists''',
        'ALTER TABLE expenses MODIFY COLUMN source ENUM(''bot'', ''apple_pay'', ''manual'', ''web'', ''bank_sync'') DEFAULT ''bot'''
    )
);
PREPARE stmt FROM @alterEnum;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
