-- Migration 015: read-only API keys for an external AI agent (/api/agent/*).
--
-- The agent runs in the cloud and cannot use the dashboard's 30-day JWT: that token can
-- write and delete, and it belongs to a browser. A key here can only reach the two
-- read-only agent endpoints, and is revoked by setting revoked_at.
--
-- Only the SHA-256 of the key is stored. The key itself is printed once by
-- backend/scripts/createAgentKey.js and never again.
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS agent_api_keys (
    key_id       INT PRIMARY KEY AUTO_INCREMENT,
    user_id      BIGINT NOT NULL,
    key_hash     CHAR(64) NOT NULL,
    label        VARCHAR(100),
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP NULL,
    revoked_at   TIMESTAMP NULL,
    UNIQUE KEY uq_agent_key_hash (key_hash),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
