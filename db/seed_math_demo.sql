-- SmartFin — math demo account.
--
-- GENERATED FILE. Edit scripts/gen_seed_math_demo.js and re-run it:
--     node scripts/gen_seed_math_demo.js
--
-- Sign in as mathdemo@smartfin.test / MathDemo!2026
--
-- The data is shaped to exercise every formula in services/forecastMath.js:
--   • six months of UNEVEN history, so the forecast range is non-null
--   • Fri/Sat spending at ~2.5x a weekday, so dow_weights has a signal to recover
--   • an overspending current month, so the credibility blend projects above habit
--   • weak variable income so far this month, which the old max() floor used to hide
--   • is_virtual savings transfers, which Insights used to count as spending
--   • uncategorized rows, which Insights used to drop from its totals
--   • subscriptions both behind and ahead of today, so only the forward ones count
--
-- Idempotent: re-running replaces every row it owns.

SET @uid = 999000777;

-- Clean out any previous run first, children before parents.
DELETE FROM expenses      WHERE user_id = @uid;
DELETE FROM income        WHERE user_id = @uid;
DELETE FROM subscriptions WHERE user_id = @uid;
DELETE FROM budgets       WHERE user_id = @uid;
DELETE FROM savings_goals WHERE user_id = @uid;
DELETE FROM users         WHERE user_id = @uid;

-- Password sign-in only; no Telegram link, no bank connection.
-- onboarded_at is set so the welcome tour does not cover the dashboard on first load.
INSERT INTO users (user_id, username, email, password_hash, onboarded_at, created_at)
VALUES (@uid, 'Math Demo', 'mathdemo@smartfin.test', '$2b$10$7Upk39i3B.g8n6/ku8hXSeFVFv1CiUIGN0d/TUA39aIg6UAJw6c9e', '2026-02-01 09:00:00', '2026-02-01 09:00:00');

-- Fixed salary every month, plus lumpy freelance income. August is deliberately weak:
-- 300 against a ~1,400 habit. The old max(variable_actual, variable_avg) floor would
-- have reported the full average here and never warned anyone.
INSERT INTO income (user_id, source, amount, type, month, description) VALUES
(@uid, 'Salary', 12000.00, 'fixed', '2026-02', 'Monthly salary'),
(@uid, 'Freelance', 900.00, 'variable', '2026-02', 'Side projects'),
(@uid, 'Salary', 12000.00, 'fixed', '2026-03', 'Monthly salary'),
(@uid, 'Freelance', 1500.00, 'variable', '2026-03', 'Side projects'),
(@uid, 'Salary', 12000.00, 'fixed', '2026-04', 'Monthly salary'),
(@uid, 'Freelance', 1100.00, 'variable', '2026-04', 'Side projects'),
(@uid, 'Salary', 12000.00, 'fixed', '2026-05', 'Monthly salary'),
(@uid, 'Freelance', 2100.00, 'variable', '2026-05', 'Side projects'),
(@uid, 'Salary', 12000.00, 'fixed', '2026-06', 'Monthly salary'),
(@uid, 'Freelance', 1300.00, 'variable', '2026-06', 'Side projects'),
(@uid, 'Salary', 12000.00, 'fixed', '2026-07', 'Monthly salary'),
(@uid, 'Freelance', 1700.00, 'variable', '2026-07', 'Side projects'),
(@uid, 'Salary', 12000.00, 'fixed', '2026-08', 'Monthly salary'),
(@uid, 'Freelance', 300.00, 'variable', '2026-08', 'Side projects');

-- 7 transfers x 800. These are is_virtual expenses: money moved, but NOT spending.
INSERT INTO savings_goals (goal_id, user_id, name, target_amount, saved_amount, monthly_allocation, created_at)
VALUES (999777, @uid, 'Emergency Fund', 30000.00, 5600.00, 800.00, '2026-02-01 09:00:00');

INSERT INTO expenses (user_id, amount, category_id, description, source, is_virtual, created_at) VALUES
  -- 2026-02: fixed
