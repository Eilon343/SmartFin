# Agent API — read-only access for an external AI agent

Two GET endpoints that give a cloud AI agent (e.g. Instinct) the current financial cycle
and a "what if I spend X" calculation. Every figure comes from the same code as the
dashboard's P&L, Budgets and Insights pages, so the agent and the app never disagree.

## Privacy

The agent API **never reads bank-connection data**. It does not query `bank_connections`,
`bank_transactions_raw` or any other `bank_*` table, and no response contains a field that
reveals bank sync exists (e.g. `expenses.source`). Responses are built from explicit field
allowlists, and `tests/backend/agent.test.js` fails if a query or response breaks this.

Other boundaries:
- The agent key works **only** on `/api/agent/*`. The dashboard JWT is not accepted there,
  and the agent key is not accepted anywhere else.
- Only nginx's `:8081` block is public (Tailscale Funnel on port 8443), and it serves
  nothing but these two paths. Compose binds 8081 to 127.0.0.1. The dashboard on 443, all
  other `/api` routes and the webhook stay private to the tailnet.
- Funnel runs on **8443, never 443**: Funnel exposes a whole port, and 443 is the dashboard.
- Rate limit: 30 requests per minute per key.

## Setup (on the Mac Mini)

The deploy workflow applies `migrate_015` and rebuilds the stack, so after merging to
master only these one-time steps remain:

1. Allow Funnel for the Mac Mini in the Tailscale admin console (ACL policy → `nodeAttrs`
   with `"attr": ["funnel"]`). The first `tailscale funnel` run prints a link that enables it.
2. Publish the agent port, once (`--bg` persists across reboots):
   ```bash
   tailscale funnel --bg --https=8443 http://127.0.0.1:8081
   tailscale funnel status
   ```
3. Create a key for your account (printed once; only its hash is stored):
   ```bash
   docker exec smartfin_backend node scripts/createAgentKey.js create you@example.com instinct
   ```
   `list <email>` shows keys; `revoke <key_id>` disables one immediately.
4. Check from outside the tailnet (e.g. a phone on mobile data):
   ```bash
   curl -H "Authorization: Bearer sfa_..." https://mac-mini-home.tail61d766.ts.net:8443/api/agent/snapshot
   ```
   and that everything else is closed (expect 404):
   ```bash
   curl -i https://mac-mini-home.tail61d766.ts.net:8443/api/expenses
   ```
   and that the dashboard is NOT public (expect a timeout from outside the tailnet):
   ```bash
   curl -m 10 -i https://mac-mini-home.tail61d766.ts.net/
   ```

To take the agent offline: `tailscale funnel --https=8443 off`.

## Endpoints

All amounts are ILS. Header: `Authorization: Bearer sfa_<48 hex>`.

### `GET /api/agent/snapshot`

The current cycle (from the user's cycle anchor day, not the calendar month).

| Field | Meaning |
|---|---|
| `today`, `cycle_start`, `cycle_end`, `cycle_day`, `days_in_cycle`, `days_left` | Where we are in the cycle |
| `income_received`, `income_forecast` | Income so far / expected by cycle end |
| `spent`, `spent_fixed`, `spent_variable`, `spent_forecast` | Spending so far / expected by cycle end |
| `subscriptions_ahead`, `savings_set_aside` | Committed money still to leave / moved to savings |
| `net_now`, `net_forecast`, `net_forecast_low`, `net_forecast_high` | Balance now / expected at cycle end (range is null with < 2 months history) |
| `headroom`, `daily_allowance` | Money free for the rest of the cycle, and per day |
| `budget_total`, `budget_spent`, `budget_remaining` | Totals over categories that have a budget |
| `categories[]` | `category, is_fixed, spent, budget, remaining, pct_used, typical_cycle, daily_allowance` (budget fields null when no budget is set) |
| `upcoming_subscriptions[]` | `name, amount, category, date` — still to be charged this cycle |
| `recent_expenses[]` | Last 10: `date, amount, description, category` |

### `GET /api/agent/what-if?amount=300&category=Shopping`

`amount` is required (0 < amount ≤ 1,000,000); `category` is optional and case-insensitive.
The purchase is treated as a one-off today: it moves spending, the forecast and the headroom
by exactly `amount` (it is not extrapolated as a new daily habit).

Returns `before` and `after` (`spent, spent_forecast, net_forecast, headroom,
daily_allowance`), a `category` block with its own `before`/`after` and
`over_budget_after`, and plain verdicts: `within_headroom`,
`net_forecast_stays_positive`, `exceeds_daily_allowance`, plus an `assumption` string.
An unknown category returns 400 with `valid_categories`.

Notes for reading the numbers:
- `daily_allowance` covers the days **after** today (today counts as elapsed). It can be
  negative: that means the cycle is already committed past its income.
- Fixed categories (rent, utilities) have `daily_allowance: null`.
- `budget` includes any carry-over from previous cycles.
- Dates are Israel local time.

### `GET /api/agent/alerts`

The proactive alerts the agent polls for, worst first. Optional `since` (ISO 8601) returns
only what fired after it, so a polling agent can tell a new alert from one it has already
raised with the user; without it, the current cycle comes back (max 50).

Read-only like the rest of this API: `services/spendingAlerts.js` evaluates the rules on a
30-minute tick and writes `alert_log`, and this endpoint only reads it. That split is what
lets alerting be stateful without giving the agent a write path.

| Rule | Severity | Fires when | Cooldown |
|---|---|---|---|
| `data_stale` | critical | a sync failed, or nothing synced for 48h | daily |
| `salary_missing` | critical | no income 2 days past the expected salary day | per cycle |
| `negative_forecast` | critical | `net_forecast` below zero | per cycle |
| `pace_ahead` | high | spending outruns the elapsed share of the cycle by 15% | per cycle |
| `spending_burst` | high | 3 days cost 2.5× their normal rate | daily |
| `duplicate_charge` | high | same amount and description within 3 days | per expense |
| `salary_arrived` | normal | income landed for the cycle | per cycle |
| `unusual_expense` | normal | one charge ≥ 3× the median of the user's other recent charges (min ₪200) | per expense |

`unusual_expense` and `duplicate_charge` carry `description`, `category` and the date, so
the alert names the charge rather than only its size. `description` is whatever the import
supplied and can be empty.
| `cycle_surplus` | normal | ≥ ₪300 forecast left with ≤ 4 days to act | per cycle |

Each alert carries `rule`, `severity`, `detected_at` and a `data` block holding the numbers
behind its own verdict, so the agent phrases the alert rather than recomputing it.

**Privacy.** `data_stale` reports only `healthy`, `last_successful_sync` and
`hours_since_last_sync`. It must never gain a bank name, an account identifier or a count of
connections: the agent is not allowed to learn that bank links exist at all. The rules that
need those tables (`data_stale`, `duplicate_charge`) are precisely why detection runs in the
backend and not in the agent.

Thresholds live at the top of `backend/src/services/spendingAlerts.js`. They are deliberately
conservative — a false positive teaches the user to ignore alerts, and an ignored channel is
worth less than no channel.
