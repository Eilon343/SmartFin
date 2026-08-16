# SmartFin — How every number the user sees is calculated

Source of truth for the math behind the Dashboard, the Insights page, and the bot's weekly DM.
Derived from `backend/src/controllers/expenseController.js` (P&L, budgets, summary),
`insightsController.js`, `incomeController.js`, `savingsController.js`,
`frontend/src/pages/Dashboard.jsx`, `frontend/src/pages/Insights.jsx`, and `bot/app/scheduler.py`.

---

## 1. P&L — `GET /api/pnl?month=YYYY-MM[&as_of_day=N]`

`expenseController.getPnL`. One request returns both an **actuals** figure and a **forecast** figure.

### Inputs (6 parallel queries)

| Field | Query | Notes |
|---|---|---|
| `fixed_sum` / `variable_sum` | `expenses` for the month, `is_virtual = FALSE`, grouped by `categories.is_fixed` | NULL category → treated as **variable** |
| `subscription_total` | `subscriptions` active + not paused, **only those not yet billed in `month`** | see below |
| `savings_allocation` | `expenses` where `is_virtual = TRUE` | actual transfers into savings goals |
| `fixed_income` | `income` where `type='fixed' AND month = ?` | `income.month` is a `YYYY-MM` column, not a date |
| `variable_actual` | `income` where `type='variable' AND month = ?` | |
| `variable_avg` | same, over the previous **3** months (`VARIABLE_INCOME_LOOKBACK`) | denominator = `COUNT(DISTINCT month)` **with data**, not a hard 3 — partial history isn't dragged down |

Expenses are dated by `created_at`, so any importer must set it explicitly from the source date.

### The two headline numbers

```
current_net_pnl   = (fixed_income + variable_actual) − total_expenses − savings_allocation
forecasted_net_pnl = projected_income − projected_expenses − subscription_total − savings_allocation
```

- **`current_net_pnl` is actuals only.** Subscriptions are deliberately *not* subtracted here — they represent money that hasn't moved yet, and including them broke the month-over-month delta (a past month always scores 0 subscriptions, so the current month looked artificially worse).
- **`projected_income` = `fixed_income + max(variable_actual, variable_avg)`.** The `max` means a good month is never talked down by a weak 3-month average, but a slow month still assumes the average will arrive.

### Expense projection (smart forecast)

Only applies when `month` is the **current** month and no MTD clamp is active.

```
projected_expenses = fixed_sum + projected_variable
```

Fixed categories (`categories.is_fixed` — Housing, Utilities, Savings) are flat monthly costs, already paid, so they are **not** run-rated. Variable spend is:

```
daily_rate       = variable_sum / day_of_month
naive_projection = daily_rate × days_in_month
```

with **early-month dampening**: before day 5 (`MIN_DAYS_FOR_FULL_PROJECTION`), the result is blended between actual and the naive projection with weight `day / 5`. Without this, a ₪400 grocery run on the 2nd would forecast a ₪6,000 month.

### Subscriptions — forecast, not ledger

`subscription_total` counts only subscriptions whose charge is **still ahead**:

- future month → all of them
- current month → only those with `day_of_month > DAY(CURDATE())`
- past month → **0**

Rationale: once the billing day passes, bank/card sync has already imported the real charge into `expenses`, and that charge is inside `projected_expenses`. Counting the subscription too subtracted the same money twice. Because it is forward-looking, it is **never pro-rated** by the MTD clamp, and it belongs only to `forecasted_net_pnl`.

The same rule drives the bot: the daily subscription job writes no generated `[Subscription]` expense row for users with an active bank connection (`has_active_bank_sync`); users without sync still get the generated row.

### The MTD clamp (`?as_of_day=N`)

Used for fair month-vs-month comparison — May 1–8 vs April 1–8, so a completed previous month doesn't look better simply because it's complete. `N` is clamped to `[1, days_in_month]` of the *queried* month, which handles 31-vs-30/28/29 and leap Februaries automatically.

