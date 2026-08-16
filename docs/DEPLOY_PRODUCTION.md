# Deploying duplicate cleanup to production

Runbook for putting **v1.2.0** on the production box — an Intel Mac mini running Linux,
with Docker native (no Desktop VM). All commands below are bash, run on that host.

Read the whole thing once before starting. The code deploy is routine; the part that needs
care is the **one-time data pass** at the end, where three months of two people's real
financial history gets de-duplicated.

---

## What is being deployed

| Change | Risk |
|---|---|
| `Settings → Duplicate cleanup` — new feature, new tables | Low. Purely additive; nothing runs unless a user clicks. |
| P&L: `subscription_total` moved out of `current_net_pnl` | **Visible.** Reported P&L numbers will change (see below). |
| Bot writes no `[Subscription]` row for synced users | Low, but changes what lands in `expenses`. |
| Sync failures now explained in the UI | None. Display only. |
| One-time in-app tour explaining sync and duplicates | None. Shows once per browser. |
| Currency glyph was rendered twice in four places | None. Display only. |
| `init.sql` gained `expenses.goal_id` (drift repair) | None. Guarded by migration. |
| Version bumped to 1.2.0 (frontend + backend) | None. |

### The P&L change users will notice

`current_net_pnl` no longer subtracts upcoming subscriptions. **Every user's "current net"
will go up** by the value of their not-yet-billed subscriptions for this month. That is the
correction — the old number subtracted money that had not left the account — but it will
look like a jump. Worth telling your brother before he sees it.

---

## Step 0 — Back up production

Non-negotiable. The cleanup pass deletes rows, and while it has a 30-day undo, a backup is
the only thing that covers *everything*.

```bash
docker exec smartfin_db sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" \
  --single-transaction --routines --triggers smartfin' \
  | gzip > ~/smartfin-backup-$(date +%Y%m%d-%H%M).sql.gz

ls -lh ~/smartfin-backup-*.sql.gz   # confirm it is not 0 bytes
```

**Rehearse on a copy first.** Restore that dump into staging and run this entire runbook
against it. It is the only way to see the real duplicate counts before they are real.

---

## Step 1 — Environment variables

**This release adds no new environment variables.** Nothing to generate, nothing to rotate.

Confirm what bank sync already needs is present, since cleanup is worthless without
imported data:

```bash
docker exec smartfin_backend node -e "
const need=['BANK_CREDENTIALS_KEY','GEMINI_API_KEY','JWT_SECRET'];
for(const k of need){
  const v=process.env[k];
  console.log(k.padEnd(24), v ? 'set ('+v.length+' chars)' : '*** MISSING ***');
}
console.log('BANK_CREDENTIALS_KEY must be 64 hex chars:',
  /^[0-9a-f]{64}\$/i.test(process.env.BANK_CREDENTIALS_KEY||'') ? 'ok' : 'INVALID');
"
```

- `BANK_CREDENTIALS_KEY` — 64 hex chars; the backend refuses to boot without it.
  **If bank sync is already live in prod, this key already exists — do not regenerate it.**
  Rotating it makes every stored credential undecryptable, and every connection fails with
  "Your saved credentials could not be read" until reconnected by hand.
- If bank sync has *never* run in prod: `openssl rand -hex 32`
- Env lives in the repo root `.env` (and `backend/.env`); root fills gaps with
  `override: false`. Neither is in git — they exist only on the machine.
- **Back the key up somewhere off the machine.** Losing it means re-entering every bank
  credential.

---

## Step 2 — Check which migrations prod already has

```bash
docker exec smartfin_db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -D smartfin -e "
SELECT
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=\"bank_connections\") AS mig003_bank_sync,
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=\"expenses\" AND COLUMN_NAME=\"goal_id\") AS mig004_goal_id,
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=\"deleted_expenses\") AS mig008_archive;
"'
```

`mig003_bank_sync` must be `1` before this feature means anything. If `mig004_goal_id` is
`0`, migration 008 repairs it — that is deliberate, since `init.sql` had drifted.

Run any missing earlier migrations in numeric order first. All are idempotent.

---

## Step 3 — Pull the code

```bash
cd /path/to/SmartFin
git fetch origin
git checkout dev
git pull origin dev
git log --oneline -1
```

> If prod tracks `master`, merge `dev` into `master` first and deploy that. Do not deploy a
> detached HEAD — the rollback below needs a branch.

---

## Step 4 — Run migration 008

Run this **before** starting the new code. The new backend expects `deleted_expenses` to
exist; the old backend does not care that it does, so this ordering is safe either way.

```bash
docker exec -i smartfin_db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" smartfin' \
  < db/migrate_008_dupe_cleanup_archive.sql
```

Idempotent and additive only — it creates two tables and adds a column if missing. It never
drops or rewrites anything. Re-running prints `expenses.goal_id already exists`, which is
success, not an error.

Verify:

```bash
docker exec smartfin_db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -D smartfin -e "
SHOW COLUMNS FROM deleted_expenses LIKE \"batch_id\";
SHOW COLUMNS FROM deleted_income   LIKE \"batch_id\";
"'
```

