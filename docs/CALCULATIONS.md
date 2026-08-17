# SmartFin — How every number the user sees is calculated

Source of truth for the math behind the Dashboard, the Insights page, and the bot's weekly DM.

**Every forecasting formula lives in `backend/src/services/forecastMath.js`** — a pure module
with no DB, no clock and no config reads. Controllers fetch rows and shape responses; they do
not do arithmetic. Read that module's header before changing any of it: it records which
estimators were rejected and why. `tests/math/pnl_math.test.js` imports it directly, so the
formulas under test are the formulas that ship.

The rest is derived from `expenseController.js` (P&L, budgets, summary), `insightsController.js`,
`incomeController.js`, `savingsController.js`, `frontend/src/pages/Dashboard.jsx`,
`frontend/src/pages/Insights.jsx`, and `bot/app/scheduler.py`.

---

## 0. Notation

| Symbol | Meaning |
|---|---|
| `d` | day of month elapsed (0 for a future month, `D` for a past one) |
| `D` | days in the queried month |
| `S_d` | actual **variable** spend so far this month, excluding `is_virtual` |
| `μ` | historical mean of the quantity, decayed over the lookback |
| `w` | credibility weight, `d / (d + K)` with `K = 10` |
| `w_i` | share of a typical week's spend falling on weekday `i` (0 = Sunday) |
| `ρ` | share of the month still ahead, seasonality-aware |

**Lookback is 6 months with a 2-month half-life** (`LOOKBACK_MONTHS`, `LOOKBACK_HALF_LIFE`).
Longer than the old flat 3 months, so there is more data; decayed, so it still tracks a real
change in habits. The denominator remains `months_with_data` everywhere.

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
| `variable_avg` | same, one row **per month** over the previous 6 | per-month rows, not a pre-averaged total — the decay weighting and the forecast range both need the individual months |
| `variable_expense_avg` | `expenses`, variable-only, non-virtual, per month over the previous 6 | the prior the credibility weighting blends toward; same fixed/variable split as the current month or it would not be comparable to `S_d` |
| `dow_weights` | `expenses` grouped by `DAYOFWEEK`, over the previous 6 months | 7 weights summing to 1, shrunk toward flat |

Expenses are dated by `created_at`, so any importer must set it explicitly from the source date.

### The two headline numbers

```
current_net_pnl   = (fixed_income + variable_actual) − total_expenses − savings_allocation
forecasted_net_pnl = projected_income − projected_expenses − subscription_total − savings_allocation
```

- **`current_net_pnl` is actuals only.** Subscriptions are deliberately *not* subtracted here — they represent money that hasn't moved yet, and including them broke the month-over-month delta (a past month always scores 0 subscriptions, so the current month looked artificially worse).

### Income projection

```
projected_income = fixed_income + max(variable_actual, variable_actual + μ_income × (D − d)/D)
```

This replaced `fixed_income + max(variable_actual, variable_avg)`. That `max` was a **floor, not
an estimator**: late in the month it quietly propped a genuinely bad income month back up to the
average, so the forecast could never warn anyone their income had fallen short. Adding the
still-expected remainder to what has actually arrived is the unbiased conditional expectation,
and it lets a weak month read as weak. The outer `max` keeps the one property worth keeping — a
forecast may never show less income than the user has already been paid.

`income.month` is a `YYYY-MM` column with no day granularity, so `d` is today's date rather than
the day the money landed. Income also stays on plain calendar days rather than `dow_weights` —
a salary is not likelier on a Friday.

### Expense projection (credibility weighting)

Applies when `month` is the current month (`d` = today) or a future one (`d` = 0). Under the MTD
clamp or for a past month, `projected_expenses = total_expenses`.

```
projected_expenses = fixed_sum + projected_variable

run_rate_remaining   = S_d × ρ / (1 − ρ)      ← this month's own pace
hist_remaining       = μ_var × ρ              ← this user's habit
w                    = d / (d + K),  K = 10
projected_variable   = S_d + w × run_rate_remaining + (1 − w) × hist_remaining
```

