-- Migration 001: add is_fixed to categories
-- Run once against any existing database (safe to re-run — IF NOT EXISTS guard)
-- New installs: init.sql already includes this column.

ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS is_fixed BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE categories
SET is_fixed = TRUE
WHERE user_id IS NULL
  AND name IN ('Housing', 'Utilities');