Both must return a row.

---

## Step 4b — Run migration 010 (real authentication)

Run this **before** starting the new code — the new backend queries `users.email` and
`users.password_hash`, neither of which exists until it has run.

```bash
docker exec -i smartfin_db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" smartfin' \
  < db/migrate_010_real_auth.sql
```

**What it does to existing users: nothing.** No row is renumbered, no id changes, no data
moves. It only:

1. makes `user_id` `AUTO_INCREMENT` starting at 10^13 (above the Telegram chat-id range, so
   new sign-ups can never collide with a legacy bot-origin id),
2. renames `google_email` → `email` and lowercases it,
3. adds `password_hash` and **drops `pin_hash`**,
4. creates `telegram_link_codes`.

Dropping `pin_hash` is safe: nothing in the codebase ever wrote it, so no user could have
had a working PIN. **The two existing production users sign in with Google exactly as
before** — their `email` (formerly `google_email`) and their `telegram_chat_id` are
untouched, so both the web app and the bot keep working for them with no action on their
part. They can set a password later from the app if they want one.

Verify — the two users must still be there, with their emails and Telegram links intact,
and the counter must be at the floor:

```bash
docker exec smartfin_db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -D smartfin -e "
SELECT user_id, email, telegram_chat_id IS NOT NULL AS tg FROM users;
SELECT AUTO_INCREMENT FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA=\"smartfin\" AND TABLE_NAME=\"users\";
SHOW COLUMNS FROM users LIKE \"password_hash\";
SHOW TABLES LIKE \"telegram_link_codes\";
"'
```

Expect: both original rows with their original `user_id` and `email`, `AUTO_INCREMENT` =
`10000000000000`, and a row for each of the last two checks.

> **The bot changes behaviour here.** `/link_google` is gone. An unlinked chat now gets an
> instruction to link from Settings instead of silently doing nothing. Existing linked users
> are unaffected because the bot resolves them by `telegram_chat_id`, which is what their
> rows already carry.

---

## Step 5 — Rebuild and restart

Backend, frontend **and bot** all changed. The bot image has no source mount, so it must be
rebuilt, not just restarted.

```bash
docker compose up -d --build backend frontend bot
docker compose restart frontend
```

Platform note: Intel + Linux is the straightforward case — `node:20-alpine` +
`apk add chromium` on `x86_64`, Docker running natively rather than in a VM. No
architecture or emulation concerns.

Two things that do matter on native Linux Docker:

- `mem_limit: 1g` on the backend is a **hard** cgroup limit, not advisory. Chromium is
  memory-hungry, and connections are scraped sequentially precisely so only one browser is
  alive at a time. If the backend restarts mid-sync, check
  `docker inspect smartfin_backend --format '{{.State.OOMKilled}}'` before assuming a bug.
- `init: true` is already in compose and is load-bearing. Chromium re-parents its zygote and
  crashpad children to PID 1 when a scrape ends; without tini reaping them, every sync leaks
  ~4 zombies until the container exhausts its PID budget.

**The `restart frontend` above is not optional.** Recreating the backend container changes
its IP and nginx caches the old one — the symptom is every `/api/*` call returning 404/502
while the site itself loads fine.

Verify:

```bash
docker ps --format "{{.Names}}\t{{.Status}}"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/cleanup/duplicates
# 401 is correct here — the route exists and auth is enforced
docker logs -f smartfin_backend
```

---

## Step 6 — Smoke test before touching anyone's data

Sign in as yourself and confirm:

1. The **what's new tour** appears once, and does not reappear after dismissing + reloading.
   It is also reachable again from Settings → What's new.
2. Dashboard loads; P&L moved as described above and nothing is `NaN`.
3. **Settings shows no Duplicate cleanup section** if nothing has been imported yet — it is
   hidden by design until sync has staged real transactions.
4. Income page shows `₪1,234.00`, not `₪₪1,234.00`.
5. Telegram `/clean_dupes` replies pointing at the web app.

---

## Step 7 — The data migration (the part that needs care)

Do this **per user**, one at a time, finishing one before starting the next.

### 7a. Connect the accounts

In `Settings → Bank & card sync`, connect the bank **and every credit card**. Cards matter:
the bank feed only shows one lump settlement per card, not the purchases behind it, and a
settlement can never act as a counterpart for cleanup.

Type credentials carefully. A wrong username on Max does not report "invalid password" — it
hangs on the login page and reports a timeout, and that path retries **hourly**. Israeli
issuers lock after roughly three failed attempts. The UI now says *"Couldn't sign in — the
site never got past the login page"* for exactly this case: stop and fix the username rather
than letting it retry.

### 7b. Wait for the first sync to finish

A new connection is due immediately, so it starts within ~2 minutes; allow **5–10 minutes**
for all connections. After that each re-syncs on a rolling 24h.