Fixed categories (`categories.is_fixed` — Housing, Utilities, Savings) are flat monthly costs,
already paid, so they are **not** run-rated.

Two estimators were rejected, in opposite directions:

- **The naive run-rate** `(S_d / d) × D`, which this replaced. On day 2 it turned one ₪400
  grocery run into a ₪6,000 month. Its variance goes as `D/d`, so it was loudest exactly when it
  knew least. `MIN_DAYS_FOR_FULL_PROJECTION = 5` was a patch over this — it damped days 1–4 and
  then stopped, leaving the estimator just as noisy on day 6. Both are gone.
- **Pure historical accrual** `S_d + μ × (D − d)/D`, proposed as "Bayesian shrinkage" in the
  mathematical review. It shrinks nothing: every remaining day is forecast at the historical
  average regardless of what this month is doing, so a user spending triple their usual rate for
  twenty days would get a forecast that never says so.

Properties, each pinned by a test in `tests/math/pnl_math.test.js`:

- continuous and monotone in `d` — no boundary anywhere in the month
- at `d = D` the remaining share is 0, so the projection lands **exactly** on actuals
- a single day's leverage is bounded: `S_d` enters the remainder as `S_d × (D−d)/(d+K)`, so at
  d=1 the multiplier is 30/11 rather than 30
- with `S_d = 0` it returns the historical expectation, which is the right answer on the 1st —
  the old code short-circuited to ₪0 and told the user to expect a free month
- with **no history at all** `w = 1`: there is no prior to blend toward, and shrinking a new
  user toward a μ of zero would forecast that they are about to spend nothing

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

Linear pro-rating of income is deliberately **accrual, not cash**. The mathematical review
called for a step-function/liquidity view instead; that was rejected, because the clamp exists
for exactly one job — comparing May 1–8 with April 1–8. Under a cash view a salary landing on
the 10th makes both windows read ₪0 and the comparison becomes payday-timing noise. The real
question behind that objection ("what do I actually have right now?") is answered by
`safe_to_spend_per_day` below, not by changing this clamp.

### Day-of-week seasonality

Seven weights summing to 1, one per weekday, each a per-day **rate** (total ÷ how many such days
the window held — a 6-month window does not contain an equal number of each weekday) shrunk
toward the flat 1/7 by `DOW_PRIOR_STRENGTH = 10` day-observations.

`ρ`, the share of the month still ahead, is the sum of `w_i` over the remaining calendar days
divided by the sum over all of them. With flat weights this reduces exactly to `(D − d)/D`, so a
user with no history has no separate code path.

Weights are per **day-of-week**, not per day-of-month as the review proposed. 31 weights from a
3-month history is ~6 observations each — almost entirely noise. 7 weights get ~26 each, and
day-of-week is what actually carries the effect the review wanted to capture (weekend clustering).

### Forecast range

```
σ = sqrt((σ_expense × ρ)² + (σ_income × ρ)²)
forecast_low / high = forecasted_net_pnl ∓ σ
```