(999000777, 4200.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Housing'), 'Rent', 'bot', FALSE, '2026-02-01 12:00:00'),
(999000777, 600.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Utilities'), 'Electricity + water', 'bot', FALSE, '2026-02-05 12:00:00'),
  -- 2026-02: savings transfer (is_virtual — never counted as spending)
(999000777, 800.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Savings'), 'Emergency Fund deposit', 'web', TRUE, '2026-02-10 12:00:00'),
  -- 2026-02: variable
(999000777, 65.66, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-02-01 12:00:00'),
(999000777, 59.09, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Bus card', 'bot', FALSE, '2026-02-02 12:00:00'),
(999000777, 65.66, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-02-03 12:00:00'),
(999000777, 59.09, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Cinema', 'bot', FALSE, '2026-02-04 12:00:00'),
(999000777, 72.22, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-02-05 12:00:00'),
(999000777, 102.42, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Electronics', 'bot', FALSE, '2026-02-06 12:00:00'),
(999000777, 68.28, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-02-06 12:00:00'),
(999000777, 94.55, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-02-07 12:00:00'),
(999000777, 63.03, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Taxi', 'bot', FALSE, '2026-02-07 12:00:00'),
(999000777, 65.66, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-02-08 12:00:00'),
(999000777, 59.09, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Bar', 'bot', FALSE, '2026-02-09 12:00:00'),
(999000777, 65.66, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-02-10 12:00:00'),
(999000777, 59.09, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Clothes', 'bot', FALSE, '2026-02-11 12:00:00'),
(999000777, 72.22, NULL, 'Misc', 'bot', FALSE, '2026-02-12 12:00:00'),
(999000777, 102.42, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-02-13 12:00:00'),
(999000777, 68.28, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Fuel', 'bot', FALSE, '2026-02-13 12:00:00'),
(999000777, 94.55, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-02-14 12:00:00'),
(999000777, 63.03, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Concert', 'bot', FALSE, '2026-02-14 12:00:00'),
(999000777, 65.66, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-02-15 12:00:00'),
(999000777, 59.09, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Homeware', 'bot', FALSE, '2026-02-16 12:00:00'),
(999000777, 65.66, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-02-17 12:00:00'),
(999000777, 59.09, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-02-18 12:00:00'),
(999000777, 72.22, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Bus card', 'bot', FALSE, '2026-02-19 12:00:00'),
(999000777, 102.42, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-02-20 12:00:00'),
(999000777, 68.28, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Cinema', 'bot', FALSE, '2026-02-20 12:00:00'),
(999000777, 94.55, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-02-21 12:00:00'),
(999000777, 63.03, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Electronics', 'bot', FALSE, '2026-02-21 12:00:00'),
(999000777, 65.66, NULL, 'Misc', 'bot', FALSE, '2026-02-22 12:00:00'),
(999000777, 59.09, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-02-23 12:00:00'),
(999000777, 65.66, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Taxi', 'bot', FALSE, '2026-02-24 12:00:00'),
(999000777, 59.09, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-02-25 12:00:00'),
(999000777, 72.22, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Bar', 'bot', FALSE, '2026-02-26 12:00:00'),
(999000777, 102.42, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-02-27 12:00:00'),
(999000777, 68.28, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Clothes', 'bot', FALSE, '2026-02-27 12:00:00'),
(999000777, 94.55, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-02-28 12:00:00'),
(999000777, 63.03, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-02-28 12:00:00'),
  -- 2026-03: fixed
(999000777, 4200.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Housing'), 'Rent', 'bot', FALSE, '2026-03-01 12:00:00'),
(999000777, 600.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Utilities'), 'Electricity + water', 'bot', FALSE, '2026-03-05 12:00:00'),
  -- 2026-03: savings transfer (is_virtual — never counted as spending)
(999000777, 800.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Savings'), 'Emergency Fund deposit', 'web', TRUE, '2026-03-10 12:00:00'),
  -- 2026-03: variable
(999000777, 80.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-03-01 12:00:00'),
(999000777, 72.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Bus card', 'bot', FALSE, '2026-03-02 12:00:00'),
(999000777, 80.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-03-03 12:00:00'),
(999000777, 72.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Cinema', 'bot', FALSE, '2026-03-04 12:00:00'),
(999000777, 88.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-03-05 12:00:00'),
(999000777, 124.80, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Electronics', 'bot', FALSE, '2026-03-06 12:00:00'),
(999000777, 83.20, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-03-06 12:00:00'),
(999000777, 115.20, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-03-07 12:00:00'),
(999000777, 76.80, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Taxi', 'bot', FALSE, '2026-03-07 12:00:00'),
(999000777, 80.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-03-08 12:00:00'),
(999000777, 72.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Bar', 'bot', FALSE, '2026-03-09 12:00:00'),
(999000777, 80.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-03-10 12:00:00'),
(999000777, 72.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Clothes', 'bot', FALSE, '2026-03-11 12:00:00'),
(999000777, 88.00, NULL, 'Misc', 'bot', FALSE, '2026-03-12 12:00:00'),
(999000777, 124.80, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-03-13 12:00:00'),
(999000777, 83.20, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Fuel', 'bot', FALSE, '2026-03-13 12:00:00'),
(999000777, 115.20, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-03-14 12:00:00'),
(999000777, 76.80, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Concert', 'bot', FALSE, '2026-03-14 12:00:00'),
(999000777, 80.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-03-15 12:00:00'),
(999000777, 72.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Homeware', 'bot', FALSE, '2026-03-16 12:00:00'),
(999000777, 80.00, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-03-17 12:00:00'),
(999000777, 72.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-03-18 12:00:00'),
(999000777, 88.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Bus card', 'bot', FALSE, '2026-03-19 12:00:00'),
(999000777, 124.80, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-03-20 12:00:00'),
(999000777, 83.20, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Cinema', 'bot', FALSE, '2026-03-20 12:00:00'),
(999000777, 115.20, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-03-21 12:00:00'),
(999000777, 76.80, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Electronics', 'bot', FALSE, '2026-03-21 12:00:00'),
(999000777, 80.00, NULL, 'Misc', 'bot', FALSE, '2026-03-22 12:00:00'),
(999000777, 72.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-03-23 12:00:00'),
(999000777, 80.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Taxi', 'bot', FALSE, '2026-03-24 12:00:00'),
(999000777, 72.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-03-25 12:00:00'),
(999000777, 88.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Bar', 'bot', FALSE, '2026-03-26 12:00:00'),
(999000777, 124.80, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-03-27 12:00:00'),
(999000777, 83.20, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Clothes', 'bot', FALSE, '2026-03-27 12:00:00'),
(999000777, 115.20, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-03-28 12:00:00'),
(999000777, 76.80, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-03-28 12:00:00'),
(999000777, 80.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Fuel', 'bot', FALSE, '2026-03-29 12:00:00'),
(999000777, 72.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-03-30 12:00:00'),
(999000777, 80.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Concert', 'bot', FALSE, '2026-03-31 12:00:00'),
  -- 2026-04: fixed
(999000777, 4200.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Housing'), 'Rent', 'bot', FALSE, '2026-04-01 12:00:00'),
(999000777, 600.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Utilities'), 'Electricity + water', 'bot', FALSE, '2026-04-05 12:00:00'),
  -- 2026-04: savings transfer (is_virtual — never counted as spending)
(999000777, 800.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Savings'), 'Emergency Fund deposit', 'web', TRUE, '2026-04-10 12:00:00'),
  -- 2026-04: variable
(999000777, 62.74, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-04-01 12:00:00'),
(999000777, 76.68, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Bus card', 'bot', FALSE, '2026-04-02 12:00:00'),
(999000777, 108.75, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-04-03 12:00:00'),
(999000777, 72.50, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Cinema', 'bot', FALSE, '2026-04-03 12:00:00'),
(999000777, 100.38, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-04-04 12:00:00'),
(999000777, 66.92, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Electronics', 'bot', FALSE, '2026-04-04 12:00:00'),
(999000777, 69.71, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-04-05 12:00:00'),
(999000777, 62.74, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-04-06 12:00:00'),
(999000777, 69.71, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Taxi', 'bot', FALSE, '2026-04-07 12:00:00'),
(999000777, 62.74, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-04-08 12:00:00'),
(999000777, 76.68, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Bar', 'bot', FALSE, '2026-04-09 12:00:00'),
(999000777, 108.75, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-04-10 12:00:00'),
(999000777, 72.50, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Clothes', 'bot', FALSE, '2026-04-10 12:00:00'),
(999000777, 100.38, NULL, 'Misc', 'bot', FALSE, '2026-04-11 12:00:00'),
(999000777, 66.92, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-04-11 12:00:00'),
(999000777, 69.71, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Fuel', 'bot', FALSE, '2026-04-12 12:00:00'),
(999000777, 62.74, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-04-13 12:00:00'),
(999000777, 69.71, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Concert', 'bot', FALSE, '2026-04-14 12:00:00'),
(999000777, 62.74, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-04-15 12:00:00'),
(999000777, 76.68, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Homeware', 'bot', FALSE, '2026-04-16 12:00:00'),
(999000777, 108.75, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-04-17 12:00:00'),
(999000777, 72.50, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-04-17 12:00:00'),
(999000777, 100.38, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Bus card', 'bot', FALSE, '2026-04-18 12:00:00'),
(999000777, 66.92, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-04-18 12:00:00'),
(999000777, 69.71, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Cinema', 'bot', FALSE, '2026-04-19 12:00:00'),
(999000777, 62.74, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-04-20 12:00:00'),
(999000777, 69.71, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Electronics', 'bot', FALSE, '2026-04-21 12:00:00'),
(999000777, 62.74, NULL, 'Misc', 'bot', FALSE, '2026-04-22 12:00:00'),
(999000777, 76.68, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-04-23 12:00:00'),
(999000777, 108.75, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Taxi', 'bot', FALSE, '2026-04-24 12:00:00'),
(999000777, 72.50, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-04-24 12:00:00'),
(999000777, 100.38, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Bar', 'bot', FALSE, '2026-04-25 12:00:00'),
(999000777, 66.92, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-04-25 12:00:00'),
(999000777, 69.71, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Clothes', 'bot', FALSE, '2026-04-26 12:00:00'),
(999000777, 62.74, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-04-27 12:00:00'),
(999000777, 69.71, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-04-28 12:00:00'),
(999000777, 62.74, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Fuel', 'bot', FALSE, '2026-04-29 12:00:00'),
(999000777, 76.68, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-04-30 12:00:00'),
  -- 2026-05: fixed
(999000777, 4200.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Housing'), 'Rent', 'bot', FALSE, '2026-05-01 12:00:00'),
(999000777, 600.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Utilities'), 'Electricity + water', 'bot', FALSE, '2026-05-05 12:00:00'),
  -- 2026-05: savings transfer (is_virtual — never counted as spending)
(999000777, 800.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Savings'), 'Emergency Fund deposit', 'web', TRUE, '2026-05-10 12:00:00'),
  -- 2026-05: variable
(999000777, 130.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-05-01 12:00:00'),
(999000777, 86.67, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Bus card', 'bot', FALSE, '2026-05-01 12:00:00'),
(999000777, 120.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-05-02 12:00:00'),
(999000777, 80.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Cinema', 'bot', FALSE, '2026-05-02 12:00:00'),
(999000777, 83.33, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-05-03 12:00:00'),
(999000777, 75.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Electronics', 'bot', FALSE, '2026-05-04 12:00:00'),
(999000777, 83.33, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-05-05 12:00:00'),
(999000777, 75.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-05-06 12:00:00'),
(999000777, 91.67, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Taxi', 'bot', FALSE, '2026-05-07 12:00:00'),
(999000777, 130.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-05-08 12:00:00'),
(999000777, 86.67, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Bar', 'bot', FALSE, '2026-05-08 12:00:00'),
(999000777, 120.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-05-09 12:00:00'),
(999000777, 80.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Clothes', 'bot', FALSE, '2026-05-09 12:00:00'),
(999000777, 83.33, NULL, 'Misc', 'bot', FALSE, '2026-05-10 12:00:00'),
(999000777, 75.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-05-11 12:00:00'),
(999000777, 83.33, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Fuel', 'bot', FALSE, '2026-05-12 12:00:00'),
(999000777, 75.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-05-13 12:00:00'),
(999000777, 91.67, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Concert', 'bot', FALSE, '2026-05-14 12:00:00'),
(999000777, 130.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-05-15 12:00:00'),
(999000777, 86.67, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Homeware', 'bot', FALSE, '2026-05-15 12:00:00'),
(999000777, 120.00, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-05-16 12:00:00'),
(999000777, 80.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-05-16 12:00:00'),
(999000777, 83.33, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Bus card', 'bot', FALSE, '2026-05-17 12:00:00'),
(999000777, 75.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-05-18 12:00:00'),
(999000777, 83.33, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Cinema', 'bot', FALSE, '2026-05-19 12:00:00'),
(999000777, 75.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-05-20 12:00:00'),
(999000777, 91.67, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Electronics', 'bot', FALSE, '2026-05-21 12:00:00'),
(999000777, 130.00, NULL, 'Misc', 'bot', FALSE, '2026-05-22 12:00:00'),
(999000777, 86.67, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-05-22 12:00:00'),
(999000777, 120.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Taxi', 'bot', FALSE, '2026-05-23 12:00:00'),
(999000777, 80.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-05-23 12:00:00'),
(999000777, 83.33, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Bar', 'bot', FALSE, '2026-05-24 12:00:00'),
(999000777, 75.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-05-25 12:00:00'),
(999000777, 83.33, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Clothes', 'bot', FALSE, '2026-05-26 12:00:00'),
(999000777, 75.00, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-05-27 12:00:00'),
(999000777, 91.67, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-05-28 12:00:00'),
(999000777, 130.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Fuel', 'bot', FALSE, '2026-05-29 12:00:00'),
(999000777, 86.67, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-05-29 12:00:00'),
(999000777, 120.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Concert', 'bot', FALSE, '2026-05-30 12:00:00'),
(999000777, 80.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-05-30 12:00:00'),
(999000777, 83.33, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Homeware', 'bot', FALSE, '2026-05-31 12:00:00'),
  -- 2026-06: fixed
(999000777, 4200.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Housing'), 'Rent', 'bot', FALSE, '2026-06-01 12:00:00'),
(999000777, 600.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Utilities'), 'Electricity + water', 'bot', FALSE, '2026-06-05 12:00:00'),
  -- 2026-06: savings transfer (is_virtual — never counted as spending)
(999000777, 800.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Savings'), 'Emergency Fund deposit', 'web', TRUE, '2026-06-10 12:00:00'),
  -- 2026-06: variable
(999000777, 67.23, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-06-01 12:00:00'),
(999000777, 74.70, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Bus card', 'bot', FALSE, '2026-06-02 12:00:00'),
(999000777, 67.23, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-06-03 12:00:00'),
(999000777, 82.17, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Cinema', 'bot', FALSE, '2026-06-04 12:00:00'),
(999000777, 116.53, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-06-05 12:00:00'),
(999000777, 77.69, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Electronics', 'bot', FALSE, '2026-06-05 12:00:00'),
(999000777, 107.57, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-06-06 12:00:00'),
(999000777, 71.71, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-06-06 12:00:00'),
(999000777, 74.70, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Taxi', 'bot', FALSE, '2026-06-07 12:00:00'),
(999000777, 67.23, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-06-08 12:00:00'),
(999000777, 74.70, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Bar', 'bot', FALSE, '2026-06-09 12:00:00'),
(999000777, 67.23, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-06-10 12:00:00'),
(999000777, 82.17, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Clothes', 'bot', FALSE, '2026-06-11 12:00:00'),
(999000777, 116.53, NULL, 'Misc', 'bot', FALSE, '2026-06-12 12:00:00'),
(999000777, 77.69, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-06-12 12:00:00'),
(999000777, 107.57, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Fuel', 'bot', FALSE, '2026-06-13 12:00:00'),
(999000777, 71.71, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-06-13 12:00:00'),
(999000777, 74.70, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Concert', 'bot', FALSE, '2026-06-14 12:00:00'),
(999000777, 67.23, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-06-15 12:00:00'),
(999000777, 74.70, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Homeware', 'bot', FALSE, '2026-06-16 12:00:00'),
(999000777, 67.23, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-06-17 12:00:00'),
(999000777, 82.17, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-06-18 12:00:00'),
(999000777, 116.53, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Bus card', 'bot', FALSE, '2026-06-19 12:00:00'),
(999000777, 77.69, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-06-19 12:00:00'),
(999000777, 107.57, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Cinema', 'bot', FALSE, '2026-06-20 12:00:00'),
(999000777, 71.71, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-06-20 12:00:00'),
(999000777, 74.70, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Electronics', 'bot', FALSE, '2026-06-21 12:00:00'),
(999000777, 67.23, NULL, 'Misc', 'bot', FALSE, '2026-06-22 12:00:00'),
(999000777, 74.70, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-06-23 12:00:00'),
(999000777, 67.23, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Taxi', 'bot', FALSE, '2026-06-24 12:00:00'),
(999000777, 82.17, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-06-25 12:00:00'),
(999000777, 116.53, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Bar', 'bot', FALSE, '2026-06-26 12:00:00'),
(999000777, 77.69, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-06-26 12:00:00'),
(999000777, 107.57, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Clothes', 'bot', FALSE, '2026-06-27 12:00:00'),
(999000777, 71.71, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-06-27 12:00:00'),
(999000777, 74.70, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-06-28 12:00:00'),
(999000777, 67.23, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Fuel', 'bot', FALSE, '2026-06-29 12:00:00'),
(999000777, 74.70, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-06-30 12:00:00'),
  -- 2026-07: fixed
(999000777, 4200.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Housing'), 'Rent', 'bot', FALSE, '2026-07-01 12:00:00'),
(999000777, 600.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Utilities'), 'Electricity + water', 'bot', FALSE, '2026-07-05 12:00:00'),
  -- 2026-07: savings transfer (is_virtual — never counted as spending)
(999000777, 800.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Savings'), 'Emergency Fund deposit', 'web', TRUE, '2026-07-10 12:00:00'),
  -- 2026-07: variable
(999000777, 67.19, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-07-01 12:00:00'),
(999000777, 82.13, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Bus card', 'bot', FALSE, '2026-07-02 12:00:00'),
(999000777, 116.47, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-07-03 12:00:00'),
(999000777, 77.65, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Cinema', 'bot', FALSE, '2026-07-03 12:00:00'),
(999000777, 107.51, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-07-04 12:00:00'),
(999000777, 71.67, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Electronics', 'bot', FALSE, '2026-07-04 12:00:00'),
(999000777, 74.66, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-07-05 12:00:00'),
(999000777, 67.19, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-07-06 12:00:00'),
(999000777, 74.66, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Taxi', 'bot', FALSE, '2026-07-07 12:00:00'),
(999000777, 67.19, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-07-08 12:00:00'),
(999000777, 82.13, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Bar', 'bot', FALSE, '2026-07-09 12:00:00'),
(999000777, 116.47, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-07-10 12:00:00'),
(999000777, 77.65, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Clothes', 'bot', FALSE, '2026-07-10 12:00:00'),
(999000777, 107.51, NULL, 'Misc', 'bot', FALSE, '2026-07-11 12:00:00'),
(999000777, 71.67, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-07-11 12:00:00'),
(999000777, 74.66, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Fuel', 'bot', FALSE, '2026-07-12 12:00:00'),
(999000777, 67.19, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-07-13 12:00:00'),
(999000777, 74.66, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Concert', 'bot', FALSE, '2026-07-14 12:00:00'),
(999000777, 67.19, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-07-15 12:00:00'),
(999000777, 82.13, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Homeware', 'bot', FALSE, '2026-07-16 12:00:00'),
(999000777, 116.47, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-07-17 12:00:00'),
(999000777, 77.65, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-07-17 12:00:00'),
(999000777, 107.51, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Bus card', 'bot', FALSE, '2026-07-18 12:00:00'),
(999000777, 71.67, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-07-18 12:00:00'),
(999000777, 74.66, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Cinema', 'bot', FALSE, '2026-07-19 12:00:00'),
(999000777, 67.19, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-07-20 12:00:00'),
(999000777, 74.66, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Electronics', 'bot', FALSE, '2026-07-21 12:00:00'),
(999000777, 67.19, NULL, 'Misc', 'bot', FALSE, '2026-07-22 12:00:00'),
(999000777, 82.13, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-07-23 12:00:00'),
(999000777, 116.47, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Taxi', 'bot', FALSE, '2026-07-24 12:00:00'),
(999000777, 77.65, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-07-24 12:00:00'),
(999000777, 107.51, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Bar', 'bot', FALSE, '2026-07-25 12:00:00'),
(999000777, 71.67, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-07-25 12:00:00'),
(999000777, 74.66, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Clothes', 'bot', FALSE, '2026-07-26 12:00:00'),
(999000777, 67.19, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-07-27 12:00:00'),
(999000777, 74.66, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-07-28 12:00:00'),
(999000777, 67.19, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Fuel', 'bot', FALSE, '2026-07-29 12:00:00'),
(999000777, 82.13, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-07-30 12:00:00'),
(999000777, 116.47, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Concert', 'bot', FALSE, '2026-07-31 12:00:00'),
(999000777, 77.65, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-07-31 12:00:00'),
  -- 2026-08: fixed
(999000777, 4200.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Housing'), 'Rent', 'bot', FALSE, '2026-08-01 12:00:00'),
(999000777, 600.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Utilities'), 'Electricity + water', 'bot', FALSE, '2026-08-05 12:00:00'),
  -- 2026-08: savings transfer (is_virtual — never counted as spending)
(999000777, 800.00, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Savings'), 'Emergency Fund deposit', 'web', TRUE, '2026-08-10 12:00:00'),
  -- 2026-08: variable
(999000777, 173.46, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Supermarket', 'bot', FALSE, '2026-08-01 12:00:00'),
(999000777, 115.64, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Bus card', 'bot', FALSE, '2026-08-01 12:00:00'),
(999000777, 120.46, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-08-02 12:00:00'),
(999000777, 108.41, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Cinema', 'bot', FALSE, '2026-08-03 12:00:00'),
(999000777, 120.46, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-08-04 12:00:00'),
(999000777, 108.41, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Electronics', 'bot', FALSE, '2026-08-05 12:00:00'),
(999000777, 132.51, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-08-06 12:00:00'),
(999000777, 187.92, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Bakery', 'bot', FALSE, '2026-08-07 12:00:00'),
(999000777, 125.28, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Taxi', 'bot', FALSE, '2026-08-07 12:00:00'),
(999000777, 173.46, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-08-08 12:00:00'),
(999000777, 115.64, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Bar', 'bot', FALSE, '2026-08-08 12:00:00'),
(999000777, 120.46, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-08-09 12:00:00'),
(999000777, 108.41, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Clothes', 'bot', FALSE, '2026-08-10 12:00:00'),
(999000777, 120.46, NULL, 'Misc', 'bot', FALSE, '2026-08-11 12:00:00'),
(999000777, 108.41, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Falafel', 'bot', FALSE, '2026-08-12 12:00:00'),
(999000777, 132.51, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 'Fuel', 'bot', FALSE, '2026-08-13 12:00:00'),
(999000777, 187.92, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-08-14 12:00:00'),
(999000777, 125.28, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 'Concert', 'bot', FALSE, '2026-08-14 12:00:00'),
(999000777, 173.46, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Restaurant', 'bot', FALSE, '2026-08-15 12:00:00'),
(999000777, 115.64, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 'Homeware', 'bot', FALSE, '2026-08-15 12:00:00'),
(999000777, 120.46, NULL, 'Uncategorized purchase', 'bot', FALSE, '2026-08-16 12:00:00'),
(999000777, 108.41, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 'Cafe', 'bot', FALSE, '2026-08-17 12:00:00');

-- Point the savings transfers at the goal, so the Savings card adds up.
UPDATE expenses SET goal_id = 999777 WHERE user_id = @uid AND is_virtual = TRUE;

-- Today is the 17th. Only Netflix (22nd) and Gym (26th) are still ahead, so
-- subscription_total = 54.90 + 149.00 = 203.90. Spotify already billed on the 3rd and
-- its real charge is in expenses; counting it again would subtract the same money
-- twice. iCloud is paused and never counts.
INSERT INTO subscriptions (user_id, name, amount, category_id, day_of_month, paused, active, created_at) VALUES
(@uid, 'Spotify', 21.90, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 3, FALSE, TRUE, '2026-02-01 09:00:00'),
(@uid, 'iCloud', 19.90, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Utilities'), 8, TRUE, TRUE, '2026-02-01 09:00:00'),
(@uid, 'Netflix', 54.90, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 22, FALSE, TRUE, '2026-02-01 09:00:00'),
(@uid, 'Gym', 149.00, NULL, 26, FALSE, TRUE, '2026-02-01 09:00:00');

-- budget_total = 3,400, which becomes the momentum chart target.
INSERT INTO budgets (user_id, category_id, monthly_limit, carry_over, created_at) VALUES
(@uid, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Food'), 1600.00, FALSE, '2026-08-01 00:00:00'),
(@uid, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Transport'), 600.00, FALSE, '2026-08-01 00:00:00'),
(@uid, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Entertainment'), 500.00, FALSE, '2026-08-01 00:00:00'),
(@uid, (SELECT category_id FROM categories WHERE user_id IS NULL AND name = 'Shopping'), 700.00, FALSE, '2026-08-01 00:00:00');

SELECT CONCAT('Seeded math demo user ', @uid) AS result;
