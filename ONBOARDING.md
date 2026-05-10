# SmartFin — Developer Onboarding

Welcome! This guide gets you from zero to a running local SmartFin dev environment, end-to-end. Read it top-to-bottom the first time.

---

## 1. What is SmartFin?

SmartFin is a personal finance app with **three user-facing surfaces** sharing one MySQL database:

1. **Telegram bot** — users type things like `55 nis shawarma` or `got salary 15000`. The bot parses with Gemini AI and stores expenses/income/subscriptions.
2. **Web app (PWA)** — React + Vite dashboard for charts, budgets, savings goals, settings.
3. **Apple Pay webhook** — iOS Shortcut posts transaction text to the backend, which also parses via Gemini and writes expenses.

All three write to the **same MySQL DB**, so what you log in Telegram appears instantly on the web dashboard.

---

## 2. Architecture map

```
                ┌──────────────────────┐
                │  Telegram user       │
                └──────────┬───────────┘
                           │ messages
                           ▼
┌────────────────┐    ┌──────────┐    ┌─────────────────────┐
│  iOS Shortcut  │───▶│  bot     │    │   Frontend (React)  │
│  (Apple Pay)   │    │ (Python  │    │   served by nginx   │
└──────┬─────────┘    │  aiogram)│    │   on :8080          │
       │ POST         └────┬─────┘    └──────────┬──────────┘
       │ /webhook          │                     │ /api/*
       ▼                   │                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Backend (Node + Express, :3000)                │
│   routes/  controllers/  middleware/  config/db.js          │
└────────────────────────────┬────────────────────────────────┘
                             │ mysql2
                             ▼
                    ┌──────────────────┐
                    │  MySQL 8 (:3307) │
                    │  smartfin DB     │
                    └──────────────────┘

      Bot also talks to MySQL directly (aiomysql) for fast reads/writes.
      Both bot and backend call Gemini API for NLP parsing.
```

### Components in the repo

| Path | What it is |
|------|-----------|
| `backend/` | Node 20 + Express 5 REST API. Auth (JWT + Google OAuth), expenses, income, savings, insights, Apple Pay webhook queue. Entry: `backend/src/index.js`. |
| `bot/` | Python 3 + aiogram 3 Telegram bot. Parses NL via Gemini. Entry: `bot/app/main.py`. Handlers in `bot/app/bot/handlers.py`. Scheduler runs monthly subscriptions, budget alerts. |
| `frontend/` | React 19 + Vite 8 PWA. Pages: Dashboard, Expenses, Income, Savings, Subscriptions, Categories, Insights, Settings, Login. API client in `src/api/client.js`. |
| `db/` | Schema (`init.sql`) + migrations (`migrate_*.sql`) + `seed_test_data.sql`. |
| `nginx/` | Reverse proxy serving frontend on `:8080` and proxying `/api/` and `/webhook/` to backend. |
| `tests/` | Backend + bot + math test suites. |
| `docker-compose.yml` | Wires it all together. |

### Bot message flow (the most-asked question)

1. User sends `55 shawarma` to Telegram.
2. Telegram delivers to `bot` (long polling, `dp.start_polling`).
3. Handler in `bot/app/bot/handlers.py` calls `parse_input()` from `app/ai/ai_engine.py`.
4. `ai_engine.py` builds a prompt, calls **Gemini `gemini-2.5-flash`**, gets back a JSON array of intents (`log_expense`, `log_income`, `log_subscription`, or `ERROR_UNSUPPORTED`).
5. Handler shows confirmation buttons. On confirm, `DatabaseManager.py` inserts into MySQL.
6. Frontend polls `/api/expenses` → row appears on dashboard.

### Apple Pay webhook flow

1. iOS Shortcut POSTs `{ text, secret }` to `/webhook/applepay`.
2. `backend/src/controllers/webhookController.js` queues the job, returns 202.
3. Background queue processor calls Gemini, parses, inserts expenses with `source='apple_pay'`.

---

## 3. Prereqs — install once

You need:

1. **Git** — already have it if you cloned the repo.
2. **Docker Desktop** — runs MySQL + bot + backend + frontend in containers.
3. **Node 20+** — only if you want to run backend/frontend *outside* Docker for hot reload (recommended for frontend dev).
4. **Python 3.11+** — only if running the bot outside Docker.
5. A code editor (VS Code suggested).
6. **MySQL GUI client (optional)** — DBeaver, TablePlus, MySQL Workbench, or the VS Code "SQLTools" extension. Not required: every DB task in this guide works with `docker exec` + the `mysql` CLI inside the container. A GUI just makes browsing rows, editing data, and exploring the schema faster. Pick one if you like clicking; skip otherwise.

### 3.1 Install Docker Desktop (Windows)

1. Download: <https://www.docker.com/products/docker-desktop/>
2. Run the installer. When it asks, **enable WSL2 backend** (it will install WSL2 if missing — accept).
3. Restart Windows when prompted.
4. Launch Docker Desktop. Wait until the whale icon in the tray says "Docker Desktop is running".
5. Verify in PowerShell:
   ```powershell
   docker --version
   docker compose version
   ```
   Both should print versions, not errors.

**Tips:**
- Docker Desktop must be running every time you `docker compose up`. If you reboot, start it again.
- Settings → Resources: give it ≥4 GB RAM, ≥2 CPUs. The MySQL container alone uses ~1 GB.
- If `docker compose up` says "cannot connect to Docker daemon" — Docker Desktop isn't running.

---

## 4. Local DB vs production DB — which to use?

**Use a local DB. Always.** Don't point dev at prod. Reasons:

- Prod has real user data. A bad migration or test insert corrupts it.
- You'll want to drop/reseed tables freely while testing.
- Schema migrations (`db/migrate_*.sql`) need to be tried on a throwaway DB first.
- Network round-trips to a remote DB make every backend reload slow.
- Compose already brings up MySQL 8 in 30 seconds — there is no upside to remote.

**The only exception:** read-only debugging of a prod-specific bug. Even then, connect with a read-only user, never the dev backend.

So: spin up the `db` service in compose. It mounts `db/init.sql` automatically on first boot, creating all tables. Use `db/seed_test_data.sql` to populate fake users/expenses if you want data to look at.

---

## 5. First-time setup — step by step

### 5.1 Clone & create `.env`

```powershell
cd C:\Users\you\Desktop
git clone <repo-url> SmartFin
cd SmartFin
```

Create `.env` in the **project root** (compose reads this):

```env
# ── MySQL ────────────────────────────────────────────────
# Pick any password you like — this file IS where you set it.
# On the very first `docker compose up`, MySQL reads MYSQL_ROOT_PASSWORD
# and creates the 'root' account with that password. From then on,
# the password is BAKED INTO THE VOLUME — changing this line later
# will NOT change the actual MySQL password (see note below).
#
# DB_PASSWORD must equal MYSQL_ROOT_PASSWORD (since DB_USER=root).
MYSQL_ROOT_PASSWORD=devpassword
DB_HOST=db
DB_USER=root
DB_PASSWORD=devpassword
DB_NAME=smartfin

# ── Backend ──────────────────────────────────────────────
PORT=3000
CORS_ORIGIN=http://localhost:8080

# JWT_SECRET — signs login tokens.
#   - Pure local dev (own DB, own users): pick any long random string.
#   - Want to share login sessions with Eilon's dev DB / move tokens between machines: ask Eilon for his.
JWT_SECRET=any-long-random-string-for-dev

# WEBHOOK_SECRET — Apple Pay iOS Shortcut sends this; backend rejects mismatches.
#   - Not testing Apple Pay flow: pick any string, doesn't matter.
#   - Testing with the shared iOS Shortcut Eilon already configured: ASK EILON for the value.
WEBHOOK_SECRET=dev-webhook-secret

# ── Telegram chat ID ─────────────────────────────────────
# YOUR own numeric Telegram ID. Get it from @userinfobot.
# Used by:
#   - backend webhook (routes Apple Pay txns to this user)
#   - bot scheduler (daily spending-score messages go here)
# If you don't plan to test Apple Pay or scheduled messages, you can leave it blank
# and the bot/web app will still work fine. Recommended: set it.
TELEGRAM_CHAT_ID=

# ── Secrets you must ASK EILON for ───────────────────────
# Don't try to make these yourself for the shared dev bot —
# message Eilon and he'll send you the values.
TELEGRAM_BOT_TOKEN=     # ask Eilon (or create your own dev bot via @BotFather)
GEMINI_API_KEY=         # ask Eilon (or get your own at https://aistudio.google.com/apikey)
GOOGLE_CLIENT_ID=       # ask Eilon — must be the registered SmartFin OAuth client
```

