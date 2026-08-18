# Testing: duplicate cleanup

Manual test plan for `Settings → Duplicate cleanup`.

The fixture mirrors **your own real transaction history** into a separate test user as
hand-logged rows. You then connect the same bank and cards to that test user and let sync
run for real. The scraper imports the genuine transactions, they collide with the mirrored
copies, and you get duplicates produced exactly the way your production users will get
them — not fabricated ones.

Your real account is never touched. Only the test user (`999000002`) is written to.

## Setup

```powershell
# 1. Apply the migration (idempotent — safe to re-run)
docker exec -i smartfin_db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" smartfin' < db/migrate_008_dupe_cleanup_archive.sql

# 2. Rebuild the services that changed
docker compose up -d --build backend frontend

# 3. Seed the test user from your real history
docker exec -i smartfin_db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 smartfin' < db/seed_dupe_from_real_data.sql
```

Step 3 prints what it seeded. On the current data that is **102 hand-logged expenses**
(₪10,321.39), **5 income rows** (₪9,562.54) and **3 subscriptions**.

Step 3 is also the **full reset**. Re-run it any time to start over: it clears the bank
connections, the staged rows, everything imported from them, the cleanup archive and the
hand-logged side, then rebuilds the hand-logged side from scratch. You reconnect the banks
afterwards.

> The reset deletes imported expenses *before* the connections, deliberately. Dropping a
> connection cascades away its `bank_transactions_raw` rows but leaves the expenses they
> created behind (`expense_id` is `ON DELETE SET NULL`). Those orphans can never be matched
> again, because cleanup reads provenance from the staging table, not `expenses.source`.
> The same is true in the product: **disconnecting a bank permanently un-matches its
> imports.**

## Logging in as the test user

The sign-in screen is Google-only and the test user has no Google account, so authenticate
from the browser console. Open http://localhost:8080 and paste:

```js
await (async () => {
  const r = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: 999000002, pin: '1234' }),
  });
  if (!r.ok) throw new Error('login failed: ' + r.status + ' ' + await r.text());
  const { token } = await r.json();
  localStorage.setItem('sf_token', token);
  localStorage.setItem('sf_gprofile', JSON.stringify({ name: 'Dupe Test', email: 'dupetest-real@example.com' }));
  location.href = '/';
})();
```

- Run it on the app's own origin (`localhost:8080`) so the relative `/api` path reaches the
  backend through nginx — port 3000 is not published to the host.
- Back to your own account: `localStorage.clear(); location.reload()`, then sign in with
  Google. The test token lasts 30 days.

## The run

### Step 1 — before connecting anything

Open **Settings**. There should be **no Duplicate cleanup section at all**. Nothing has been
imported, so there is nothing to compare against and an empty state would just be noise.
The section appears on its own once sync has imported something.

### Step 2 — connect the same accounts

In **Settings → Bank & card sync**, connect the same bank and cards you use on your real
account: the bank (`236453`) plus both cards (`2624`, `6924`). Cards matter — the bank feed
only shows one lump settlement per card, not the individual purchases, and settlements can
never act as counterparts.

Sync starts automatically. Allow roughly **5–10 minutes** for a first sync.

That wait is not the sync frequency. `runSyncCycle` wakes every 2 minutes only to *check*
whether any connection is due — a newly added one is due immediately, which is why it starts
within a couple of minutes. Each scrape then takes a minute or two of headless Chromium,
connections run sequentially, and `runCategorizationDrain` imports the staged rows on its own
1-minute tick in batches of 40.

Once a connection is `active` it is re-scraped twice a day, at **07:00 and 19:00
Asia/Jerusalem** — it becomes due when `last_sync_at` predates the most recent of those
that has passed. Watch it with:

```powershell
docker logs -f smartfin_backend
```

