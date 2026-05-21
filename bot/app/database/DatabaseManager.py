import aiomysql
import logging
from datetime import date, timedelta
from dotenv import load_dotenv

load_dotenv()


class DatabaseManager:
    def __init__(self, host, user, password, db):
        self.config = {
            "host": host,
            "user": user,
            "password": password,
            "db": db,
            "autocommit": True,
        }
        self.pool = None

    async def get_pool(self):
        if self.pool is None:
            self.pool = await aiomysql.create_pool(**self.config)
        return self.pool

    async def user_exists(self, user_id: int) -> bool:
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute("SELECT 1 FROM users WHERE user_id = %s", (user_id,))
                return await cur.fetchone() is not None

    async def ensure_user(self, user_id: int, username: str | None):
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "INSERT INTO users (user_id, username) VALUES (%s, %s) "
                    "ON DUPLICATE KEY UPDATE username = VALUES(username)",
                    (user_id, username),
                )

    async def get_user_categories(self, user_id: int) -> list[str]:
        """Returns base categories plus any user-defined ones."""
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT name FROM categories "
                    "WHERE user_id IS NULL OR user_id = %s "
                    "ORDER BY is_base DESC, name",
                    (user_id,),
                )
                rows = await cur.fetchall()
        return [r[0] for r in rows]

    async def get_or_create_category_id(self, user_id: int, name: str) -> int | None:
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                # Check base category first
                await cur.execute(
                    "SELECT category_id FROM categories WHERE name = %s AND user_id IS NULL",
                    (name,),
                )
                row = await cur.fetchone()
                if row:
                    return row[0]

                # Check user-specific category
                await cur.execute(
                    "SELECT category_id FROM categories WHERE name = %s AND user_id = %s",
                    (name, user_id),
                )
                row = await cur.fetchone()
                if row:
                    return row[0]

                # Create new user-specific category
                await cur.execute(
                    "INSERT INTO categories (user_id, name, is_base) VALUES (%s, %s, FALSE)",
                    (user_id, name),
                )
                return cur.lastrowid

    async def link_google_account(self, user_id: int, email: str) -> bool:
        """Returns True on success, 'conflict' if email owned by another user."""
        clean_email = email.lower().strip()
        try:
            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    # Check if email already belongs to a different user
                    await cur.execute(
                        "SELECT user_id FROM users WHERE google_email = %s",
                        (clean_email,),
                    )
                    row = await cur.fetchone()
                    if row and row[0] != user_id:
                        return "conflict"
                    await cur.execute(
                        "UPDATE users SET google_email = %s, telegram_chat_id = %s WHERE user_id = %s",
                        (clean_email, str(user_id), user_id),
                    )
            return True
        except Exception as e:
            logging.error(f"link_google_account error: {e}")
            return False

    async def add_user_category(self, user_id: int, name: str) -> bool:
        try:
            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "INSERT IGNORE INTO categories (user_id, name, is_base) VALUES (%s, %s, FALSE)",
                        (user_id, name),
                    )
            return True
        except Exception as e:
            logging.error(f"add_user_category error: {e}")
            return False

    # --- Subscriptions ---

    async def add_subscription(
        self, user_id: int, name: str, amount: float,
        category_name: str | None, day_of_month: int, currency: str = "ILS"
    ) -> int | None:
        try:
            category_id = await self.get_or_create_category_id(user_id, category_name) if category_name else None
            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "INSERT INTO subscriptions "
                        "(user_id, name, amount, currency, category_id, day_of_month) "
                        "VALUES (%s, %s, %s, %s, %s, %s)",
                        (user_id, name, amount, currency, category_id, day_of_month),
                    )
                    return cur.lastrowid
        except Exception as e:
            logging.error(f"add_subscription error: {e}")
            return None

    async def list_subscriptions(self, user_id: int) -> list[dict]:
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT s.subscription_id, s.name, s.amount, s.currency, "
                    "       c.name AS category, s.day_of_month, s.active, s.last_charged_month "
                    "FROM subscriptions s LEFT JOIN categories c ON s.category_id = c.category_id "
                    "WHERE s.user_id = %s ORDER BY s.day_of_month",
                    (user_id,),
                )
                rows = await cur.fetchall()
        keys = ["subscription_id", "name", "amount", "currency", "category", "day_of_month", "active", "last_charged_month"]
        return [dict(zip(keys, r)) for r in rows]

    async def delete_subscription(self, user_id: int, subscription_id: int) -> bool:
        try:
            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "DELETE FROM subscriptions WHERE subscription_id = %s AND user_id = %s",
                        (subscription_id, user_id),
                    )
                    return cur.rowcount > 0
        except Exception as e:
            logging.error(f"delete_subscription error: {e}")
            return False

    async def get_due_subscriptions(self, today_day: int, current_month: str) -> list[dict]:
        """Active subs whose day_of_month <= today and not yet charged for current_month."""
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT s.subscription_id, s.user_id, s.name, s.amount, s.currency, "
                    "       c.name AS category "
                    "FROM subscriptions s "
                    "LEFT JOIN categories c ON s.category_id = c.category_id "
                    "WHERE s.active = TRUE AND s.day_of_month <= %s "
                    "  AND (s.last_charged_month IS NULL OR s.last_charged_month < %s)",
                    (today_day, current_month),
                )
                rows = await cur.fetchall()
        keys = ["subscription_id", "user_id", "name", "amount", "currency", "category"]
        return [dict(zip(keys, r)) for r in rows]

    async def mark_subscription_charged(self, subscription_id: int, month: str):
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "UPDATE subscriptions SET last_charged_month = %s WHERE subscription_id = %s",
                    (month, subscription_id),
                )

    # --- Budgets ---

    async def set_budget(self, user_id: int, category_name: str, monthly_limit: float, carry_over: bool = True) -> bool:
        try:
            category_id = await self.get_or_create_category_id(user_id, category_name)
            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "INSERT INTO budgets (user_id, category_id, monthly_limit, carry_over) "
                        "VALUES (%s, %s, %s, %s) "
                        "ON DUPLICATE KEY UPDATE monthly_limit = VALUES(monthly_limit), carry_over = VALUES(carry_over)",
                        (user_id, category_id, monthly_limit, carry_over),
                    )
            return True
        except Exception as e:
            logging.error(f"set_budget error: {e}")
            return False

    async def list_budgets(self, user_id: int) -> list[dict]:
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT b.budget_id, c.name AS category, b.monthly_limit, b.carry_over "
                    "FROM budgets b JOIN categories c ON b.category_id = c.category_id "
                    "WHERE b.user_id = %s ORDER BY c.name",
                    (user_id,),
                )
                rows = await cur.fetchall()
        keys = ["budget_id", "category", "monthly_limit", "carry_over"]
        return [dict(zip(keys, r)) for r in rows]

    async def add_income(
        self,
        user_id: int,
        source: str,
        amount: float,
        income_type: str,
        month: str,
        currency: str = "ILS",
        description: str | None = None,
    ) -> bool:
        try:
            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "INSERT INTO income (user_id, source, amount, currency, type, month, description) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                        (user_id, source, amount, currency, income_type, month, description),
                    )
            return True
        except Exception as e:
            logging.error(f"add_income error: {e}")
            return False

    async def get_category_spending(self, user_id: int, category_name: str, month: str) -> float:
        """Returns total spent in a category for the given month."""
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT COALESCE(SUM(e.amount), 0) FROM expenses e "
                    "JOIN categories c ON e.category_id = c.category_id "
                    "WHERE e.user_id = %s AND c.name = %s "
                    "  AND DATE_FORMAT(e.created_at, '%%Y-%%m') = %s",
                    (user_id, category_name, month),
                )
                (total,) = await cur.fetchone()
        return float(total)

    async def get_category_budget(self, user_id: int, category_name: str) -> dict | None:
        """Returns budget row for a category, or None if no budget is set."""
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT b.monthly_limit FROM budgets b "
                    "JOIN categories c ON b.category_id = c.category_id "
                    "WHERE b.user_id = %s AND c.name = %s",
                    (user_id, category_name),
                )
                row = await cur.fetchone()
        return {"monthly_limit": float(row[0])} if row else None

    # --- Savings Goals ---

    async def add_savings_goal(
        self,
        user_id: int,
        name: str,
        target_amount: float,
        monthly_allocation: float = 0.0,
        currency: str = "ILS",
    ) -> int | None:
        try:
            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "INSERT INTO savings_goals (user_id, name, target_amount, monthly_allocation, currency) "
                        "VALUES (%s, %s, %s, %s, %s)",
                        (user_id, name, target_amount, monthly_allocation, currency),
                    )
                    return cur.lastrowid
        except Exception as e:
            logging.error(f"add_savings_goal error: {e}")
            return None

    async def list_savings_goals(self, user_id: int) -> list[dict]:
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT goal_id, name, target_amount, saved_amount, monthly_allocation, currency "
                    "FROM savings_goals WHERE user_id = %s AND active = TRUE ORDER BY created_at",
                    (user_id,),
                )
                rows = await cur.fetchall()
        keys = ["goal_id", "name", "target_amount", "saved_amount", "monthly_allocation", "currency"]
        return [dict(zip(keys, r)) for r in rows]

    async def deposit_to_savings_goal(self, user_id: int, goal_id: int, amount: float) -> bool:
        try:
            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "UPDATE savings_goals SET saved_amount = saved_amount + %s "
                        "WHERE goal_id = %s AND user_id = %s",
                        (amount, goal_id, user_id),
                    )
                    return cur.rowcount > 0
        except Exception as e:
            logging.error(f"deposit_to_savings_goal error: {e}")
            return False

    async def get_dynamic_financial_context(
        self,
        user_id: int,
        timeframe: str,
        specific_category: str | None = None,
    ) -> dict:
        today = date.today()

        if timeframe == "current_month":
            start_date = today.replace(day=1)
            end_date = today
        elif timeframe == "last_month":
            first_of_this = today.replace(day=1)
            end_date = first_of_this - timedelta(days=1)
            start_date = end_date.replace(day=1)
        elif timeframe == "last_3_months":
            # go back ~3 months from 1st of current month
            first_of_this = today.replace(day=1)
            y, m = first_of_this.year, first_of_this.month - 3
            if m <= 0:
                m += 12
                y -= 1
            start_date = date(y, m, 1)
            end_date = today
        elif timeframe == "this_year":
            start_date = date(today.year, 1, 1)
            end_date = today
        else:  # all_time
            start_date = None
            end_date = None

        base_where = "e.user_id = %s AND e.is_virtual = FALSE"
        base_params: list = [user_id]
        date_clause = ""
        date_params: list = []
        if start_date and end_date:
            date_clause = " AND e.created_at BETWEEN %s AND %s"
            date_params = [start_date, end_date]
        elif start_date:
            date_clause = " AND e.created_at >= %s"
            date_params = [start_date]

        # Query 1: category breakdown (optionally filtered to one category)
        cat_query = (
            "SELECT c.name, COALESCE(SUM(e.amount), 0) "
            "FROM expenses e "
            "LEFT JOIN categories c ON e.category_id = c.category_id "
            f"WHERE {base_where}{date_clause}"
        )
        cat_params = base_params + date_params
        if specific_category:
            cat_query += " AND c.name = %s"
            cat_params = cat_params + [specific_category]
        cat_query += " GROUP BY c.name"

        # Query 2: total spending across all categories for the period
        total_query = (
            "SELECT COALESCE(SUM(e.amount), 0) "
            "FROM expenses e "
            f"WHERE {base_where}{date_clause}"
        )
        total_params = base_params + date_params

        # When the user's question is about one specific category, only ship that
        # category's budget — everything else is noise that bloats the LLM payload.
        budgets_query = (
            "SELECT c.name, b.monthly_limit "
            "FROM budgets b JOIN categories c ON b.category_id = c.category_id "
            "WHERE b.user_id = %s"
        )
        budgets_params: list = [user_id]
        if specific_category:
            budgets_query += " AND c.name = %s"
            budgets_params.append(specific_category)

        need_trend = timeframe not in ("current_month", "last_month")
        if need_trend:
            trend_query = (
                "SELECT DATE_FORMAT(e.created_at, '%%Y-%%m') AS month_period, "
                "COALESCE(SUM(e.amount), 0) "
                "FROM expenses e "
                f"WHERE {base_where}{date_clause} "
                "GROUP BY month_period ORDER BY month_period ASC"
            )
            trend_params = base_params + date_params

        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(cat_query, cat_params)
                cat_rows = await cur.fetchall()

                await cur.execute(total_query, total_params)
                (total_spent,) = await cur.fetchone()

                await cur.execute(budgets_query, budgets_params)
                budget_rows = await cur.fetchall()

                if need_trend:
                    await cur.execute(trend_query, trend_params)
                    trend_rows = await cur.fetchall()
                else:
                    trend_rows = []

        # --- Shrink the LLM payload --------------------------------------
        # 1. Drop zero-spend categories (they tell the model nothing).
        # 2. Sort descending so the most-relevant rows are first — matters if
        #    the model truncates, and helps a human eyeballing the log.
        # 3. Round to 2 decimals (Gemini doesn't need 12-digit floats).
        # 4. Cap monthly_history to the last _MAX_RECENT_MONTHS entries and
        #    collapse anything older into a single previous_months_avg field.
        _MAX_RECENT_MONTHS = 6

        spending_pairs = [
            (row[0] or "Uncategorized", round(float(row[1]), 2))
            for row in cat_rows
            if float(row[1]) > 0
        ]
        spending_pairs.sort(key=lambda kv: kv[1], reverse=True)
        spending_by_category = dict(spending_pairs)

        all_active_budgets = {row[0]: round(float(row[1]), 2) for row in budget_rows}

        history_pairs = [(row[0], round(float(row[1]), 2)) for row in trend_rows]
        previous_months_avg: float | None = None
        if len(history_pairs) > _MAX_RECENT_MONTHS:
            older = history_pairs[:-_MAX_RECENT_MONTHS]
            history_pairs = history_pairs[-_MAX_RECENT_MONTHS:]
            previous_months_avg = round(
                sum(v for _, v in older) / len(older), 2
            )
        monthly_history = dict(history_pairs)

        period = (
            f"{start_date} to {end_date}"
            if start_date
            else "all time"
        )

        payload: dict = {
            "timeframe": timeframe,
            "period": period,
            "spending_by_category": spending_by_category,
            "total_spending": round(float(total_spent), 2),
            "all_active_budgets": all_active_budgets,
            "monthly_history": monthly_history,
        }
        if previous_months_avg is not None:
            payload["previous_months_avg"] = previous_months_avg
            payload["previous_months_count"] = len(older)
        if specific_category:
            payload["scoped_to_category"] = specific_category
        return payload

    async def add_expense(
        self,
        user_id: int,
        amount: float,
        description: str | None,
        category_name: str | None,
        currency: str = "ILS",
        source: str = "bot",
    ) -> bool:
        try:
            category_id = None
            if category_name:
                category_id = await self.get_or_create_category_id(user_id, category_name)

            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "INSERT INTO expenses (user_id, amount, currency, description, category_id, source) "
                        "VALUES (%s, %s, %s, %s, %s, %s)",
                        (user_id, amount, currency, description, category_id, source),
                    )
            return True
        except Exception as e:
            logging.error(f"add_expense error: {e}")
            return False
