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
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (category_id) REFERENCES categories(category_id)
);

-- Base categories (user_id NULL = shared across all users)
INSERT IGNORE INTO categories (user_id, name, is_base) VALUES
    (NULL, 'Food', TRUE),
    (NULL, 'Transport', TRUE),
    (NULL, 'Housing', TRUE),
    (NULL, 'Entertainment', TRUE),
    (NULL, 'Shopping', TRUE),
    (NULL, 'Utilities', TRUE);
