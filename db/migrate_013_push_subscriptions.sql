-- Migration 013: Web Push subscriptions. Bank sync notifications move from Telegram to
-- push. One row per browser/device; a user may have several.
--
-- endpoint is a push-service URL that can exceed an indexable VARCHAR, so uniqueness is on
-- its SHA-256 instead.
--
-- Idempotent: the deploy workflow re-applies every migration on each run.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id            INT PRIMARY KEY AUTO_INCREMENT,
    user_id       BIGINT NOT NULL,
    endpoint_hash CHAR(64) NOT NULL,
    endpoint      TEXT NOT NULL,
    p256dh        VARCHAR(255) NOT NULL,
    auth          VARCHAR(255) NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_push_endpoint (endpoint_hash),
    INDEX idx_push_user (user_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
