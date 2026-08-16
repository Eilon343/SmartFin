# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SmartFin — personal finance app with **three user-facing surfaces sharing one MySQL database**:

1. **Telegram bot** (`bot/`, Python 3 + aiogram 3) — users type natural language (`55 nis shawarma`, `got salary 15000`); parsed by Gemini.
2. **Web PWA** (`frontend/`, React 19 + Vite 8) — dashboard, charts, budgets, savings, settings.
3. **Bank & card sync** (`backend/src/services/`) — scrapes the user's banks and credit cards once every 24h with `israeli-bank-scrapers` (headless Chromium), stages transactions, categorizes them with Gemini, writes expenses/income. (Rolling 24h from the last success, not a fixed overnight hour — the 2-minute loop only polls for what is due.)

All three write the same DB, so a Telegram entry shows on the web dashboard immediately.

**Removed:** the Apple Pay webhook (`POST /webhook/apple-pay`). A tap-to-pay purchase is a credit-card purchase, so the card connection already imports it with the real merchant name — running both double-counted everything. `POST /webhook/telegram` remains. The bot's `/clean_applepay` clears the duplicates left behind.

`ONBOARDING.md` is the full setup/dev-environment guide — read it for `.env` contents, Docker volume setup, DB recipes. This file covers architecture + gotchas.

## Commands

```powershell
# Full stack (first run ~5 min)
docker volume create smartfin_smartfin_mysql_data   # once per machine — volume is external:true
docker compose up --build

# Rebuild one service after a code change
docker compose up -d --build backend   # or bot, frontend

# Backend on host (no `dev` script in backend/package.json — run nodemon directly)
cd backend && npm install && npx nodemon src/index.js

# Frontend on host (Vite HMR on :5173)
cd frontend && npm install && npm run dev
cd frontend && npm run lint && npm run build

# Bot on host
cd bot && python -m venv venv && venv\Scripts\Activate.ps1 && pip install -r requirements.txt && python -m app.main

# Tests — all live in tests/, separate from source
cd tests && npm install && npm test          # backend + math (Jest)
cd tests && npx jest backend/pnl.test.js      # single suite
pytest tests/bot -v                            # bot (pytest, needs pip install pytest pytest-asyncio)
pytest tests/math/test_pnl_math.py -v
```

When running on host set `DB_HOST=localhost`, `DB_PORT=3307` (compose maps container 3306 → host 3307).

## Architecture

### Backend (`backend/src/`)
Express 5. `index.js` → `routes/expenseRoutes.js` (all `/api/*` routes, each behind `auth` middleware) + `routes/webhookRoutes.js`. Controllers hold all logic; no service layer. `config/db.js` exports a `mysql2/promise` pool — `db.query()` everywhere; use `db.getConnection()` + `beginTransaction` only for multi-table writes.

`index.js` loads `backend/.env` first, then root `.env` with `override: false` (root fills gaps like GEMINI/JWT). `trust proxy` is set for nginx so rate-limit sees real client IP.

### Bot (`bot/app/`)
`main.py` boots: `DatabaseManager` (own `aiomysql` pool, direct DB access — does NOT go through the backend), aiogram dispatcher, APScheduler. `bot/handlers.py` — any non-command text → `ai_engine.parse_input()` → confirmation buttons via FSM (`bot/states.py`) → `DatabaseManager` insert. `scheduler.py` — daily subscription billing (idempotent per month via `last_charged_month`), Saturday 09:00 spending-score DM.

### Frontend (`frontend/src/`)
`api/client.js` — axios instance; injects JWT from `localStorage.sf_token`, wipes token + reloads on a 401 *with* a token. `App.jsx` — routes under `PrivateRoute`/`PublicRoute`; Google One-Tap auto-auth. Pages call the API directly; no state library. Contexts: `AuthContext`, `ThemeContext`, `I18nContext` (Hebrew/English, app is RTL-aware).

### Bank & card sync (`backend/src/services/`)
`bankSyncScheduler.start()` runs two independent loops from `index.js`: `runSyncCycle` every 2 min (scrapes connections that are due) and `runCategorizationDrain` every 1 min (imports staged rows). `bankScraperService.js` wraps `israeli-bank-scrapers` and force-kills the browser in a `finally` — Chromium leaked a process per scrape without it, and compose needs `init: true` so tini reaps the orphans.

- **Credentials** are AES-256-GCM encrypted under `BANK_CREDENTIALS_KEY` (64 hex chars; the backend refuses to boot without it). Never returned by any API.
- **Two-stage import**: scrape → `bank_transactions_raw` (staging) → classify → `expenses`/`income`. `classifyRow()` is pure and holds every money rule; test it there.
- **Dedup identity** is content-based (`hashTxn`): account + date + amount + description + occurrence index. NOT `txn.identifier` — on Otsar HaHayal that field identifies the counterparty, so 51 transactions shared 11 identifiers.
- **Only `status='completed'` rows are imported.** A pending charge can change amount/date on settlement, which makes it a different hash — importing the pending version would double-count.
- **Dates**: the scraper reports Israel-local midnight as UTC (`…T21:00:00.000Z`), so always use `bankDateOf()`, never `toISOString().slice(0,10)`. Truncating in UTC dated every transaction one day early.
- **Counting new rows**: compare against known hashes, never `affectedRows` — mysql2 uses `CLIENT_FOUND_ROWS`, so a matched duplicate also reports 1.
- **Card settlements**: a bank row like `2624 - ישראכרט בע"מ` duplicates that card's own purchases, so it is skipped — but ONLY when the card is actually connected, otherwise the money vanishes. `reconcileSettlements()` retires settlements already imported before the card was added.
- **'error' connections retry hourly** (paced by `last_attempt_at`); `invalid_credentials` never auto-retries — Israeli banks lock after ~3 bad logins.