> **Important:** Gemini model is hard-coded to `gemini-2.5-flash`. Don't switch to `1.5-flash` (404) or `2.0-flash` (quota=0 on free tier).

#### How the MySQL password actually gets set

The `mysql:8.0` image runs an entrypoint script on **first container boot** that does:
1. Reads `MYSQL_ROOT_PASSWORD` from the env (compose injects it from `.env`).
2. Runs `CREATE USER 'root'@'%' IDENTIFIED BY '<that value>'` and the equivalent for `'root'@'localhost'`.
3. Writes the data to `/var/lib/mysql` (the persisted volume).

So the password is whatever was in `.env` the first time you booted the DB. You don't run any extra command — `docker compose up db` does it for you.

**Want to change the password later?** Two options:

*Option 1 — change inside MySQL (keep your data):*
```powershell
docker exec -it smartfin_db mysql -uroot -p<OLD_PASSWORD>
```
```sql
ALTER USER 'root'@'%'         IDENTIFIED BY 'NewPassword!';
ALTER USER 'root'@'localhost' IDENTIFIED BY 'NewPassword!';
FLUSH PRIVILEGES;
```
Then update `MYSQL_ROOT_PASSWORD` and `DB_PASSWORD` in `.env` to match, and `docker compose restart backend bot`.

*Option 2 — wipe and re-init (loses all data):*
```powershell
docker compose down
docker volume rm smartfin_smartfin_mysql_data
docker volume create smartfin_smartfin_mysql_data
# Edit MYSQL_ROOT_PASSWORD in .env to whatever you want, then:
docker compose up db
```
On this fresh boot, the new password takes effect from the env.

Just editing `MYSQL_ROOT_PASSWORD` in `.env` and restarting **does nothing** — MySQL only reads it when initializing an empty data dir.

**TL;DR on what to fill yourself vs ask:**
| Variable | Source |
|---|---|
| `MYSQL_*`, `DB_*` | Pick yourself, anything works |
| `PORT`, `CORS_ORIGIN` | Pick yourself, use values shown |
| `JWT_SECRET` | Pick yourself for solo dev. **Ask Eilon** if you want shared login sessions with his DB |
| `WEBHOOK_SECRET` | Pick yourself if not testing Apple Pay. **Ask Eilon** if you'll use the shared iOS Shortcut |
| `TELEGRAM_CHAT_ID` | Yours, from `@userinfobot` (optional — leave blank if not testing webhook/scheduler) |
| `TELEGRAM_BOT_TOKEN` | **Ask Eilon** |
| `GEMINI_API_KEY` | **Ask Eilon** |
| `GOOGLE_CLIENT_ID` | **Ask Eilon** |

### 5.2 Boot everything with Docker

The MySQL volume in `docker-compose.yml` is marked `external: true`, which means compose will **not** auto-create it. You have to create it once, by hand, before the first boot:

```powershell
docker volume create smartfin_smartfin_mysql_data
```

(Do this only once per machine. Skipping it = `compose up` fails with "external volume not found".)

Then, from the project root:

```powershell
docker compose up --build
```

First run takes ~5 minutes (downloading mysql:8, building Node + Python images, npm install, pip install). Subsequent runs are seconds. On this first boot, MySQL runs `db/init.sql` automatically and creates every table.

You should see, in order:
- `smartfin_db` healthy
- `smartfin_backend` listening on port 3000
- `smartfin_bot` "SmartFin Bot is starting..."
- `smartfin_frontend` nginx serving on 8080