Two clamping mechanisms, because the tables differ:

- **Expenses & savings transfers** have a real `created_at`, so they are clamped in SQL (`created_at < month-01 + N DAY`).
- **Income** lives in a per-month table with no day granularity, so it is **pro-rated** by `N / days_in_month`.

Under MTD, `projected_expenses = total_expenses` (no run-rate) and `forecasted_net_pnl = current_net_pnl − subscription_total`.

---

## 2. Dashboard (`frontend/src/pages/Dashboard.jsx`)

Loads 7 endpoints in parallel via `Promise.allSettled` (partial failure degrades gracefully rather than blanking the page).

### Net Position card

- **Big number** = `current_net_pnl`, one decimal.
- **Forecast callout** = `forecasted_net_pnl`, colored emerald/rose on sign.
- **Month-over-month chip.** The dashboard fires a *second* `/pnl` call for the previous month. When viewing the live current month it appends `&as_of_day=<today>`, so the comparison is same-length-window. `diff = current_net_pnl − prev.current_net_pnl`.
  `safePctChange()` guards the ratio: `prev == null → N/A`, `prev == 0 && curr == 0 → 0.0%`, `prev == 0 && curr ≠ 0 → N/A` (never a fake Infinity or 100%).
- **In / Out / Save row** = `total_income_actual`, `total_expenses`, `savings_allocation`.
- **Trend sparkline** is computed **client-side** from the `/expenses` list, not from an API: expenses bucketed by day-of-month (skipping `is_virtual`), then **cumulative**. For the current month it stops at today; for a past month it runs to the last day. So the line only ever rises.

### Category budget cards — `GET /api/budgets`

`getBudgets` returns one row per budget *plus* one row per category with no budget (`no_budget: true`) *plus* an `Uncategorized` row if null-category spend exists. All expense sums exclude `is_virtual`.

**Carry-over** is replayed month by month from the budget's `created_at` month up to the requested month:

```
for each earlier month m:
    leftover = (limit + carry) − spent(m)
    carry    = max(leftover, 0)          # deficits do NOT roll forward
effective_limit = monthly_limit + carry
remaining       = effective_limit − spent_this_month
pct_used        = spent / effective_limit
```

Bar tone thresholds (frontend `ProgressBar.tone`): green < 50%, amber 50–80%, rose > 80%.

### Income card — `GET /api/income/summary`

Fixed and variable **actuals** for the month, grouped by `source`. Note: despite the function's doc comment, this endpoint does **not** average variable income — the `getPast3Months` helper at the bottom of `incomeController.js` is dead code. Averaging happens only inside `/pnl`.

### Subscriptions mini-card

Pure client-side sum of non-paused subscription amounts. This is a *catalogue* total (every active subscription), which is intentionally different from `pnl.subscription_total` (only charges still ahead this month).

### Savings card

`pct_complete = saved_amount / target_amount`, computed backend-side and only for non-ongoing goals; ongoing/investment goals have `target_amount = NULL` and show no percentage. A deposit writes a virtual expense **and** bumps `savings_goals.saved_amount` in one transaction — which is why savings appears in `savings_allocation` but never in spending totals.

---

## 3. Insights page — `GET /api/insights?month=YYYY-MM`

`insightsController.getInsights` returns per-category totals (current / previous month / 3-month average), a daily array, weekend-vs-weekday averages, and `budget_total`.

- **3-month average per category**: window is months `[m-3, m-2, m-1]`, and the denominator is again `months_with_data`, so a category that only existed for one of those months isn't averaged to a third of its real value.
- **`daily[]`** is indexed 1..`days_in_month`. For the current month, days after today are `null` (not `0`) — this is what makes the momentum line stop at today instead of crashing to the floor.
- **`budget_total`** = sum of **all** `budgets.monthly_limit` for the user (not filtered by category being in use).

### Donut — "where the money went"

Per-category `spent` for the month, zero-value categories dropped, sorted descending. Center shows the grand total, or the hovered/pinned slice with its delta vs the **previous month** (`(spent − prev_spent) / prev_spent`).