`σ_expense` and `σ_income` are the **unweighted sample** standard deviations of the monthly
totals across the lookback (unweighted deliberately: the decay exists to track a moving mean,
but the spread wanted here is how much this user's months differ from each other at all).

Only the unspent part of the month is uncertain, hence the `ρ` scaling. Income and expense
uncertainty are added in quadrature; summing them linearly would overstate the band by ~40%.

**Both fields are `null` below two months of history, and for any month that is not live.** A
range the user cannot rely on is worse than no range — it is the same false precision as a bare
point estimate, wearing a confidence interval. The Dashboard shows the point estimate alone when
they are null.

### Safe to spend per day

```
headroom = projected_income − total_expenses − subscriptions_ahead − savings_allocation
safe_to_spend_per_day = headroom / (D − d)
```

Plain days, not seasonality-weighted days: a weighted figure would be larger before a weekend and
smaller after it, which is arguably more accurate and definitely unusable — the user needs a
number they can hold in their head. `null` on the last day and for past months. Negative headroom
means the month is already committed past its income, and the Dashboard reports the overshoot
rather than a negative allowance.

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
ideal(d)      = target × (Σ w_i for days 1..d) / (Σ w_i for all days)
over_under    = cumulative[today] − ideal(today)
```

The green area is actual cumulative spend; the dashed line is the ideal pace. `over_under > 0` →
"over" chip in rose. The y-axis maxes at `max(target, peak) × 1.05`.

Two changes from the old `target × (d − 1)/(D − 1)`:

- **The off-by-one is gone.** The old form made `ideal(1) = 0`, so anyone who bought a coffee on
  the 1st was flagged "over pace" before the month had really started. Day 1 now gets its own
  day's worth.
- **It is a curve, not a line.** `dow_weights` makes it climb faster across a weekend than across
  a Tuesday. With no history the backend returns seven equal weights and it draws straight, so
  there is no separate empty state to design for.

### Trend bars — this month vs 3-month average

Per category: `delta = spent − three_mo_avg`, `deltaPct = delta / three_mo_avg` (or a flat +100% when there is no history but spend exists). Rows sort by `deltaPct` descending; bar width is `|deltaPct| / max|deltaPct|` scaled to half the track, drawn left (green, down) or right (rose, up) from a center axis. The bar is **relative**, not absolute — the widest bar is whichever category moved most, so a small category can dominate visually.

### Smart insight cards

1. **Burn rate** — `daily_avg = total_spent / today_day`, then the day the 3-month average total would be reached: `today_day + ceil((avg_total − total_spent) / daily_avg)`, capped at month end.
2. **Top category** — largest `spent`, with its percent delta vs its own 3-month average.
3. **Weekend habit** — `(weekend_daily_avg − weekday_daily_avg) / weekday_daily_avg`. Weekend is **Friday + Saturday** (`getDay() === 5 || 6`), matching the Israeli week, and averages are per-day (sum ÷ number of days of that kind elapsed), not per-total.
   The card is **suppressed** unless at least 2 weekend days and 3 weekday days have elapsed and
   the weekday average is non-zero (`weekend_days_elapsed` / `weekday_days_elapsed` in the
   response). A percentage between two daily averages explodes when the denominator is near
   zero, and early in a month one weekend against a quiet Monday produced a confident-looking
   "+900% on weekends" that meant nothing. The absolute ₪/day gap is now shown alongside the
   percentage for the same reason.

---

## 4. Bot — weekly spending score (`bot/app/scheduler.py`, Saturdays 09:00)

```
week_start   = Sunday of this week
week_total   = SUM(expenses) since week_start, is_virtual = FALSE
monthly_avg  = SUM(expenses over the last 3 complete months) / months_with_data
weekly_avg   = monthly_avg / 4.33
expected     = weekly_avg × (elapsed_days / 7)
ratio        = round(week_total / expected, 2)
```

Grades: ≤0.80 Excellent 🟢 · ≤1.00 Good 🔵 · ≤1.20 Over budget 🟡 · else Way over 🔴. Zero history
→ "not enough history yet" rather than a divide-by-zero.

Three things were wrong here and all three are fixed:

- **The week started on Monday.** The job runs Saturday, so Sunday — the first working day of the
  Israeli week — was pushed into the *previous* week's total. Every score was computed over a
  window that both dropped a real spending day and straddled two weeks as the user lives them.
- **6 elapsed days were compared against a 7-day expectation**, so every user read ~14% under
  budget regardless of what they actually spent. `expected` is now scaled by elapsed days, which
  also keeps the score correct if the job ever moves off Saturday.
- **`is_virtual` was not filtered**, so moving money into a savings goal graded you *worse*.
- The ratio is rounded to the precision the message prints, so the grade cannot disagree with
  the percentage beside it ("Over budget … you spent 0% more than usual").

---

## 5. Cross-cutting rules

- **Virtual expenses** (`is_virtual = TRUE`, savings transfers) are excluded from `getSummary`, `getBudgets`, the P&L expense buckets, **every query in `insightsController`**, and the bot's weekly score — and subtracted separately as `savings_allocation`. Moving money into a savings goal is not spending it; any new query over `expenses` needs this filter.
- **Fixed vs variable** (`categories.is_fixed`) exists purely for forecasting: fixed costs are never run-rated to month-end.
- **Rounding** is applied once at the response boundary (`Math.round(x * 100) / 100`), never mid-formula.
- **Averaging denominators are always `months_with_data`**, never a hard-coded window length. This is consistent across P&L variable income, Insights category averages, and the bot's score.
- **Uncertainty is never fabricated.** Where a figure cannot be defended it is `null`, not zero and not a guess: `forecast_low`/`forecast_high` below two months of history, `safe_to_spend_per_day` on the last day of the month, the weekend card below its elapsed-day thresholds.
- **Currency formatting** puts the sign before the symbol (`−₪221`) and wraps values in U+200E LTR marks so Hebrew RTL layout doesn't reorder them.

---

## 6. Known inconsistencies worth knowing about

1. **Momentum target vs actual budgets.** `budget_total` sums *all* budget limits; the cumulative
   line sums *all* spending, including categories with no budget. The two sides are not over the
   same set of categories, so the "ideal" pace is a rough target whenever budgets cover only part
   of a user's spending. Structural, not a bug — but worth knowing before reading the chip
   literally. The fallback (`three_mo_avg_total`, used when no budgets exist) does not have this
   problem.
2. **Dead code**: `getPast3Months` in `incomeController.js` is unused — the summary endpoint
   returns actuals only, despite its comment claiming it averages variable income.
3. **The dashboard sparkline is still computed client-side** from `/expenses`, while the Insights
   momentum line comes from the server's `daily[]`. They now agree numerically (both exclude
   `is_virtual`, both include uncategorized), but they remain two code paths that must be kept
   in step by hand.

---

## 7. What changed in the 2026-08 math overhaul, and why

Prompted by `SmartFin_Mathematical_Review.md`. The review was right about two things, wrong
about two, and missed three real bugs.

**Accepted:**
- The `max()` income floor really was biased and is gone (§1, income projection).
- The naive run-rate really did need replacing — though with credibility weighting, not the
  review's own formula, which gives zero weight to the current month's pace.
- `ideal(d)` really was off by one.
- The bot's weekly ratio really was skewed by the day it runs on.

**Rejected:**
- **The "day-5 discontinuity" did not exist.** The old code blended `S + (naive − S) × d/5`, and
  at d=5 that weight is exactly 1.0, so the two branches met. The review described the doc's
  phrasing rather than the code. The estimator was still worth replacing, for the reason above.
- **The weekend div-by-zero did not crash.** `Insights.jsx` already guarded it. The metric was
  fragile rather than broken, and is now gated on elapsed-day counts instead.
- **MTD pro-rating stays accrual.** See §1; a cash view would make the month-vs-month comparison
  meaningless.
- **Per-day-of-month seasonality weights** were replaced with per-day-of-week. 31 parameters
  from a 3-month history is noise.

**Found during the work, in neither document:**
- Insights counted savings transfers as spending, in every one of its queries.
- Insights silently dropped uncategorized spend from `total_spent` while `daily[]` included it,
  so a single response contradicted itself.
- The bot's week started on the wrong day and did not filter `is_virtual`.
- `tests/math/*` re-implemented the formulas instead of importing them and had already drifted
  from the app — the JS copy subtracted subscriptions from `current_net_pnl`, which the
  controller deliberately does not. They tested rejected behaviour and passed the whole time.
  This is why the math now lives in one pure module that the tests import.