Open <http://localhost:8080> — you should see the SmartFin login page.

### 5.3 Verify each piece

```powershell
# Backend health
curl http://localhost:3000/health

# DB — connect with any MySQL client (or docker exec)
docker exec -it smartfin_db mysql -uroot -pdevpassword smartfin -e "SHOW TABLES;"

# Bot — send a message to your dev bot in Telegram, watch logs
docker logs -f smartfin_bot
```

### 5.4 Register yourself as a user

SmartFin is multi-user — the schema supports any number of accounts and you do **not** need to insert your row by hand. Two automatic paths:

**Path 1 — Telegram `/start`:** open your dev bot in Telegram, send `/start`. The handler in `bot/app/bot/handlers.py` calls `DatabaseManager.add_user()` which inserts a row keyed by your Telegram `user_id` and copies the shared base categories so you have Food/Transport/etc. ready.

**Path 2 — Web Google login:** open <http://localhost:8080>, click "Sign in with Google". `authController.googleLogin` either looks up the existing row by `google_email` or creates a new one. Then go to Settings → link your Telegram chat ID so the bot recognizes you.

Either path is enough. Use both if you want the same account reachable from web + bot — link them via the Settings page after logging in on the web.

### 5.5 Optional — seed fake test data

If you want some realistic-looking expenses/categories to look at without typing them in:

```powershell
docker exec -i smartfin_db mysql -uroot -pdevpassword smartfin < db/seed_test_data.sql
```

### 5.6 Re-initializing or upgrading the DB later

`db/init.sql` is the **single source of truth** for the schema. It contains every table, column, and base category in their final form. The `db/migrate_*.sql` files only exist for upgrading **existing** DBs that were created before a schema change landed; new installs can ignore them.

`init.sql` only runs on a fresh (empty) volume. If the volume already exists, MySQL ignores it.

**Wipe and rebuild from scratch (destructive — deletes all local data):**
```powershell
docker compose down
docker volume rm smartfin_smartfin_mysql_data
docker volume create smartfin_smartfin_mysql_data
docker compose up db   # init.sql runs again automatically
```

**Apply a new migration without losing data:**
```powershell
docker exec -i smartfin_db mysql -uroot -pdevpassword smartfin < db/migrate_NNN_whatever.sql
```
Migrations are idempotent (they `INFORMATION_SCHEMA`-check before altering), so re-running an applied one is safe.

---

## 6. Day-to-day dev loop

You have two reasonable patterns. Pick per service.

### Pattern A — everything in Docker (simplest)

Edit code → rebuild that service:

```powershell
docker compose up -d --build backend
docker compose up -d --build bot
```

No hot reload, but bulletproof.

### Pattern B — DB in Docker, app code on host (faster iteration, recommended)

```powershell
# Just the DB
docker compose up -d db

# Backend with nodemon (auto-reload on save)
cd backend
npm install
npm run dev   # uses nodemon; if no script, run: npx nodemon src/index.js

# Frontend with Vite HMR
cd frontend
npm install
npm run dev   # serves on http://localhost:5173 with hot reload

# Bot
cd bot
python -m venv venv
venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m app.main
```

When running on host, set `DB_HOST=localhost` and `DB_PORT=3307` in your env (compose exposes MySQL on 3307 to avoid clashing with any local MySQL on 3306).

### Useful commands

```powershell
docker compose ps                  # see what's running
docker compose logs -f backend     # tail one service
docker compose down                # stop all (data persists in volume)
docker compose down -v             # stop AND nuke DB volume — use with care
docker compose restart bot         # restart one service
```

> The MySQL volume is marked `external: true` in compose — `docker compose down` will NOT delete it. Use `docker volume rm smartfin_smartfin_mysql_data` to actually drop the data.

---

## 7. Working with the database

Schema lives in `db/init.sql`. Migrations are numbered: `migrate_001_*.sql`, `migrate_002_*.sql`, etc.

**Adding a new column / table:**
1. Add a new file `db/migrate_NNN_short_description.sql`.
2. Apply it locally:
   ```powershell
   docker exec -i smartfin_db mysql -uroot -pdevpassword smartfin < db/migrate_004_yourthing.sql
   ```
