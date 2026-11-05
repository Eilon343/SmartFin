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
- Only nginx's internal `:8081` block is reachable through the tunnel, and it serves
  nothing but these two paths. The dashboard, all other `/api` routes and the webhook stay
  on Tailscale only.
- Rate limit: 30 requests per minute per key.

## Setup (on the Mac Mini)

1. Run the migration:
   ```bash
   docker compose exec -T db mysql -uroot -p"$MYSQL_ROOT_PASSWORD" smartfin < db/migrate_015_agent_api_keys.sql
   ```
2. Rebuild the backend and frontend (nginx):
   ```bash
   docker compose up -d --build backend frontend
   ```
3. Create a key for your account (printed once; only its hash is stored):
   ```bash
   docker compose exec backend node scripts/createAgentKey.js create you@example.com instinct
   ```
   `list <email>` shows keys; `revoke <key_id>` disables one immediately.
4. Cloudflare Tunnel: in Cloudflare Zero Trust → Networks → Tunnels, create a tunnel, add a
   public hostname (e.g. `smartfin-agent.yourdomain.com`) with service
   `http://frontend:8081`, and copy the tunnel token into `.env`:
   ```
   CLOUDFLARE_TUNNEL_TOKEN=...
   ```
   Then start it:
   ```bash
   docker compose --profile agent up -d cloudflared
   ```
5. Check from outside:
   ```bash
   curl -H "Authorization: Bearer sfa_..." https://smartfin-agent.yourdomain.com/api/agent/snapshot
   ```
   and that everything else is closed (expect 404):
   ```bash
   curl -i https://smartfin-agent.yourdomain.com/api/expenses
   ```

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
