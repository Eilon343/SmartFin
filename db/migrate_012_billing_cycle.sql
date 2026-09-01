-- Migration 012: the user's financial cycle.
--
-- WHY
-- Every figure in the app was scoped to a calendar month, which is not how money moves. A
-- credit-card settlement leaves the bank on a fixed day — the 10th, say — and a salary
-- lands on another. A calendar month therefore splices the tail of one financial period
-- onto the head of the next and reports the sum as "this month": spending on 3 September
-- was already paid off by the 10 September charge, out of August's salary, yet it was
-- counted against September's income.
--
-- cycle_anchor_day is the settlement day, and so the day a period begins. salary_day
-- reconstructs the day missing from `income.month`, mapping a salary to the cycle it funds.
--
-- WHY 1..28
-- Recovering a cycle key from a date is a shift by (anchor - 1) days — moving the anchor
-- onto the 1st so the ordinary month truncation yields the key. That is exact only for a
-- day that exists in every month. 29-31 would need per-month clamping and would produce
-- cycles of unpredictable length. See backend/src/services/cycle.js.
--
-- WHY BOTH DEFAULT TO 1
-- With anchor = 1 a cycle IS the calendar month, the date shift is 0, and salary_day = 1 is
-- never below the anchor — so every existing user keeps byte-identical numbers until they
-- change the setting themselves. tests/backend/cycle.test.js pins that identity.
--
-- Idempotent: safe to run repeatedly.

SET @dbname = DATABASE();

SET @had_anchor = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = @dbname
       AND TABLE_NAME   = 'users'
       AND COLUMN_NAME  = 'cycle_anchor_day'
);

SET @addAnchor = IF(@had_anchor > 0,
    'SELECT ''cycle_anchor_day already exists''',
    'ALTER TABLE users ADD COLUMN cycle_anchor_day TINYINT UNSIGNED NOT NULL DEFAULT 1'
);
PREPARE stmt FROM @addAnchor; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @had_salary = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = @dbname
       AND TABLE_NAME   = 'users'
       AND COLUMN_NAME  = 'salary_day'
);

SET @addSalary = IF(@had_salary > 0,
    'SELECT ''salary_day already exists''',
    'ALTER TABLE users ADD COLUMN salary_day TINYINT UNSIGNED NOT NULL DEFAULT 1'
);
PREPARE stmt FROM @addSalary; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The API rejects anything outside 1..28 before it reaches here; these are the backstop, so
-- a hand-written UPDATE cannot leave the app resolving a period it has no definition for.
SET @had_anchor_chk = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = @dbname
       AND TABLE_NAME        = 'users'
       AND CONSTRAINT_NAME   = 'chk_users_cycle_anchor_day'
);

SET @addAnchorChk = IF(@had_anchor_chk > 0,
    'SELECT ''chk_users_cycle_anchor_day already exists''',
    'ALTER TABLE users ADD CONSTRAINT chk_users_cycle_anchor_day CHECK (cycle_anchor_day BETWEEN 1 AND 28)'
);
PREPARE stmt FROM @addAnchorChk; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @had_salary_chk = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = @dbname
       AND TABLE_NAME        = 'users'
       AND CONSTRAINT_NAME   = 'chk_users_salary_day'
);

SET @addSalaryChk = IF(@had_salary_chk > 0,
    'SELECT ''chk_users_salary_day already exists''',
    'ALTER TABLE users ADD CONSTRAINT chk_users_salary_day CHECK (salary_day BETWEEN 1 AND 28)'
);
PREPARE stmt FROM @addSalaryChk; EXECUTE stmt; DEALLOCATE PREPARE stmt;