3. Also add the change to `init.sql` so a fresh boot has it from the start.
4. Commit both files together.

### 7.1 Working with the DB — no external app needed

Everything below uses the `mysql` CLI **inside the container**. Zero install on your host.

#### Open an interactive SQL shell

```powershell
docker exec -it smartfin_db mysql -uroot -pdevpassword smartfin
```

You're now at the `mysql>` prompt. Type SQL, end every statement with `;`, hit Enter. Exit with `exit` or `Ctrl+D`.

Useful inside the prompt:
```sql
SHOW TABLES;
DESCRIBE expenses;                       -- column names + types
SHOW CREATE TABLE expenses\G             -- full DDL, pretty-printed
SELECT COUNT(*) FROM expenses;
SELECT * FROM expenses ORDER BY created_at DESC LIMIT 10;
SELECT user_id, SUM(amount) FROM expenses GROUP BY user_id;
```

> Tip: end a query with `\G` instead of `;` to get vertical row format — much more readable for wide tables like `expenses`.

#### Run a one-off query without entering the shell

```powershell
docker exec -it smartfin_db mysql -uroot -pdevpassword smartfin -e "SELECT * FROM users;"
```

`-e` = execute and exit. Good for scripts or quick checks.

#### Pipe a SQL file into the DB

```powershell
docker exec -i smartfin_db mysql -uroot -pdevpassword smartfin < db/seed_test_data.sql
```

Note `-i` (no `-t`) when redirecting from a file. Use this for migrations, seeds, or any custom script.

#### Common debugging recipes

**See latest 5 expenses for a user:**
```sql
SELECT expense_id, amount, description, source, created_at
FROM expenses
WHERE user_id = 1
ORDER BY created_at DESC
LIMIT 5;
```

**Find a user by Telegram chat ID:**
```sql
SELECT * FROM users WHERE telegram_chat_id = '123456789';
```

**Check pending webhook jobs:**
```sql
SELECT id, status, LEFT(text, 60) AS preview, created_at
FROM webhook_queue
ORDER BY created_at DESC
LIMIT 20;
```

**Reset a user's data without dropping the schema:**
```sql
DELETE FROM expenses        WHERE user_id = 1;
DELETE FROM income          WHERE user_id = 1;
DELETE FROM subscriptions   WHERE user_id = 1;
DELETE FROM savings_goals   WHERE user_id = 1;
DELETE FROM budgets         WHERE user_id = 1;
DELETE FROM categories      WHERE user_id = 1;  -- only user-owned, keeps base categories
DELETE FROM users           WHERE user_id = 1;
```

**Show all tables + row counts (paste this whole block):**
```sql
SELECT table_name, table_rows
FROM information_schema.tables
WHERE table_schema = 'smartfin';
```

#### Creating a dedicated MySQL user (instead of using `root`)

Compose only sets `root` automatically. For day-to-day use it's safer to create a non-root user with a password and only grant it the `smartfin` DB. Backend/bot can then use that user instead of root.

**Step 1 — open the shell as root:**
```powershell
docker exec -it smartfin_db mysql -uroot -pdevpassword
```

**Step 2 — create the user and grant permissions:**
```sql
-- Replace 'smartfin_dev' and 'StrongPasswordHere!' with your own.
-- '%' means: connect from any host (needed because the Node/Python containers
-- talk to the DB over the docker network, not from localhost).
CREATE USER 'smartfin_dev'@'%' IDENTIFIED BY 'StrongPasswordHere!';

-- Full access to the smartfin DB only — cannot touch other databases.
GRANT ALL PRIVILEGES ON smartfin.* TO 'smartfin_dev'@'%';

FLUSH PRIVILEGES;
```

**Step 3 — verify:**
```sql
SELECT User, Host FROM mysql.user WHERE User = 'smartfin_dev';
SHOW GRANTS FOR 'smartfin_dev'@'%';
```

**Step 4 — point your app at the new user.** Edit `.env`:
```env
DB_USER=smartfin_dev
DB_PASSWORD=StrongPasswordHere!
```
Restart backend + bot:
```powershell
docker compose restart backend bot
```

