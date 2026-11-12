-- Migration 019: the proactive alerts the agent has already been told about.
--
-- backend/src/services/spendingAlerts.js evaluates the rules on a timer and writes what
-- fired here. GET /api/agent/alerts then only READS this table, which is what keeps the
-- agent API read-only: the write happens on the scheduler's tick, never on a request.
--
-- dedupe_key is each rule's own idea of "the same occurrence", so a rule picks its cooldown
-- without needing a column of its own:
--   cycle-scoped rules -> the cycle key  ('2026-11')      : at most once per cycle
--   day-scoped rules   -> the local date ('2026-11-12')   : at most once per day
--   row-scoped rules   -> the expense id ('expense:8842') : exactly once, ever
--
-- The UNIQUE key enforces it. Two overlapping ticks, or a restart mid-write, collide on
-- insert instead of producing a second alert. Without it an ignored warning would be
-- re-raised every half hour, and the user would mute the agent inside a week — losing the
-- one alert that mattered along with the noise.
--
-- payload holds the numbers the agent needs to phrase the alert. It must never carry bank
-- account details: see the PRIVACY RULE in backend/src/controllers/agentController.js.
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS alert_log (
    alert_id   BIGINT       AUTO_INCREMENT PRIMARY KEY,
    user_id    INT          NOT NULL,
    rule       VARCHAR(40)  NOT NULL,
    severity   VARCHAR(10)  NOT NULL,
    dedupe_key VARCHAR(60)  NOT NULL,
    cycle_key  CHAR(7)      NOT NULL,
    payload    JSON         NULL,
    sent_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_alert_occurrence (user_id, rule, dedupe_key),
    KEY idx_alert_user_sent (user_id, sent_at),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
