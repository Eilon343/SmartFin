# Task prompt: replace the Telegram-based account system with real authentication

Copy everything below the line into the agent.

---

## What you are doing

SmartFin currently has **no way to create an account from the app**. The only registration
path is sending `/link_google <email>` to a Telegram bot, and that path has two security
flaws. Replace it with proper sign-up and sign-in — email + password *and* Google — and
demote Telegram to what it should be: an optional integration you link *from* a logged-in
account, never a way to obtain one.

Read `docs/CLAUDE.md` first. It is accurate and covers architecture, conventions and the
gotchas that will bite you.

## The two flaws you are fixing

### 1. Account takeover via the Telegram webhook (High)

`backend/src/controllers/webhookController.js`, in `handleTelegramMessage`, `/link_google`:

```js
if (user.telegram_chat_id && user.telegram_chat_id !== chatId) { /* reject */ }
// ... then:
await db.query('UPDATE users SET telegram_chat_id = ? WHERE user_id = ?', [chatId, user.user_id]);
```

The guard only fires when `telegram_chat_id` is already set. For an account that exists but
has never linked Telegram — every Google-only user — it is `NULL`, the guard is skipped, and
**any Telegram user who knows the email address binds their chat to that account** and gets
full read/write access to its financial data through the bot.

Note: `POST /webhook/telegram` now fails closed when `TELEGRAM_WEBHOOK_SECRET` is unset, so
this is only reachable on a deployment that actually serves the webhook. When it is served,
the attack needs no forgery at all — an ordinary Telegram user simply sends the message.

### 2. Unverified email claiming, in both paths (Medium, but it is why #1 matters)

`bot/app/database/DatabaseManager.py::link_google_account` correctly refuses when the email
belongs to a *different* `user_id`, so the bot cannot take over an existing account. But
when **no** row owns that email, it happily writes it:

```python
"UPDATE users SET google_email = %s, telegram_chat_id = %s WHERE user_id = %s"
```

Nothing ever proves the sender controls that mailbox. An attacker claims
`victim@gmail.com` before the victim signs up; later the victim uses Google sign-in,
`authController.googleLogin` looks the email up, finds the attacker-created row, and
**issues the victim a token for the attacker's account** — which the attacker also controls
via Telegram.

## Why this cannot be patched in place

The vulnerable state — "an account exists and Telegram is not yet linked" — is exactly the
state the feature is designed to serve, because `/link_google` *is* the registration
mechanism. `googleLogin` returns `404 not_linked` with *"Send /link_google … to the bot
first"* for any unknown email. There is no sign-up endpoint at all. So the fix is to build
the missing front door, not to add another guard to the back one.

## Required outcome

1. **Email + password sign-up and sign-in, in the web app.** No Telegram involvement.
2. **Google sign-in that creates an account** on first use instead of 404-ing.
3. **Both routes reach the same account** when the email matches — signing up with a
   password and later using Google (or vice versa) must not create a second account.
4. **Telegram becomes opt-in linking from a logged-in session.** The web app issues a
   short-lived, single-use code; the bot accepts `/link <code>`. Remove `/link_google`
   from both the bot and the webhook controller.
5. **The two existing production users keep their accounts, their data and their Telegram
   links.** Data loss here is unacceptable — see the migration constraint below.

## Constraints and traps

Take these seriously; several will silently corrupt data if missed.

- **`users.user_id` is a `BIGINT` PRIMARY KEY that, for bot-origin users, equals their
  Telegram chat id.** It has no `AUTO_INCREMENT`. New sign-ups need an id that cannot
  collide with a chat id. Decide deliberately: either add `AUTO_INCREMENT` starting above
  the chat-id range, or generate ids in a reserved band. Whatever you choose, document the
  reasoning in the migration.
- **Seven tables have `FOREIGN KEY (user_id) REFERENCES users(user_id)`** (expenses, income,
  categories, subscriptions, budgets, savings_goals, bank_connections, plus
  `bank_transactions_raw`). Do **not** renumber existing users. Migrate forward around the
  existing ids.
- **`pin_hash` is the current password column** and holds a bcrypt hash of a numeric PIN
  (`authController.login` compares `String(pin)`). If you introduce real passwords, either
  reuse the column with a clear rename migration or add a new one — but keep the two prod
  users able to log in throughout. State which you did.
- **Base categories have `user_id IS NULL`** and are shared. Any "create a new user" path
  must not clone them.
