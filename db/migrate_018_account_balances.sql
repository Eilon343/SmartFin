-- Migration 018: the real account balance, as the bank reports it on every sync.
--
-- israeli-bank-scrapers returns `account.balance` for bank accounts (Leumi: the current
-- account's BalanceDisplay, plus each deposit as a savingsAccount). It was discarded.
-- One row per account per local day: a re-sync the same day overwrites it, and the rows
-- across days are the balance history. Cards report no balance and never appear here.
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS account_balance_snapshots (
    id                 INT PRIMARY KEY AUTO_INCREMENT,
    bank_connection_id INT NOT NULL,
    user_id            BIGINT NOT NULL,
    account_number     VARCHAR(100) NOT NULL,
    is_savings         BOOLEAN NOT NULL DEFAULT FALSE,
    snapshot_date      DATE NOT NULL,
    balance            DECIMAL(14, 2) NOT NULL,
    currency           VARCHAR(10) DEFAULT 'ILS',
    synced_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_balance_snapshot (bank_connection_id, account_number, snapshot_date),
    INDEX idx_balance_user (user_id, snapshot_date),
    FOREIGN KEY (bank_connection_id) REFERENCES bank_connections(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);
