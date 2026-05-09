-- ==============================================================
-- SmartFin | Financial Test Seed Script
-- Range   : 2026-01-01 → 2026-05-09  (May 10–31 left empty for Forecast gap)
-- Purpose : MoM / MTD / Forecast testing
-- Engine  : MySQL 8+
--
-- Expected monthly spend profile:
--   Jan: ~12,000 ILS  (normal)
--   Feb: ~3,500  ILS  (VERY LOW — edge case for MoM %)
--   Mar: ~38,000 ILS  (VERY HIGH — edge case for MoM %)
--   Apr: ~12,500 ILS  (normal + Q1 bonus in income)
--   May: ~5,000  ILS  (9 days only — pacing/forecast test)
-- ==============================================================

SET FOREIGN_KEY_CHECKS = 0;
SET @test_uid = 9999999999;

-- ── 0. Clean previous test run ───────────────────────────────
DELETE FROM income        WHERE user_id = @test_uid;
DELETE FROM expenses      WHERE user_id = @test_uid;
DELETE FROM savings_goals WHERE user_id = @test_uid;
DELETE FROM subscriptions WHERE user_id = @test_uid;
DELETE FROM budgets       WHERE user_id = @test_uid;
DELETE FROM users         WHERE user_id = @test_uid;

SET FOREIGN_KEY_CHECKS = 1;

-- ── 1. Test User ─────────────────────────────────────────────
INSERT INTO users (user_id, username, pin_hash, google_email)
VALUES (
    @test_uid,
    'Seed Tester',
    '$2b$10$x3G9b8hPqK1mRnT2wLvDc.fakeHashForTestingOnly',
    'seed@smartfin.test'
);

-- ── 2. Grab base category IDs ────────────────────────────────
SET @cat_food    = (SELECT category_id FROM categories WHERE name = 'Food'          AND user_id IS NULL LIMIT 1);
SET @cat_trans   = (SELECT category_id FROM categories WHERE name = 'Transport'     AND user_id IS NULL LIMIT 1);
SET @cat_housing = (SELECT category_id FROM categories WHERE name = 'Housing'       AND user_id IS NULL LIMIT 1);
SET @cat_entert  = (SELECT category_id FROM categories WHERE name = 'Entertainment' AND user_id IS NULL LIMIT 1);
SET @cat_shop    = (SELECT category_id FROM categories WHERE name = 'Shopping'      AND user_id IS NULL LIMIT 1);
SET @cat_util    = (SELECT category_id FROM categories WHERE name = 'Utilities'     AND user_id IS NULL LIMIT 1);

-- ── 3. Monthly Budgets ───────────────────────────────────────
INSERT INTO budgets (user_id, category_id, monthly_limit, carry_over) VALUES
(@test_uid, @cat_food,    2000.00, TRUE),
(@test_uid, @cat_trans,    600.00, FALSE),
(@test_uid, @cat_housing, 5000.00, FALSE),
(@test_uid, @cat_entert,   800.00, TRUE),
(@test_uid, @cat_shop,    1500.00, TRUE),
(@test_uid, @cat_util,    1000.00, FALSE);

-- ── 4. Savings Goal ──────────────────────────────────────────
INSERT INTO savings_goals (user_id, name, target_amount, saved_amount, monthly_allocation, currency, active)
VALUES (@test_uid, 'Emergency Fund', 30000.00, 5000.00, 1000.00, 'ILS', TRUE);

-- ── 5. Active Subscriptions ──────────────────────────────────
-- last_charged_month = April so they appear as "due" in May (tests subscription logic)
INSERT INTO subscriptions (user_id, name, amount, currency, category_id, day_of_month, last_charged_month, active) VALUES
(@test_uid, 'Netflix',  55.00, 'ILS', @cat_entert, 15, '2026-04', TRUE),
(@test_uid, 'Spotify',  22.00, 'ILS', @cat_entert, 15, '2026-04', TRUE),
(@test_uid, 'iCloud+',  14.00, 'ILS', @cat_util,   20, '2026-04', TRUE);

