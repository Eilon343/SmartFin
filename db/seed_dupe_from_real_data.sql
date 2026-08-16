-- ─────────────────────────────────────────────────────────────────────────────
-- Test fixture for duplicate cleanup, built from YOUR REAL transaction history.
--
--   Login:  user_id 999000002   (see TESTING_DUPE_CLEANUP.md for the console snippet)
--
-- What this does:
--
--   Seeds only the HAND-LOGGED side, copying the amounts and dates of transactions your
--   own accounts really produced. You then connect the same bank and cards to this test
--   user and let sync run for real. The scraper imports the genuine transactions, they
--   collide with these copies, and you get duplicates created the same way your
--   production users will get them — rather than fabricated staging rows.
--
--   Your real account (@src below) is only ever read from, never written to.
--
-- Deliberate properties, so the result exercises the real rules:
--
--   * 1 in 4 real transactions is NOT copied. After sync those arrive as imports you
--     never logged by hand — they should stay invisible to cleanup, because there is
--     nothing of yours to delete.
--   * Logged dates are pulled 0-2 days EARLIER than the transaction date. That is how
--     it really happens: you log at the moment of payment, the issuer posts later.
--     It also exercises the ±5-day window instead of only same-day matches.
--   * Descriptions are shortened to the first word of the issuer's text, which is what
--     a person actually types. Descriptions are never compared by the matcher — this is
--     purely so the screen shows a realistic "you wrote X / issuer says Y" pair.
--   * The source column is rotated across manual/bot/web/apple_pay so every hand-logged
--     origin is represented, including the legacy Apple Pay rows.
--   * Five cash/Bit rows are added with amounts that appear nowhere in your history
--     (verified zero collisions). No import can ever match them, so they prove the
--     "kept" path — these are the rows a date-range delete would have destroyed.
--
-- NO bank_connections and NO bank_transactions_raw rows are created here. That is the
-- point: you create them by connecting for real. Until you do, the cleanup screen will
-- correctly say nothing has been imported yet.
--
--   docker exec -i smartfin_db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" smartfin' < db/seed_dupe_from_real_data.sql
--
-- Re-running is safe: the teardown below removes the previous copy first. Note that it
-- also drops the test user's bank connections, so you would reconnect after a re-seed.
-- ─────────────────────────────────────────────────────────────────────────────

SET @uid  := 999000002;   -- the test user
SET @src  := 938418219;   -- the real account whose history is being mirrored

-- How far back to mirror. Kept just inside the scraper's 90-day first-sync window
-- (FIRST_SYNC_LOOKBACK_MS in bankSyncScheduler.js) so everything copied here has a
-- genuine chance of being re-imported when you sync.
SET @days := 85;

-- ── Teardown (child rows first) ──────────────────────────────────────────────
-- This is a FULL reset: connections, staged rows, everything imported from them, the
-- cleanup archive and the hand-logged side all go, so the next run starts from zero.
--
-- Note the ordering hazard it fixes: dropping bank_connections cascades away
-- bank_transactions_raw, but the expenses those rows created are NOT deleted with them
-- (expense_id is ON DELETE SET NULL). Removing a connection alone therefore strands the
-- imported expenses with no provenance, and cleanup can never match them again — it
-- reads the staging table, not expenses.source. So the imported rows are deleted here
-- explicitly, BEFORE the connections that would orphan them.
DELETE FROM deleted_expenses      WHERE user_id = @uid;
DELETE FROM deleted_income        WHERE user_id = @uid;
DELETE FROM bank_transactions_raw WHERE user_id = @uid;
DELETE FROM expenses              WHERE user_id = @uid;
DELETE FROM income                WHERE user_id = @uid;
DELETE FROM subscriptions         WHERE user_id = @uid;
DELETE FROM bank_connections      WHERE user_id = @uid;
DELETE FROM users                 WHERE user_id = @uid;

-- ── User ─────────────────────────────────────────────────────────────────────
-- Password is 'dupetest123' (bcrypt cost 12). Sign in at /login with the email below —
-- no console token snippet needed now that the app has a real sign-in form.
INSERT INTO users (user_id, username, password_hash, email)
VALUES (@uid, 'dupetest_real', '$2b$12$yiyarxk3BipMeLuLa2dAOuHnHV8oC86efvpaqoMc9yyEppyGoJaLq', 'dupetest-real@example.com');

-- ── Hand-logged expenses, mirrored from real imported transactions ───────────
INSERT INTO expenses (user_id, amount, currency, description, category_id, source, is_virtual, created_at)
SELECT
    @uid,
    e.amount,
    e.currency,
    -- First word of the issuer's text: what a person would actually type.
    LEFT(SUBSTRING_INDEX(t.description, ' ', 1), 255),
    e.category_id,
    -- Rotated on id/4, NOT on id itself: the skip filter below already uses MOD(id,4),
    -- and sharing the modulus would silently starve whichever source lines up with the
    -- skipped bucket (it left 'manual' with nothing).
    ELT(MOD(FLOOR(t.id / 4), 4) + 1, 'manual', 'bot', 'web', 'apple_pay'),
    FALSE,
    -- Logged 0-2 days before the issuer posted it.
    DATE_SUB(t.txn_date, INTERVAL MOD(t.id, 3) DAY)