If a connection **fails**, the card now explains why instead of showing the word "Error" —
the cause, the fix, whether it will retry on its own, and the raw scraper message behind a
**Technical details** disclosure. The case worth knowing: a wrong username on Max never
produces "invalid password". The site stays on the login page and the scraper reports a
`TIMEOUT`, which is now read as **"Couldn't sign in"** rather than "the bank was slow" —
because the retry path spends a real login attempt every hour against an issuer that locks
after about three.

### Step 3 — the cleanup screen

Reload **Settings**. The **Duplicate cleanup** section is now present.

It opens as a **summary**, not a list: duplicates found, total double-counted, the
expense/income split, and how many rows are kept. One button removes them; **Review
individually** expands the full pair list (scrollable) if you want to check or keep any.
With ~100 pairs the old inline list buried the rest of Settings, which is why the detail is
behind a toggle now.

## What to expect, and why

| # | Expect | Why |
|---|---|---|
| 1 | Roughly **95–100 expense duplicates** offered, each showing your shorthand beside the issuer's full Hebrew text | The seed mirrored 97 real transactions. A few may miss if the bank returns slightly different dates or amounts on this scrape than on the original one. |
| 2 | The **5 cash/Bit/PayBox rows are kept** — ₪73.33, ₪41.17, ₪128.44, ₪19.77, ₪256.91 | Their amounts appear nowhere in your real history (verified: zero collisions), so no import can ever match them. These are the rows a date-range delete would have destroyed permanently. |
| 3 | Around **a quarter of imported transactions appear nowhere on the screen** | The seed deliberately skipped 1 in 4. Sync found them, you never logged them, so there is nothing of yours to delete. Correct silence. |
| 4 | Pairs are **1–3 days apart**, not all same-day | The seed backdated your copies 0–2 days, the way real logging happens. This exercises the ±5-day window rather than only exact-date matches. |
| 5 | **Income**: up to 5 duplicates offered | Mirrored from your real sync-linked income. A double-counted salary is the largest possible P&L error, which is why income is covered at all. |
| 6 | Card **settlement rows never appear as a counterpart** | A row like `2624 - ישראכרט בע"מ` is the lump monthly bill, not a purchase, and is imported with no `expense_id`. |
| 7 | Where the same amount repeats, **each import absorbs only one** of your rows | One-to-one. A single ₪19.90 import cannot justify deleting every ₪19.90 you ever logged. |

## The flow

| # | Do this | Expect |
|---|---|---|
| 8 | Load the card | Every pair pre-ticked; the "kept" box lists examples with the reason. |
| 9 | Untick a few, click **Remove** | The button count tracks your selection, and only ticked rows go. The unticked ones survive the reload. |
| 10 | Check a surviving imported row in **Expenses** | It carries the category from your deleted row, if the import had none. Cleanup must not undo months of categorising. |
| 11 | Note the Dashboard total, click **Restore**, check again | Everything returns with original dates and amounts, and the total matches exactly. Restore preserves the original row ids. |
| 12 | **Rescan** after a partial removal | Removed rows are gone from the list; the archive box shows the count and remaining window. |
| 13 | Remove everything, rescan | "No duplicates found." |
| 14 | Open two tabs. Remove a row in tab A, then Remove in tab B with that row still ticked | Tab B removes only rows that are *still* duplicates — it cannot delete more than it showed you. |

## A note on your real data

Your own account has **zero real duplicates right now**. I ran the match against it: hand-logged
expenses span 2026-01-01→05-12, bank sync spans 05-16→08-14, and no pair shares an amount
within 5 days.

That is because a first sync only reaches back 90 days
(`FIRST_SYNC_LOOKBACK_MS` in `bankSyncScheduler.js`), and your manual logging stopped about a
week before that window opened.

**Duplicates can only ever appear in the 90-day overlap** between when a user stopped logging
by hand and when they connected their accounts. Anything older than 90 days at connection
time can never duplicate, because sync will never see it. For your two prod users, expect the
overlap to cover roughly their most recent 3 months of manual entries — and only if they were
still logging by hand when the accounts were connected.

## Subscriptions — what exists and what doesn't