-- ── 6. Main Seed Procedure ───────────────────────────────────
DROP PROCEDURE IF EXISTS `smartfin_seed`;

DELIMITER //

CREATE PROCEDURE `smartfin_seed`()
BEGIN
    DECLARE v_day    DATE;
    DECLARE v_dom    TINYINT;
    DECLARE v_month  TINYINT;
    DECLARE v_mstr   VARCHAR(7);
    DECLARE v_mult   DECIMAL(5,2);
    DECLARE v_uid    BIGINT DEFAULT 9999999999;

    -- Local category vars (user-defined vars can't be used in INSERT inside procs reliably)
    DECLARE v_food   INT;
    DECLARE v_trans  INT;
    DECLARE v_house  INT;
    DECLARE v_entert INT;
    DECLARE v_shop   INT;
    DECLARE v_util   INT;

    SELECT category_id INTO v_food   FROM categories WHERE name = 'Food'          AND user_id IS NULL LIMIT 1;
    SELECT category_id INTO v_trans  FROM categories WHERE name = 'Transport'     AND user_id IS NULL LIMIT 1;
    SELECT category_id INTO v_house  FROM categories WHERE name = 'Housing'       AND user_id IS NULL LIMIT 1;
    SELECT category_id INTO v_entert FROM categories WHERE name = 'Entertainment' AND user_id IS NULL LIMIT 1;
    SELECT category_id INTO v_shop   FROM categories WHERE name = 'Shopping'      AND user_id IS NULL LIMIT 1;
    SELECT category_id INTO v_util   FROM categories WHERE name = 'Utilities'     AND user_id IS NULL LIMIT 1;

    SET v_day = '2026-01-01';

    WHILE v_day <= '2026-05-09' DO

        SET v_dom   = DAY(v_day);
        SET v_month = MONTH(v_day);
        SET v_mstr  = DATE_FORMAT(v_day, '%Y-%m');

        -- ── Spending multiplier ───────────────────────────────
        -- This is the core knob that drives the MoM edge cases.
        -- Feb = intentionally near-zero variable spend.
        -- Mar = intentionally massive spend to create a visible spike.
        SET v_mult = CASE v_month
            WHEN 2 THEN 0.28   -- Feb: stay-at-home, barely eating out
            WHEN 3 THEN 2.65   -- Mar: splurge month — friend's wedding, vacation, etc.
            ELSE 1.00
        END;

        -- ═══════════════════════════════════════════════════════
        -- INCOME
        -- ═══════════════════════════════════════════════════════

        -- Fixed salary: 1st of every month
        IF v_dom = 1 THEN
            INSERT INTO income (user_id, source, amount, currency, type, month, description, created_at)
            VALUES (v_uid, 'Salary', 15000.00, 'ILS', 'fixed', v_mstr,
                    'Monthly Net Salary', CONCAT(v_day, ' 09:00:00'));
        END IF;

        -- Freelance side income: January 22nd
        IF v_month = 1 AND v_dom = 22 THEN
            INSERT INTO income (user_id, source, amount, currency, type, month, description, created_at)
            VALUES (v_uid, 'Freelance', 2200.00, 'ILS', 'variable', v_mstr,
                    'Website project payment', CONCAT(v_day, ' 17:00:00'));
        END IF;

        -- Q1 performance bonus: April 10th
        IF v_month = 4 AND v_dom = 10 THEN
            INSERT INTO income (user_id, source, amount, currency, type, month, description, created_at)
            VALUES (v_uid, 'Bonus', 3500.00, 'ILS', 'variable', v_mstr,
                    'Q1 Performance Bonus', CONCAT(v_day, ' 10:00:00'));
        END IF;

        -- ═══════════════════════════════════════════════════════
        -- FIXED RECURRING EXPENSES (same every month)
        -- ═══════════════════════════════════════════════════════

        -- Rent on 1st
        IF v_dom = 1 THEN
            INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
            VALUES (v_uid, 4500.00, 'ILS', 'Monthly Rent', v_house, 'manual', CONCAT(v_day, ' 10:00:00'));
        END IF;

        -- Internet on 3rd
        IF v_dom = 3 THEN
            INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
            VALUES (v_uid, 150.00, 'ILS', 'Internet - Bezeq', v_util, 'manual', CONCAT(v_day, ' 11:00:00'));
        END IF;

        -- Electricity + Water on 5th
        IF v_dom = 5 THEN
            INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
            VALUES (v_uid, 280.00, 'ILS', 'Electricity - IEC',  v_util, 'manual', CONCAT(v_day, ' 11:00:00'));
            INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
            VALUES (v_uid, 115.00, 'ILS', 'Water Bill',          v_util, 'manual', CONCAT(v_day, ' 11:05:00'));
        END IF;

        -- Mobile on 10th
        IF v_dom = 10 THEN
            INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
            VALUES (v_uid, 90.00, 'ILS', 'Mobile Plan - Partner', v_util, 'manual', CONCAT(v_day, ' 12:00:00'));
        END IF;

        -- Streaming subscriptions on 15th
        IF v_dom = 15 THEN
            INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
            VALUES (v_uid, 55.00, 'ILS', 'Netflix', v_entert, 'manual', CONCAT(v_day, ' 13:00:00'));
            INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
            VALUES (v_uid, 22.00, 'ILS', 'Spotify', v_entert, 'manual', CONCAT(v_day, ' 13:01:00'));
        END IF;

        -- iCloud on 20th
        IF v_dom = 20 THEN
            INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
            VALUES (v_uid, 14.00, 'ILS', 'iCloud+ 50GB', v_util, 'manual', CONCAT(v_day, ' 14:00:00'));
        END IF;

        -- ═══════════════════════════════════════════════════════
        -- VARIABLE DAILY EXPENSES
        -- All amounts scaled by v_mult so Feb is tiny, Mar is huge
        -- ═══════════════════════════════════════════════════════

        -- ── FOOD: every single day (primary meal) ────────────
        INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
        VALUES (
            v_uid,
            ROUND(GREATEST(5.00, (30 + RAND() * 90) * v_mult), 2),
            'ILS',
            ELT(1 + FLOOR(RAND() * 5), 'Groceries', 'Lunch', 'Dinner Out', 'Supermarket Run', 'Meal Prep'),
            v_food, 'manual',
            CONCAT(v_day, ' ', LPAD(FLOOR(8 + RAND() * 4), 2, '0'), ':', LPAD(FLOOR(RAND() * 60), 2, '0'), ':00')
        );

        -- Second food entry (70% of days — coffee, snack, takeout)
        IF RAND() > 0.30 THEN
            INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
            VALUES (
                v_uid,
                ROUND(GREATEST(4.00, (15 + RAND() * 55) * v_mult), 2),
                'ILS',
                ELT(1 + FLOOR(RAND() * 4), 'Coffee & Pastry', 'Takeout', 'Fast Food', 'Snacks'),
                v_food, 'manual',
                CONCAT(v_day, ' ', LPAD(FLOOR(12 + RAND() * 6), 2, '0'), ':', LPAD(FLOOR(RAND() * 60), 2, '0'), ':00')
            );
        END IF;

        -- ── TRANSPORT: 65% of days ────────────────────────────
        -- Capped at 1.3× multiplier — commute doesn't change much even in splurge months
        IF RAND() > 0.35 THEN
            INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
            VALUES (
                v_uid,
                ROUND(GREATEST(3.00, (8 + RAND() * 40) * LEAST(v_mult, 1.30)), 2),
                'ILS',
                ELT(1 + FLOOR(RAND() * 5), 'Bus / Rail', 'Taxi', 'Wolt Delivery', 'Parking', 'Fuel'),
                v_trans, 'manual',
                CONCAT(v_day, ' ', LPAD(FLOOR(7 + RAND() * 3), 2, '0'), ':', LPAD(FLOOR(RAND() * 60), 2, '0'), ':00')
            );
        END IF;

        -- ── ENTERTAINMENT: 30% normal | 60% in March | 5% in Feb ──
        IF (v_month = 3 AND RAND() > 0.40) OR
           (v_month = 2 AND RAND() > 0.95) OR
           (v_month NOT IN (2, 3) AND RAND() > 0.70)
        THEN
            INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
            VALUES (
                v_uid,
                ROUND(GREATEST(10.00, (60 + RAND() * 190) * v_mult), 2),
                'ILS',
                ELT(1 + FLOOR(RAND() * 6), 'Cinema', 'Bar Night', 'Live Music', 'Sports Event', 'Museum', 'Escape Room'),
                v_entert, 'manual',
                CONCAT(v_day, ' ', LPAD(FLOOR(18 + RAND() * 4), 2, '0'), ':', LPAD(FLOOR(RAND() * 60), 2, '0'), ':00')
            );
        END IF;

        -- ── SHOPPING: 25% normal | 65% in March | 3% in Feb ─
        IF (v_month = 3 AND RAND() > 0.35) OR
           (v_month = 2 AND RAND() > 0.97) OR
           (v_month NOT IN (2, 3) AND RAND() > 0.75)
        THEN
            INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
            VALUES (
                v_uid,
                ROUND(GREATEST(20.00, (100 + RAND() * 400) * v_mult), 2),
                'ILS',
                ELT(1 + FLOOR(RAND() * 6), 'Clothing', 'Electronics', 'Home Goods', 'Amazon Order', 'Gift Purchase', 'Sports Gear'),
                v_shop, 'manual',
                CONCAT(v_day, ' ', LPAD(FLOOR(10 + RAND() * 9), 2, '0'), ':', LPAD(FLOOR(RAND() * 60), 2, '0'), ':00')
            );
        END IF;

        -- ── MARCH BIG-TICKET SPLURGES ─────────────────────────
        -- 4 guaranteed large purchases on fixed dates to ensure March is
        -- unmistakably a spike no matter how RAND() behaves above.
        IF v_month = 3 AND v_dom IN (7, 14, 21, 28) THEN
            INSERT INTO expenses (user_id, amount, currency, description, category_id, source, created_at)
            VALUES (
                v_uid,
                ROUND(800 + RAND() * 1400, 2),
                'ILS',
                ELT(1 + FLOOR(RAND() * 4), 'MacBook Accessories', 'Tel Aviv Weekend Trip', 'Designer Jacket', 'Smart TV 55"'),
                v_shop, 'manual',
                CONCAT(v_day, ' 16:30:00')
            );
        END IF;

        SET v_day = DATE_ADD(v_day, INTERVAL 1 DAY);
    END WHILE;

END //

DELIMITER ;

-- ── Run and clean up ─────────────────────────────────────────
CALL smartfin_seed();
DROP PROCEDURE smartfin_seed;

-- ── Verification Queries ─────────────────────────────────────
-- Run these to confirm the data looks correct before testing.

SELECT '=== EXPENSES BY MONTH ===' AS '';
SELECT
    DATE_FORMAT(created_at, '%Y-%m') AS month,
    COUNT(*)                         AS tx_count,
    ROUND(SUM(amount), 2)            AS total_spent_ils
FROM expenses
WHERE user_id = 9999999999
GROUP BY DATE_FORMAT(created_at, '%Y-%m')
ORDER BY month;

SELECT '=== INCOME BY MONTH ===' AS '';
SELECT
    month,
    source,
    ROUND(SUM(amount), 2) AS total_income_ils
FROM income
WHERE user_id = 9999999999
GROUP BY month, source
ORDER BY month, source;

SELECT '=== MAY MTD (should be ~9 days of data only) ===' AS '';
SELECT
    DATE(created_at) AS day,
    COUNT(*)         AS tx_count,
    ROUND(SUM(amount), 2) AS daily_spent
FROM expenses
WHERE user_id = 9999999999
  AND DATE_FORMAT(created_at, '%Y-%m') = '2026-05'
GROUP BY DATE(created_at)
ORDER BY day;