### Two separate Gemini parsers — keep aware of both
- `bot/app/ai/ai_engine.py` — multi-intent (`log_expense` / `log_income` / `log_subscription` / `ERROR_UNSUPPORTED`), returns a JSON array.
- `backend/src/controllers/webhookController.js` `buildPrompt()` — expense-only, Telegram-webhook path.
Both call Gemini, both retry 3× with backoff on 429/5xx, both have their own prompt. Changing parsing behavior usually means editing both. Bank sync has a third, batch prompt (`callGeminiForCategories`) that categorizes up to 40 rows per request and accepts only category names that already exist.

**Gemini model is hard-coded to `gemini-2.5-flash`.** `1.5-flash` 404s on v1beta; `2.0-flash` has quota 0 on the project key. Do not change it.

### Auth model (migration 010)

Accounts are created **in the web app only** — email+password or Google. The bot can no
longer create one, which is the whole point: `/link_google <email>` used to be the sole
registration path, and it took the address on the sender's word.

- **`users.email` is the single identity column** (renamed from `google_email`), `UNIQUE`,
  always stored and queried **lowercased**. One column is what makes "sign up with a
  password, later use Google, land in the same account" a lookup rather than a merge.
- **`password_hash` is nullable** — NULL means a Google-only account, a valid state.
  `pin_hash` and the `user_id`+PIN login are gone; nothing in the repo ever wrote that column.
- **Sign-in leaks nothing.** Unknown email, wrong password and Google-only account all return
  an identical `401 invalid_credentials`, and the unknown/NULL paths still run a full bcrypt
  compare against a dummy hash so they cost the same time. Sign-up answers a taken address
  with the same uniform 409 as any other rejection — do not add a distinct "already exists".
- **Google merge gates on `email_verified`.** Creating a new account from a Google sign-in
  does not require it (first claim, nothing to take over), but merging into an account that
  already has a `password_hash` does. Google sets the flag only for addresses it verified;
  merging without it would let anyone attach an arbitrary address to a Google account and
  walk into the password account that owns it.
- **Telegram is linked from an authenticated session.** `POST /api/auth/telegram/link-code`
  issues an 8-char Crockford-base32 code, single-use, 10-minute expiry, stored only as a
  SHA-256. The bot redeems it with `/link <code>`. Redemption is one conditional `UPDATE`
  claimed via `affectedRows`/`rowcount`, so concurrent redemptions cannot both win, and
  unknown/expired/used all collapse to one message so the code space can't be probed.
  The rule has **two implementations** — `backend/src/services/telegramLink.js` and
  `DatabaseManager.redeem_link_code` — because the aiogram bot talks to MySQL directly.
  Change one, change the other (same arrangement as the two Gemini parsers).
- **Auth routes live in `routes/authRoutes.js`.** Anything under `/api/auth` inherits
  `authLimiter` (20 / 15 min) automatically; `apiLimiter` skips those paths. `GET /api/me` is
  deliberately **not** under `/api/auth` — Settings polls it while a link code is live, which
  would exhaust the strict bucket in under two minutes.
- **Never add a query to `middleware/auth.js`.** Its single `SELECT` is the first entry in the
  positional `mockResolvedValueOnce` queue of all 14 backend test files.

### In-app tours
Both tours render from one component, `components/ui/TourDeck.jsx` — paged card, dots,
back/next, and swipe (horizontal drag ≥45px that is ≥1.2× the vertical travel, so it cannot
fire while someone is scrolling the body copy; RTL mirrors it). A tour is a page list plus
`${prefix}_${key}_title` / `_body` keys and nothing else. Keep them sharing the deck: the
moment one is restyled alone they stop matching.

- **What's-new** (`WhatsNewModal`) is per-browser, keyed to a feature version in
  `lib/whatsNew.js`. Right for a release announcement.
- **Welcome** (`WelcomeModal`) is per-ACCOUNT, via `users.onboarded_at` (migration 011) —
  an introduction to the app should happen once ever, not once per device. Migration 011
  backfills every pre-existing user so nobody is introduced to an app they already use;
  both tours stay replayable from Settings.
