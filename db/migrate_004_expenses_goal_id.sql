-- Migration 004: link virtual transfers to their savings goal
-- Adds expenses.goal_id (nullable) and backfills past transfers via description match.
-- Safe to re-run.

SET @dbname = DATABASE();

SET @addCol = (
    SELECT IF(
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = @dbname
           AND TABLE_NAME   = 'expenses'
           AND COLUMN_NAME  = 'goal_id') > 0,
        'SELECT ''column already exists''',
        'ALTER TABLE expenses ADD COLUMN goal_id INT NULL, ADD INDEX idx_expenses_goal_id (goal_id)'
    )
);
PREPARE stmt FROM @addCol;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Backfill: match existing virtual rows to a goal by `Transfer → <name>` description.
UPDATE expenses e
JOIN savings_goals g
    ON g.user_id = e.user_id
   AND e.description = CONCAT('Transfer → ', g.name)
SET e.goal_id = g.goal_id
WHERE e.is_virtual = TRUE AND e.goal_id IS NULL;
