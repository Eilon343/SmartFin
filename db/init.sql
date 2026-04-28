CREATE TABLE IF NOT EXISTS users (
    user_id      BIGINT PRIMARY KEY,
    username     VARCHAR(100),
    pin_hash     VARCHAR(255),
    google_email VARCHAR(255) UNIQUE,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
    category_id INT PRIMARY KEY AUTO_INCREMENT,
    user_id     BIGINT,
    name        VARCHAR(100) NOT NULL,
    is_base     BOOLEAN DEFAULT FALSE,
    UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS expenses (
    expense_id  INT PRIMARY KEY AUTO_INCREMENT,
    user_id     BIGINT NOT NULL,
    amount      DECIMAL(10, 2) NOT NULL,
    currency    VARCHAR(10) DEFAULT 'ILS',
    description VARCHAR(255),
    category_id INT,
    source      ENUM('bot', 'apple_pay', 'manual', 'web') DEFAULT 'bot',
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
    target_amount      DECIMAL(10, 2) NOT NULL,
    saved_amount       DECIMAL(10, 2) DEFAULT 0.00,
    monthly_allocation DECIMAL(10, 2) DEFAULT 0.00,
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

-- Base categories (user_id NULL = shared across all users)
INSERT INTO categories (user_id, name, is_base)
SELECT NULL, name, TRUE FROM (
    SELECT 'Food' AS name UNION ALL SELECT 'Transport' UNION ALL SELECT 'Housing'
    UNION ALL SELECT 'Entertainment' UNION ALL SELECT 'Shopping' UNION ALL SELECT 'Utilities'
) AS base
WHERE NOT EXISTS (SELECT 1 FROM categories c2 WHERE c2.user_id IS NULL AND c2.name = base.name);