FROM bank_transactions_raw t
JOIN expenses e ON e.expense_id = t.expense_id
WHERE t.user_id = @src
  AND t.import_status = 'imported'
  AND t.expense_id IS NOT NULL
  AND e.is_virtual = FALSE
  AND t.txn_date >= DATE_SUB(CURDATE(), INTERVAL @days DAY)
  -- Leave a quarter of them unlogged: sync will find things you never recorded.
  AND MOD(t.id, 4) <> 0;

-- ── Hand-logged income, mirrored from real imported income ───────────────────
INSERT INTO income (user_id, source, amount, currency, type, month, description, created_at)
SELECT
    @uid,
    'Salary',
    i.amount,
    i.currency,
    i.type,
    DATE_FORMAT(DATE_SUB(t.txn_date, INTERVAL 1 DAY), '%Y-%m'),
    LEFT(SUBSTRING_INDEX(t.description, ' ', 1), 255),
    DATE_SUB(t.txn_date, INTERVAL 1 DAY)
FROM bank_transactions_raw t
JOIN income i ON i.income_id = t.income_id
WHERE t.user_id = @src
  AND t.import_status = 'imported'
  AND t.income_id IS NOT NULL
  AND t.txn_date >= DATE_SUB(CURDATE(), INTERVAL @days DAY);

-- ── Rows nothing will ever match ─────────────────────────────────────────────
-- Amounts chosen to appear nowhere in the real history, so these can only ever land in
-- the "kept" column. Cash, Bit and PayBox genuinely never reach a bank or card feed.
SET @food := (SELECT category_id FROM categories WHERE name = 'Food'     AND user_id IS NULL LIMIT 1);
SET @shop := (SELECT category_id FROM categories WHERE name = 'Shopping' AND user_id IS NULL LIMIT 1);

INSERT INTO expenses (user_id, amount, currency, description, category_id, source, is_virtual, created_at) VALUES
  (@uid,  73.33, 'ILS', 'cash at the shuk',       @food, 'manual', FALSE, DATE_SUB(CURDATE(), INTERVAL 40 DAY)),
  (@uid,  41.17, 'ILS', 'split lunch (Bit)',      @food, 'bot',    FALSE, DATE_SUB(CURDATE(), INTERVAL 33 DAY)),
  (@uid, 128.44, 'ILS', 'plumber, paid cash',     @shop, 'manual', FALSE, DATE_SUB(CURDATE(), INTERVAL 21 DAY)),
  (@uid,  19.77, 'ILS', 'parking meter',          @shop, 'bot',    FALSE, DATE_SUB(CURDATE(), INTERVAL 12 DAY)),
  (@uid, 256.91, 'ILS', 'PayBox to a friend',     @shop, 'web',    FALSE, DATE_SUB(CURDATE(), INTERVAL  5 DAY));

-- ── Subscriptions, for testing the generated-row rule ────────────────────────
-- The bot's daily job writes a `[Subscription]` expense row ONLY for users without live
-- bank sync. With a connection running, sync imports the real charge instead, so writing
-- a generated row too would double-count — the job marks the subscription charged and
-- writes nothing. `last_charged_month` is left NULL so all three are due immediately.
--
-- Two are dated today (due now) and one is dated ahead, which also exercises the P&L
-- rule: subscription_total counts only charges still ahead in the current month, and it
-- belongs to forecasted_net_pnl alone, never to current_net_pnl.
INSERT INTO subscriptions (user_id, name, amount, currency, category_id, day_of_month, active, paused, last_charged_month) VALUES
  (@uid, 'Netflix', 55.00, 'ILS', (SELECT category_id FROM categories WHERE name='Entertainment' AND user_id IS NULL LIMIT 1), DAY(CURDATE()), TRUE, FALSE, NULL),
  (@uid, 'Spotify', 22.00, 'ILS', (SELECT category_id FROM categories WHERE name='Entertainment' AND user_id IS NULL LIMIT 1), DAY(CURDATE()), TRUE, FALSE, NULL),
  -- Billing day still ahead this month (clamped to 28 so it exists in February too).
  (@uid, 'iCloud+', 14.00, 'ILS', (SELECT category_id FROM categories WHERE name='Utilities' AND user_id IS NULL LIMIT 1), LEAST(DAY(CURDATE()) + 5, 28), TRUE, FALSE, NULL);

-- ── What was seeded ──────────────────────────────────────────────────────────
SELECT 'Seeded test user 999000002 from real history.' AS status;

SELECT COUNT(*) AS hand_logged_expenses, ROUND(SUM(amount), 2) AS total
FROM expenses WHERE user_id = @uid;

SELECT COUNT(*) AS hand_logged_income, ROUND(SUM(amount), 2) AS total
FROM income WHERE user_id = @uid;

SELECT COUNT(*) AS subscriptions_due_now
FROM subscriptions WHERE user_id = @uid AND day_of_month <= DAY(CURDATE()) AND last_charged_month IS NULL;

SELECT 'Of those, 5 are cash/Bit/PayBox and can never match an import.' AS note;
SELECT 'Bank sync data fully cleared: connections, staged rows and everything imported from them.' AS reset;
SELECT 'Next: log in as 999000002, connect the same bank + cards, wait for sync, then open Settings -> Duplicate cleanup.' AS next_step;
