# SmartFin: Personal Finance Application - System Architecture & Mathematical Review

## 1. Original System Design & Mathematical Formulas

### Headline Metrics (Actuals vs Forecast)
* **Current Net P&L (Actuals only):**
  `current_net_pnl = (fixed_income + variable_actual) - total_expenses - savings_allocation`
* **Forecasted Net P&L:**
  `forecasted_net_pnl = projected_income - projected_expenses - subscription_total - savings_allocation`
* **Income Projection:**
  `projected_income = fixed_income + max(variable_actual, variable_avg)`
  *(where `variable_avg` = sum of previous up to 3 months / count(months_with_data))*

### Expense Projection (Smart Forecast for Current Month)
* **Projected Expenses:**
  `projected_expenses = fixed_sum + projected_variable`
* **Variable Run-Rate:**
  `daily_rate = variable_sum / day_of_month`
  `naive_projection = daily_rate * days_in_month`
* **Early-Month Dampening (days 1 to 4):**
  `weight = day_of_month / 5`
  `projected_variable = (weight * naive_projection) + ((1 - weight) * variable_sum)` (blended)
* **After Day 5:**
  `projected_variable = naive_projection`

### Forward-Looking Subscriptions
* `subscription_total` only sums active, unpaused subscriptions where `billing_day > current_day_of_month`. (Once passed, it is assumed captured in actual expenses).

### Month-to-Date (MTD) Clamping
* **Expenses & Savings:** Hard SQL timestamp clamp (`created_at < month-01 + N days`).
* **Income:** Pro-rated linearly: `income * (N / days_in_month)`.
* **Under MTD clamp:** `projected_expenses = total_expenses`; `forecasted_net_pnl = current_net_pnl - subscription_total`.

### Pacing & Insights Formulas
* **Momentum Ideal Line:**
  `ideal(d) = target * (d - 1) / (days_in_month - 1)` (where d=1 is 0, d=end is target)
* **Burn Rate (Estimated Exhaustion Day):**
  `daily_avg = total_spent / today_day`
  `projected_day = today_day + ceil((three_month_avg_total - total_spent) / daily_avg)`
* **Weekend Habit Metric:**
  `(weekend_daily_avg - weekday_daily_avg) / weekday_daily_avg` (Weekend = Fri+Sat)
* **Bot Weekly Spending Ratio:**
  `weekly_avg = (3-month average monthly spend) / 4.33`
  `spending_ratio = (spend since Monday) / weekly_avg`

---

## 2. Mathematical Audit & Flaws Identified

### 2.1 The Optimistic Bias in Income Projection
Applying a `max()` function to a random variable creates an artificial positive bias. If variable income fluctuates normally around a true mean µ, the expected value E[max(X, µ)] is strictly greater than µ. This systematically overestimates projected P&L.

### 2.2 Discontinuous Boundary Jumps (The Day 5 Problem)
The early-month dampening relies on `W = d/5` for d ∈ {1, 2, 3, 4}.
Transitioning from Day 4 (where W = 0.8) to Day 5 (where W logic ends and naive projection takes over 100%) creates a mathematically unjustified overnight jump in projected expenses simply because the date changed.

### 2.3 Division-by-Zero & Denominator Anomalies
* **Weekend Habit Metric:** If spend is zero Monday through Thursday, the denominator is zero, crashing the calculation.
* **Bot Weekly Spending Ratio:** Comparing "spend since Monday" directly to a full 7-day `weekly_avg` expectation is flawed, skewing results depending on the day of the week.

### 2.4 Accrual vs. Cash Flow Mismatch (MTD Pro-rating)
Linear pro-rating of monthly income (`income * (N / days_in_month)`) represents Accrual Accounting. Personal cash-flow management requires evaluating actual liquidity (step functions) rather than accrued theoretical income.

---

## 3. Concrete Revised Equations (For Implementation)

### 3.1 Projected Variable Expenses (Bayesian Shrinkage)
Eliminates the day 5 boundary jump and smoothly transitions from historical average to current actuals over the month.
* Let `S_d` = Total actual variable spend up to day `d`
* Let `D` = Total days in the month
* Let `μ` = Historical average monthly variable spend (3-month avg)

**Formula:**
`E_var_projected = S_d + (μ * ((D - d) / D))`

### 3.2 Projected Variable Income (Unbiased Expectation)
Removes the positive bias of the `max()` function by projecting the remainder based on historical daily velocity.
* Let `I_d` = Actual variable income accrued by day `d`
* Let `μ_I` = Historical monthly variable average

**Formula:**
`I_var_projected = I_d + (μ_I * ((D - d) / D))`

**Revised Forecasted Net P&L:**
`Forecast = (Fixed Income + I_var_projected) - (Fixed Expenses + E_var_projected + Forward Subscriptions) - Savings`

### 3.3 Pacing & Momentum Ideal Curve

**Standard Linear Pacing (Fixed):**
`Ideal(d) = Target * (d / D)`
*(Start at day 0, not day 1, so d/D scales perfectly from 0.0 to 1.0)*

**Advanced Seasonality Pacing (Recommended):**
Accounts for structural weekly habits (e.g., clustered weekend spending).
* Let `w_i` = historical average percentage of monthly spend that occurs on day `i` (where sum(w_i) = 1).

**Formula:**
`Ideal(d) = Target * sum(w_i from i=1 to d)`