```bash
docker exec smartfin_db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -D smartfin -e "
SELECT user_id, company_id, status, last_sync_at, last_sync_status FROM bank_connections;
SELECT user_id, import_status, COUNT(*) FROM bank_transactions_raw GROUP BY user_id, import_status;
"'
```

Wait until every connection is `active` and nothing is left `pending_categorization`.
**Do not run cleanup on a partial sync.** During testing this produced 93 duplicates instead
of 102, because one card had not finished importing — rows with no counterpart *yet* show as
"kept", and you would leave real duplicates behind.

### 7c. Review and remove

Open `Settings → Duplicate cleanup`. It opens as a summary: duplicates found, total
double-counted, expense/income split, and how many rows are kept.

Before clicking Remove:

- **Expand "Why N rows are being kept."** Those should be cash, Bit, PayBox — spending that
  never reaches a bank feed. If something there looks like it *should* have matched, stop and
  investigate.
- **Click "Review individually"** and scan a handful of pairs. Each shows the user's row
  beside the imported transaction: same amount, within a few days.

Then **Remove**. Everything removed is restorable for 30 days from the same screen.

### 7d. Verify the money

Compare a completed month before and after. It should drop by exactly the duplicated amount.

```bash
docker exec smartfin_db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -D smartfin -e "
SELECT user_id, DATE_FORMAT(created_at,\"%Y-%m\") m, ROUND(SUM(amount),2) total, COUNT(*) n
FROM expenses WHERE is_virtual=FALSE GROUP BY user_id, m ORDER BY user_id, m;
SELECT user_id, COUNT(*) archived, ROUND(SUM(amount),2) FROM deleted_expenses GROUP BY user_id;
"'
```

---

## How much will actually be duplicated?

Probably less than you expect. A first sync only reaches back **90 days**
(`FIRST_SYNC_LOOKBACK_MS`). Anything logged by hand more than 90 days before you connect
**can never be duplicated**, because sync will never see it.

So the exposure is the overlap between "still logging by hand" and "accounts connected" — at
most the most recent 3 months, and only for entries that went through a connected account.

On the staging account this was zero: hand-logged entries stopped 2026-05-12, sync began
2026-05-16, no overlap at all. Check each prod user before assuming there is work to do:

```bash
docker exec smartfin_db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -D smartfin -e "
SELECT user_id, source, MIN(DATE(created_at)) first_d, MAX(DATE(created_at)) last_d, COUNT(*) n
FROM expenses WHERE is_virtual=FALSE GROUP BY user_id, source ORDER BY user_id;
"'
```

If a user's hand-logged range ends more than 90 days ago, connecting now produces no
duplicates and step 7c will simply say so.

---

## Rollback

**Code only** (keeps the migration — harmless, the tables sit unused):

```bash
git checkout cad5b82
docker compose up -d --build backend frontend bot
docker compose restart frontend
```

**Undo a cleanup pass** — use Restore in the UI, within 30 days. Rows return with their
original ids, dates and amounts. To see what is restorable:

```sql
SELECT batch_id, COUNT(*), MIN(deleted_at) FROM deleted_expenses GROUP BY batch_id;
```

Prefer the UI button over a manual re-insert: it verifies every row landed before dropping
the archive copy.

**Full restore** from the Step 0 dump:

```bash
gunzip -c ~/smartfin-backup-YYYYMMDD-HHMM.sql.gz \
  | docker exec -i smartfin_db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" smartfin'
```

---

## Things that will bite you

- **Disconnecting a bank permanently un-matches its imports.** Dropping a connection cascades
  away its `bank_transactions_raw` rows, but the expenses they created stay behind
  (`expense_id` is `ON DELETE SET NULL`). Cleanup reads provenance from the staging table, so
  those rows can never be matched again. **Run cleanup before disconnecting anything.**
- **The archive purges after 30 days.** The daily purge job starts a minute after boot. If you
  need longer, change `RESTORE_WINDOW_DAYS` in `cleanupController.js` *before* deploying.
- **`db/seed_dupe_from_real_data.sql` must never run against prod.** It reads user
  `938418219` and writes test user `999000002`. It is a dev fixture, in the repo only because
  it documents how the feature was tested.
- **Two tabs running cleanup at once is safe but looks alarming** — the server re-verifies
  every id and rejects stale ones, which the second tab reports as "rejected".

---

## Post-deploy checklist

- [ ] Backup taken and verified non-empty
- [ ] Runbook rehearsed against a restored copy in staging
- [ ] `BANK_CREDENTIALS_KEY` present, 64 hex, **unchanged**, backed up off-machine
- [ ] Migration 008 applied; `deleted_expenses` / `deleted_income` exist
- [ ] All four containers up; `/api/cleanup/duplicates` returns 401 unauthenticated
- [ ] Frontend restarted after the backend rebuild
- [ ] Smoke test passed (tour shows once, P&L sane, no doubled `₪`, cleanup hidden pre-sync)
- [ ] User 1: accounts connected, sync complete, cleanup reviewed and run, totals verified
- [ ] User 2: same
- [ ] Both users told their "current net" went up because upcoming subscriptions are no
      longer subtracted from it