**Read-only user (handy for safe inspection):**
```sql
CREATE USER 'smartfin_ro'@'%' IDENTIFIED BY 'AnotherPassword!';
GRANT SELECT ON smartfin.* TO 'smartfin_ro'@'%';
FLUSH PRIVILEGES;
```
Use this in DBeaver/Workbench when you only want to look around without risk of editing.

**Change a user's password:**
```sql
ALTER USER 'smartfin_dev'@'%' IDENTIFIED BY 'NewPasswordHere!';
FLUSH PRIVILEGES;
```

**Drop a user:**
```sql
DROP USER 'smartfin_dev'@'%';
```

> Note: MySQL identifies users as `'name'@'host'`. `'@'%'` matches any host (other docker containers, your host machine via 3307). `'@'localhost'` would only match connections from inside the DB container itself — usually not what you want here.

#### Dump / restore the whole DB

Backup:
```powershell
docker exec smartfin_db mysqldump -uroot -pdevpassword smartfin > backup.sql
```

Restore:
```powershell
docker exec -i smartfin_db mysql -uroot -pdevpassword smartfin < backup.sql
```

#### Editing data safely

Before any `UPDATE` or `DELETE`, run the same `WHERE` as a `SELECT` first:
```sql
SELECT * FROM expenses WHERE expense_id = 42;   -- check what you'd touch
UPDATE expenses SET amount = 99.99 WHERE expense_id = 42;
```

MySQL has no undo. Backup first if uncertain.

#### When CLI is not enough — using a GUI client

If you find yourself eyeballing 100+ rows, building joins by hand, or wanting to edit cells like a spreadsheet, install a GUI. **DBeaver Community** is free, cross-platform, lightweight — recommended. TablePlus, MySQL Workbench, or the VS Code "SQLTools" extension also work.

Connection settings (any client):
- Host: `localhost`
- Port: `3307` (compose maps container 3306 → host 3307)
- User: `root` (or your custom user from above)
- Password: whatever you set in `.env`
- Database: `smartfin`

---

## 8. Project conventions

- **Currency:** ILS by default, glyph `₪`. The codebase already handles UTF-8 — don't normalize the symbol.
- **DB transactions:** anything that touches multiple tables (e.g. savings deposits → expenses + savings_goals) must be wrapped in a transaction. See `savingsController.js` for the pattern.
- **Webhook auth:** Apple Pay posts include `secret` field — must match `WEBHOOK_SECRET`.
- **Bot auth:** users register either via `/start` in Telegram or via Google login on the web (then link Telegram chat_id in Settings). Bot rejects messages from unknown chat IDs.
- **Secrets:** never commit `.env`. Never paste real keys in PRs or logs.

---

## 9. Tests

```powershell
cd tests
npm install        # only first time
npm test           # backend + bot + math suites
```

If you change schema or webhook handling, run tests before pushing — there are mocks for multi-user webhooks and virtual expenses that break easily.

---

## 10. Common problems

| Symptom | Fix |
|---------|-----|
| `docker compose up` hangs on `db` | Docker Desktop not running, or port 3307 in use. `Get-NetTCPConnection -LocalPort 3307`. |
| Backend crashes: `JWT_SECRET not set` | Missing from `.env`. Add any random string. |
| Bot logs `404` from Gemini | Wrong model name. Must be `gemini-2.5-flash`. |
| Frontend shows CORS error | `CORS_ORIGIN` in `.env` doesn't match where you're loading the page from. |
| `EADDRINUSE :3000` | Backend already running on host. `docker compose down` or kill the host node process. |
| Schema seems out of date | Pulled new code with a new `migrate_NNN_*.sql`. Apply it (see §5.6) or wipe + reinit. |

---

## 11. Who to ask

- Eilon — project lead, anything about architecture decisions, prod, or Telegram bot setup.
- Check `SmartFinPrd.txt` (root) for product requirements.
- `Android_Setup_Guide.md` — installing the PWA on Android as a real app.

Welcome aboard 🛠️
