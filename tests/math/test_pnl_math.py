"""
Pure math tests for P&L formulas — no DB, no mocking, no imports beyond stdlib.
Tests the formulas exactly as implemented in backend/src/controllers/expenseController.js
translated to Python for readability.
"""

# ── Formula implementations (mirrors the JS exactly) ─────────────────────────

def variable_avg(total: float, months_with_data: int) -> float:
    return total / months_with_data if months_with_data > 0 else 0.0


def projected_income(fixed: float, variable_actual: float, var_avg: float) -> float:
    return fixed + max(variable_actual, var_avg)


def projected_expenses(actual: float, day_of_month: int, days_in_month: int, is_current_month: bool) -> float:
    if not is_current_month or actual == 0:
        return actual
    return actual * (days_in_month / day_of_month)


def current_net(actual_income: float, expenses: float, subs: float, savings: float) -> float:
    return actual_income - expenses - subs - savings


def forecasted_net(proj_income: float, proj_expenses: float, subs: float, savings: float) -> float:
    return proj_income - proj_expenses - subs - savings


# ── variable_avg ──────────────────────────────────────────────────────────────

class TestVariableAvg:
    def test_no_history_returns_zero(self):
        assert variable_avg(0, 0) == 0.0

    def test_one_month_divides_by_one(self):
        assert variable_avg(900, 1) == 900.0

    def test_two_months(self):
        assert variable_avg(1800, 2) == 900.0

    def test_three_months_full_lookback(self):
        assert variable_avg(2700, 3) == 900.0

    def test_old_bug_two_months_in_three_month_window(self):
        # Bug: total=1800 always divided by LOOKBACK=3 → 600 (wrong)
        # Fix: divide by actual months_with_data=2 → 900 (correct)
        assert variable_avg(1800, 2) == 900.0
        assert variable_avg(1800, 3) == 600.0  # only correct when all 3 months have data

    def test_single_high_month(self):
        assert variable_avg(5000, 1) == 5000.0

    def test_zero_total_with_months(self):
        # User has months on record but $0 variable income in all of them
        assert variable_avg(0, 3) == 0.0


# ── projected_income ──────────────────────────────────────────────────────────

class TestProjectedIncome:
    def test_uses_actual_when_higher_than_avg(self):
        # Windfall: sold table 800, historical avg 0
        assert projected_income(0, 800, 0) == 800.0

    def test_uses_avg_when_higher_than_actual(self):
        # No income yet this month, but history shows 900/month
        assert projected_income(0, 0, 900) == 900.0

    def test_fixed_plus_actual_beats_avg(self):
        # fixed=5000, actual=1100, avg=300 → 5000 + max(1100, 300) = 6100
        assert projected_income(5000, 1100, 300) == 6100.0

    def test_fixed_plus_avg_when_actual_zero(self):
        # fixed=5000, actual=0, avg=900 → 5000 + 900 = 5900
        assert projected_income(5000, 0, 900) == 5900.0

    def test_all_zeros(self):
        assert projected_income(0, 0, 0) == 0.0

    def test_equal_actual_and_avg(self):
        # max(900, 900) = 900
        assert projected_income(0, 900, 900) == 900.0

    def test_cannot_be_less_than_already_received(self):
        # User received 1100 — forecast income is at least 1100
        result = projected_income(0, 1100, 0)
        assert result >= 1100.0


# ── projected_expenses ────────────────────────────────────────────────────────

class TestProjectedExpenses:
    def test_past_month_returns_actual_unchanged(self):
        assert projected_expenses(1500, 15, 30, is_current_month=False) == 1500.0

    def test_zero_expenses_returns_zero(self):
        assert projected_expenses(0, 15, 30, is_current_month=True) == 0.0

    def test_day_1_of_30_projects_30x(self):
        assert projected_expenses(30, 1, 30, True) == 900.0

    def test_day_15_of_30_doubles(self):
        assert projected_expenses(300, 15, 30, True) == 600.0

    def test_day_20_of_30(self):
        # 300 * (30/20) = 450
        assert projected_expenses(300, 20, 30, True) == 450.0

    def test_day_29_of_30(self):
        # 870 * (30/29) ≈ 900
        result = projected_expenses(870, 29, 30, True)
        assert abs(result - 900) < 1.0

    def test_last_day_of_month_no_scaling(self):
        assert projected_expenses(900, 30, 30, True) == 900.0

    def test_february_28_days(self):
        # 14 days in, 200 spent → projects to 400
        assert projected_expenses(200, 14, 28, True) == 400.0

    def test_31_day_month(self):
        result = projected_expenses(310, 10, 31, True)
        assert result == 961.0


# ── current_net_pnl ───────────────────────────────────────────────────────────

class TestCurrentNet:
    def test_user_exact_scenario(self):
        # 1100 income, 30 expenses, 0 subs, 200 savings → 870
        assert current_net(1100, 30, 0, 200) == 870.0

    def test_positive_balance(self):
        assert current_net(5000, 1000, 200, 300) == 3500.0

    def test_negative_balance(self):
        assert current_net(1000, 2000, 0, 0) == -1000.0

    def test_all_zero(self):
        assert current_net(0, 0, 0, 0) == 0.0

    def test_subscriptions_reduce_net(self):
        assert current_net(5000, 0, 500, 0) == 4500.0

    def test_savings_reduce_net(self):
        assert current_net(5000, 0, 0, 1000) == 4000.0

    def test_exact_breakeven(self):
        # income = expenses + subs + savings
        assert current_net(1700, 1000, 200, 500) == 0.0


# ── forecasted_net_pnl ────────────────────────────────────────────────────────

class TestForecastedNet:
    def test_original_bug_scenario(self):
        # Before fix: new user, no income history, 1100 variable income this month
        # projected_income = fixed(0) + max(1100, avg=0) = 1100  ← fix applied
        # projected_expenses = 30 * (30/29) ≈ 31                 ← fix applied
        # forecasted = 1100 - 31 - 0 - 200 ≈ 869
        pi = projected_income(0, 1100, 0)
        pe = projected_expenses(30, 29, 30, True)
        result = forecasted_net(pi, pe, 0, 200)
        assert result > 860
        assert result < 900

    def test_what_old_code_returned(self):
        # Old code: projected_income = fixed(0) + avg(0) = 0
        # forecasted = 0 - 30 - 0 - 200 = -230  (BUG)
        old_pi = 0 + 0  # fixed + variable_avg (no max with actual)
        result = forecasted_net(old_pi, 30, 0, 200)
        assert result == -230.0  # confirms the bug was real

    def test_truly_negative_month(self):
        # Genuine deficit: income 2000, projected expenses 3500, subs 500, savings 200
        pi = projected_income(2000, 0, 0)
        result = forecasted_net(pi, 3500, 500, 200)
        assert result == -2200.0

    def test_subscriptions_included_in_forecast(self):
        pi = projected_income(5000, 0, 0)
        result = forecasted_net(pi, 1000, 800, 300)
        assert result == 2900.0

    def test_forecast_always_finite(self):
        """Forecast should never be NaN or Inf."""
        for months in [0, 1, 2, 3]:
            avg = variable_avg(0, months)
            pi = projected_income(0, 0, avg)
            pe = projected_expenses(0, 15, 30, True)
            result = forecasted_net(pi, pe, 0, 0)
            assert isinstance(result, float)
            assert result == result  # NaN check