- Layout holds `showWelcome` as a **tri-state** (`null` = /api/me hasn't answered).
  "Unknown" must stay distinct from "not needed" or what's-new flashes up in the gap.
  Finishing the welcome also retires what's-new — for a new user, all of it is new.

### Webhook queue (Gemini-down fallback)
When Gemini returns 429/5xx after retries, the request is marked `unavailable` and the text is inserted into `webhook_queue` (status `pending`) instead of failing. `startQueueProcessor()` in `webhookController.js` drains the queue every 5 min.

`POST /webhook/telegram` is authenticated by `TELEGRAM_WEBHOOK_SECRET` against the `X-Telegram-Bot-Api-Secret-Token` header — enforced only when the variable is set, since the bot long-polls by default and the endpoint may be unused. Unset means anyone can forge an update from any chat id.

## Data model gotchas (`db/init.sql` is the schema source of truth)

- **`users.user_id` is `BIGINT AUTO_INCREMENT` starting at 10^13** (migration 010). Legacy bot-origin rows predating it have `user_id` = their Telegram chat ID; chat ids sit below 10^11, so the ranges cannot collide. Nothing derives an id from Telegram any more. `telegram_chat_id` is the only link between a chat and an account — **always resolve a Telegram user through it, never by treating the chat id as `user_id`**.
- **Base categories have `user_id IS NULL`** (shared across all users). Category queries are always `WHERE user_id IS NULL OR user_id = ?`.
- **`categories.is_fixed`** — flat monthly costs (Housing, Utilities, Savings). Drives P&L forecasting: fixed expenses are NOT run-rated to month-end, variable ones are.
- **`expenses.is_virtual = TRUE`** — savings-goal transfers, not real spending. Excluded from summaries/budgets via `is_virtual = FALSE`; the savings deposit (`savingsController.depositToGoal`) writes the virtual expense + bumps `savings_goals.saved_amount` inside one transaction.
- **P&L** (`expenseController.getPnL`): `fixed_income + max(variable_actual, variable_avg) − projected_expenses − subscription_total − savings_allocation`. Supports a `?as_of_day=N` MTD clamp for fair same-length month-vs-month comparison. The formula comment block above `getPnL` is authoritative — read it before touching P&L math.
- **`expenses`/`income` are dated by `created_at`**, so any importer must write it explicitly from the source's transaction date or the row lands on the day the job ran.
- **Subscriptions are a forecast, not a ledger entry.** `subscription_total` counts only subscriptions not yet billed in the requested month (future month → all; current → billing day still ahead; past → 0) — once the day passes, bank/card sync has imported the real charge into `expenses`, and counting both subtracted the same money twice. Because it is forward-only it lands in `forecasted_net_pnl` **only**; `current_net_pnl` is actuals and excludes it, otherwise the dashboard's month-vs-month delta penalised the current month by charges that had not happened in either month. For the same reason the bot's daily job writes no `[Subscription]` expense row for users with a live `bank_connections` row (`has_active_bank_sync` — `active`/`pending_first_sync`/`error`, since errored connections are retried hourly); users without sync keep the generated row.
- **Duplicate cleanup is archive-based, not a delete** (migration 008). Once sync is connected it re-imports purchases already logged by hand, so `Settings → Duplicate cleanup` removes the hand-logged copy. Rows move to `deleted_expenses`/`deleted_income` — created with `LIKE` so they track their source table's columns — keeping their original primary key, and are purged after `RESTORE_WINDOW_DAYS` (30). A `deleted_at` flag was rejected: it would need `AND deleted_at IS NULL` on ~20 reads, and one missed filter inflates every total silently. **Matching rules live in `services/duplicateMatcher.js` and it is pure — test money logic there.** Same amount within ±5 days, one-to-one, closest date wins; descriptions are never compared (you type "shawarma", Isracard says `שווארמה הקסם`). A date range is never sufficient evidence — cash/Bit/PayBox never reach a feed and deleting by window would erase them. Provenance comes from `bank_transactions_raw`, not `expenses.source`, which is also how income (whose `source` is a label like 'Salary', not an origin) is covered without a schema change. Skipped card settlements have no `expense_id` and so can never authorise a deletion. The client sends explicit ids and the server re-verifies each is still matched, so a sync landing between preview and confirm cannot widen the deletion. `db/seed_dupe_from_real_data.sql` mirrors the real account's imported transactions into test user `999000002` as hand-logged rows, so connecting the same banks to that user produces genuine duplicates; `TESTING_DUPE_CLEANUP.md` is the walkthrough.
- **`bank_transactions_raw.expense_id`/`income_id` are `ON DELETE SET NULL`** (migration 007). They were RESTRICT, which made deleting a bank-imported expense in the web UI fail with a 500. The staged row stays `import_status='imported'`, so an unlinked row is never re-imported.

## Conventions

- Currency ILS, glyph `₪`. Codebase is UTF-8 throughout (Hebrew expense descriptions are normal) — don't normalize.
- **Migrations**: add `db/migrate_NNN_description.sql` (idempotent — `INFORMATION_SCHEMA`-check before altering) AND apply the same change to `init.sql`. Commit both together.
- Backend tests mock the DB: `tests/package.json` `moduleNameMapper` redirects every `require('../config/db')` to `tests/backend/setup/dbMock.js`. No test hits a real DB or calls real APIs.
- Never commit `.env`.