- **The bot resolves users by Telegram chat id** (`user_exists(from_user.id)`), so bot
  commands silently do nothing for accounts that were not created by the bot. After this
  change most accounts will be app-origin, so the bot must resolve via `telegram_chat_id`
  instead. Audit every handler in `bot/app/bot/handlers.py`.
- **JWT payload is `{ user_id, username }`, 30-day expiry, signed with `JWT_SECRET`.**
  `frontend/src/api/client.js` wipes the token and reloads on a 401 *that carried a token*.
  Keep that contract or update both ends together.
- **`authLimiter`** already exists in `backend/src/index.js` — apply it to every new auth
  route, including sign-up and the link-code endpoints.
- **Migrations**: add `db/migrate_NNN_*.sql`, idempotent via an `INFORMATION_SCHEMA` check,
  **and** apply the same change to `db/init.sql`. Commit both together. Latest is `009`.
- **Tests mock the DB** — `tests/package.json` `moduleNameMapper` redirects
  `require('../config/db')` to `tests/backend/setup/dbMock.js`. No test may hit a real DB or
  call a real API. `tests/backend/setup/authHelper.js` mints tokens for tests.
- **The app is bilingual (English/Hebrew) and RTL-aware.** Every user-facing string goes in
  `frontend/src/context/I18nContext.jsx` in both languages. Do not hardcode copy.
- **Never commit `.env`.**

## Security requirements

- Hash passwords with bcrypt, cost ≥ 10. Never log or return a hash.
- Sign-in must not reveal whether an email exists — same error, same timing characteristics,
  for unknown email and wrong password.
- Link codes: short (6–8 chars), single-use, expire in ~10 minutes, invalidated on use,
  generated with `crypto.randomBytes` and compared in constant time. Rate-limit both
  generation and redemption.
- Verify the Google `id_token` server-side against `GOOGLE_CLIENT_ID` — `googleLogin`
  already does this correctly with `google-auth-library`; keep that.
- Decide explicitly whether to trust Google's `email_verified` claim when merging a Google
  sign-in into an existing password account, and say why in a comment. Merging on an
  unverified claim is an account-takeover path of its own.
- Do not let an attacker enumerate valid emails through the sign-up endpoint's error
  responses.

## Deliverables

- Migration(s) + matching `init.sql` changes.
- Backend: sign-up, sign-in, Google sign-in/sign-up, link-code issue and redeem. Remove
  `/link_google` handling from `webhookController.js`.
- Bot: `/link <code>`; remove `/link_google` and `link_google_account`; fix user resolution
  to work for app-origin accounts.
- Frontend: sign-up and sign-in forms alongside the existing Google button
  (`frontend/src/pages/Login.jsx`, `frontend/src/context/AuthContext.jsx`), plus the
  "Link Telegram" flow in Settings that shows the code. Mobile-first: the app has a fixed
  bottom nav under 880px and `.modal` is capped with `dvh` — check both.
- Tests: sign-up, sign-in, both-routes-same-account merging, link-code expiry, reuse and
  wrong-code rejection, and a regression test that a Telegram message can no longer bind
  itself to an account it does not already own.
- A short section in `docs/CLAUDE.md` describing the new auth model, and a note in
  `docs/DEPLOY_PRODUCTION.md` on migrating the two existing users.

## Explicit non-goals

Do not build email verification mail-sending, password reset, 2FA, OAuth providers beyond
Google, or a session/refresh-token system. Keep the 30-day JWT. If you think one of these is
required for correctness, say so and stop rather than expanding scope.

## Definition of done

- A new user can sign up with email + password in the browser, log out, and log back in.
- A new user can sign up with Google in one click.
- The same person using both routes with one email lands in **one** account.
- Telegram can only be linked from an authenticated session via a code, and the code cannot
  be reused or used after expiry.
- No Telegram message can create an account or attach itself to an account it does not
  already own.
- Both existing production users can still sign in and see all their historical data.
- `cd tests && npx jest` fully green (currently 318 passing — do not regress it), plus
  `pytest tests/bot -v` no worse than its current baseline, and `cd frontend && npm run lint`
  no worse than its current 32 errors.

## Verification

Do not report success from unit tests alone. Bring the stack up
(`docker compose up -d --build`), apply the migrations, and exercise every flow end to end
against the running app: sign up both ways, log in both ways, merge, link Telegram, and
confirm the old `/link_google` attack now fails. Show the commands and their output.