You asked to see subscriptions created from bank sync data. **That feature does not exist.**
There is no recurring-charge detection anywhere in `backend/src`; a repeating ₪55 Netflix
charge imports as an ordinary expense every month and never becomes a `subscriptions` row.
Your three subscriptions (Netflix, Spotify, iCloud+) were all created by hand.

What *is* new and testable is the inverse: a user with a live bank/card connection gets **no**
generated `[Subscription]` expense row from the bot's daily job, because sync imports the real
charge. The subscription is still marked charged, so the job stays idempotent.

```powershell
.\bot\venv\Scripts\python.exe -m pytest tests/bot/test_scheduler.py -v -k ChargeDue
```

The seed creates three subscriptions on the test user, all with `last_charged_month` NULL:

| Name | Amount | Billing day | Due now? |
|---|---|---|---|
| Netflix | ₪55.00 | today | yes |
| Spotify | ₪22.00 | today | yes |
| iCloud+ | ₪14.00 | today + 5 | no — still ahead |

**Test A — no sync connected (do this before connecting the banks).** Run the bot's daily
job. It writes a `[Subscription] Netflix` and `[Subscription] Spotify` expense, DMs you, and
sets `last_charged_month`.

```sql
SELECT description, amount, source FROM expenses
WHERE user_id = 999000002 AND description LIKE '[Subscription]%';
```

**Test B — with sync connected.** Reset the two due subscriptions and run the job again:

```sql
DELETE FROM expenses WHERE user_id = 999000002 AND description LIKE '[Subscription]%';
UPDATE subscriptions SET last_charged_month = NULL WHERE user_id = 999000002;
```

This time **no expense row is written** and no DM is sent, but `last_charged_month` still
advances — the job stays idempotent while sync imports the real charge. Statuses counting as
live sync are `active`, `pending_first_sync` and `error`; `error` is included because errored
connections retry hourly, so the real charge still lands. `invalid_credentials` and `disabled`
never auto-retry, so they do not count.

**Test C — the P&L rule.** On the dashboard, `iCloud+` (billing day still ahead) is the only
one inside `subscription_total`, and it affects the **forecast** only — `current_net_pnl` is
actuals and excludes it. Once its day passes, it drops to zero rather than being subtracted a
second time on top of the imported charge.

If you want sync to actually *create* subscriptions from detected recurring charges, say so —
it is a real feature, not a config change.

## Starting over

Reset the test user's transactions while keeping its bank connections, so you can re-run
cleanup without reconnecting:

```sql
DELETE FROM deleted_expenses WHERE user_id = 999000002;
DELETE FROM deleted_income   WHERE user_id = 999000002;
UPDATE bank_transactions_raw SET import_status='pending_categorization', expense_id=NULL, income_id=NULL
  WHERE user_id = 999000002;
DELETE FROM expenses WHERE user_id = 999000002 AND source = 'bank_sync';
DELETE FROM income   WHERE user_id = 999000002 AND source = 'Bank Sync';
```

Then re-run the seed to restore the hand-logged side. The drain loop re-imports the staged
rows within a minute.

## Removing the test user entirely

```sql
DELETE FROM bank_transactions_raw WHERE user_id = 999000002;
DELETE FROM deleted_expenses WHERE user_id = 999000002;
DELETE FROM deleted_income   WHERE user_id = 999000002;
DELETE FROM expenses      WHERE user_id = 999000002;
DELETE FROM income        WHERE user_id = 999000002;
DELETE FROM subscriptions WHERE user_id = 999000002;
DELETE FROM bank_connections WHERE user_id = 999000002;
DELETE FROM users WHERE user_id = 999000002;
```

## Automated coverage

```powershell
cd tests; npx jest backend/duplicateMatcher.test.js backend/cleanup.test.js
```

31 tests: 16 on the pure matcher (window boundaries, one-to-one, agora precision,
timezone-safe dates, pairing determinism) and 15 on the endpoints (consent scoping, stale-id
rejection, category carry-over, rollback, restore integrity).