### Momentum chart — pacing

```
target        = budget_total > 0 ? budget_total : three_mo_avg_total
cumulative[d] = running sum of daily[1..d]
ideal(d)      = target × (d − 1) / (days_in_month − 1)      # straight line, day 1 = 0
over_under    = cumulative[today] − ideal(today)
```

The green area is actual cumulative spend; the dashed line is the even-pace ideal. `over_under > 0` → "over" chip in rose. The y-axis maxes at `max(target, peak) × 1.05`.

### Trend bars — this month vs 3-month average

Per category: `delta = spent − three_mo_avg`, `deltaPct = delta / three_mo_avg` (or a flat +100% when there is no history but spend exists). Rows sort by `deltaPct` descending; bar width is `|deltaPct| / max|deltaPct|` scaled to half the track, drawn left (green, down) or right (rose, up) from a center axis. The bar is **relative**, not absolute — the widest bar is whichever category moved most, so a small category can dominate visually.

### Smart insight cards

1. **Burn rate** — `daily_avg = total_spent / today_day`, then the day the 3-month average total would be reached: `today_day + ceil((avg_total − total_spent) / daily_avg)`, capped at month end.
2. **Top category** — largest `spent`, with its percent delta vs its own 3-month average.
3. **Weekend habit** — `(weekend_daily_avg − weekday_daily_avg) / weekday_daily_avg`. Weekend is **Friday + Saturday** (`getDay() === 5 || 6`), matching the Israeli week, and averages are per-day (sum ÷ number of days of that kind elapsed), not per-total.

---

## 4. Bot — weekly spending score (`bot/app/scheduler.py`, Saturdays 09:00)

```
week_total  = SUM(expenses) since Monday of this week
monthly_avg = SUM(expenses over the last 3 complete months) / months_with_data
weekly_avg  = monthly_avg / 4.33
ratio       = week_total / weekly_avg
```

Grades: ≤0.80 Excellent 🟢 · ≤1.00 Good 🔵 · ≤1.20 Over budget 🟡 · else Way over 🔴. Zero history → "not enough history yet" rather than a divide-by-zero.

---

## 5. Cross-cutting rules

- **Virtual expenses** (`is_virtual = TRUE`, savings transfers) are excluded from `getSummary`, `getBudgets`, and the P&L expense buckets, and subtracted separately as `savings_allocation`.
- **Fixed vs variable** (`categories.is_fixed`) exists purely for forecasting: fixed costs are never run-rated to month-end.
- **Rounding** is applied once at the response boundary (`Math.round(x * 100) / 100`), never mid-formula.
- **Averaging denominators are always `months_with_data`**, never a hard-coded window length. This is consistent across P&L variable income, Insights category averages, and the bot's score.
- **Currency formatting** puts the sign before the symbol (`−₪221`) and wraps values in U+200E LTR marks so Hebrew RTL layout doesn't reorder them.

---

## 6. Known inconsistencies worth knowing about

1. **Insights does not filter `is_virtual`.** Every query in `insightsController.js` sums `expenses` with no `is_virtual = FALSE` clause (there are conspicuous blank lines in each `WHERE` where such a filter would sit). Consequence: savings-goal transfers are counted as spending on the donut, the momentum line, the trend bars, and all three smart-insight cards — so the Insights total can exceed the Dashboard's `total_expenses` for the same month by exactly `savings_allocation`.
2. **Momentum target vs actual budgets.** `budget_total` sums *all* budget limits; the cumulative line sums *all* spending including uncategorized and unbudgeted categories. The two sides aren't over the same set of categories, so the "ideal" pace is only a rough target.
3. **Dead code**: `getPast3Months` in `incomeController.js` is unused — the summary endpoint returns actuals only, despite its comment claiming it averages variable income.
4. **The dashboard sparkline and the Insights momentum line are computed by different code paths** (client-side from `/expenses` vs server-side `daily[]`), and differ because of point 1.
