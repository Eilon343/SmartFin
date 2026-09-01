import aiomysql
import hashlib
import logging
from datetime import date, timedelta
from dotenv import load_dotenv

from app.services import cycle as cycle_svc

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

    async def get_user_id_by_chat_id(self, chat_id: int) -> int | None:
        """Resolves a Telegram chat to the SmartFin account that linked it.

        This is the ONLY way the bot identifies a user. It used to treat the Telegram id as
        the users.user_id primary key directly, which held only because the bot was also the
        thing that created accounts. Accounts are now created in the web app and get a
        DB-assigned id, so an app-origin user's user_id and chat id are different numbers —
        the old assumption silently matched nothing and every command did nothing.

        Returns None for a chat nobody has linked. The bot must never create the row itself:
        obtaining an account is the web app's job, and a bot-created account is exactly the
        unverified-claim hole this replaced.
        """
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT user_id FROM users WHERE telegram_chat_id = %s",
                    (str(chat_id),),
                )
                row = await cur.fetchone()
                return row[0] if row else None

    async def get_notifiable_users(self) -> list[tuple[int, str]]:
        """(user_id, telegram_chat_id) for every user reachable on Telegram.

        Both values are needed: user_id keys the financial queries, telegram_chat_id is
        where the message goes. They are only interchangeable for legacy bot-origin rows.
        """
        try:
            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "SELECT user_id, telegram_chat_id FROM users "
                        "WHERE telegram_chat_id IS NOT NULL"
                    )
                    return [(row[0], row[1]) for row in await cur.fetchall()]
        except Exception as e:
            logging.error(f"get_notifiable_users error: {e}")
            return []

    async def redeem_link_code(self, code: str, chat_id: int) -> str:
        """Links this chat to the account that generated `code`.

        Returns 'ok', 'invalid' (unknown, expired or already used) or 'chat_taken'.

        Python twin of backend/src/services/telegramLink.js::redeemLinkCode — the aiogram bot
        talks to MySQL directly rather than through the backend, so the rule genuinely lives
        in two places, the same arrangement as the two Gemini parsers. Change one, change the
        other.
        """
        normalized = (code or "").strip().upper().replace("-", "").replace(" ", "")
        if not normalized:
            return "invalid"
        code_hash = hashlib.sha256(normalized.encode()).hexdigest()

        try:
            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    # Claim and validate in one statement: two concurrent redemptions both
                    # reach here, but only one can move used_at off NULL, so only one sees
                    # rowcount 1. Checking first and updating after would let both through.
                    await cur.execute(
                        "UPDATE telegram_link_codes SET used_at = NOW() "
                        "WHERE code_hash = %s AND used_at IS NULL AND expires_at > NOW()",
                        (code_hash,),
                    )
                    if cur.rowcount != 1:
                        return "invalid"

                    await cur.execute(
                        "SELECT user_id FROM telegram_link_codes WHERE code_hash = %s",
                        (code_hash,),
                    )
                    row = await cur.fetchone()
                    if not row:
                        return "invalid"
                    user_id = row[0]

                    # telegram_chat_id is UNIQUE, so this would fail as a duplicate key.
                    # Checking first turns it into a message the user can act on.
                    await cur.execute(
                        "SELECT user_id FROM users WHERE telegram_chat_id = %s",
                        (str(chat_id),),
                    )
                    existing = await cur.fetchone()
                    if existing and str(existing[0]) != str(user_id):
                        return "chat_taken"

                    await cur.execute(
                        "UPDATE users SET telegram_chat_id = %s WHERE user_id = %s",
                        (str(chat_id), user_id),
                    )
            return "ok"
        except Exception as e:
            logging.error(f"redeem_link_code error: {e}")
            return "invalid"

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

    # link_google_account() lived here. It took an email on the sender's word and wrote it
    # to whichever row ensure_user() had just created from the Telegram id, so anyone could
    # claim an address nobody had registered yet — and the real owner's later Google sign-in
    # then landed in the claimant's account. Linking now goes the other way round: the web
    # app issues a code from an authenticated session and redeem_link_code() consumes it.
    #
    # ensure_user() went with it. The bot no longer creates accounts at all, which is what
    # made the claim possible in the first place.

    # get_or_create_webhook_token() lived here to issue per-user Apple Pay webhook
    # tokens. The Apple Pay endpoint was removed once bank/card sync landed, so nothing
    # issues or checks a token any more. `users.webhook_token` is left in place — the
    # column is harmless and dropping it would discard the tokens of anyone still
    # holding an old shortcut.

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

    async def has_active_bank_sync(self, user_id: int) -> bool:
        """True when this user has a bank or card connection that imports transactions.

        Used to decide whether generated subscription rows are still needed: once sync
        is running it imports the real charge, so generating one would double-count.
        """
        try:
            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        # 'error' counts as active: bankSyncScheduler retries errored
                        # connections hourly, so the real charge still arrives. Only
                        # 'invalid_credentials' and 'disabled' never auto-retry.
                        "SELECT 1 FROM bank_connections "
                        "WHERE user_id = %s AND status IN ('active', 'pending_first_sync', 'error') LIMIT 1",
                        (user_id,),
                    )
                    return await cur.fetchone() is not None
        except Exception as e:
            # On error keep the old behaviour and record the subscription. That risks a
            # duplicate the user can delete, rather than a silently missing expense.
            logging.error(f"has_active_bank_sync error: {e}")
            return False

    async def get_due_subscriptions(self, today_day: int, current_month: str) -> list[dict]:
        """Active subs whose day_of_month <= today and not yet charged for current_month."""
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    # telegram_chat_id comes along because the billing job DMs the user.
                    # It is NULL for accounts that never linked Telegram — they are still
                    # billed, they just get no message.
                    "SELECT s.subscription_id, s.user_id, s.name, s.amount, s.currency, "
                    "       c.name AS category, u.telegram_chat_id "
                    "FROM subscriptions s "
                    "LEFT JOIN categories c ON s.category_id = c.category_id "
                    "LEFT JOIN users u ON u.user_id = s.user_id "
                    "WHERE s.active = TRUE AND s.day_of_month <= %s "
                    "  AND (s.last_charged_month IS NULL OR s.last_charged_month < %s)",
                    (today_day, current_month),
                )
                rows = await cur.fetchall()
        keys = ["subscription_id", "user_id", "name", "amount", "currency", "category", "telegram_chat_id"]
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

    async def get_cycle_settings(self, user_id: int) -> dict:
        """The user's financial-cycle settings, for app.services.cycle.

        Returns the calendar-month defaults for a user who has not configured anything —
        or if the row has gone — so a budget warning is never blocked on a settings read.
        """
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT cycle_anchor_day, salary_day FROM users WHERE user_id = %s",
                    (user_id,),
                )
                row = await cur.fetchone()
        if not row:
            return {"cycle_anchor_day": 1, "salary_day": 1}
        return {"cycle_anchor_day": row[0], "salary_day": row[1]}

    async def get_category_spending(self, user_id: int, category_name: str, cycle) -> float:
        """Total spent in a category over one financial cycle.

        Takes a resolved Cycle rather than a 'YYYY-MM' string: the bot's budget warnings
        have to measure the same window the dashboard's budget bars do, and that window
        starts on the user's anchor day, not the 1st.
        """
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT COALESCE(SUM(e.amount), 0) FROM expenses e "
                    "JOIN categories c ON e.category_id = c.category_id "
                    "WHERE e.user_id = %s AND c.name = %s "
                    "  AND e.created_at >= %s AND e.created_at < %s",
                    (user_id, category_name, cycle.start, cycle.end),
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
        # "Month" here means the user's financial CYCLE — their card-settlement day to the
        # day before the next one. The AI answers questions like "how much did I spend this
        # month" and must not contradict the dashboard by measuring a calendar month.
        settings = await self.get_cycle_settings(user_id)
        this_cycle = cycle_svc.resolve_cycle(cycle_svc.current_cycle_key(settings, today), settings)

        if timeframe == "current_month":
            start_date = this_cycle.start
            end_date = today
        elif timeframe == "last_month":
            prev = cycle_svc.resolve_cycle(cycle_svc.add_months(this_cycle.key, -1), settings)
            start_date = prev.start
            end_date = prev.last_day
        elif timeframe == "last_3_months":
            start_date = cycle_svc.resolve_cycle(
                cycle_svc.add_months(this_cycle.key, -3), settings
            ).start
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

    # Duplicate cleanup lives in the backend now: backend/src/services/duplicateMatcher.js
    # holds the matching rules and cleanupController.js runs the archive/restore flow.
    # It was moved so there is one implementation behind the web UI rather than two that
    # can drift, and so web-origin users are covered too - this pool resolves users by
    # Telegram chat id and therefore cannot serve them at all.
    #
    # cad5b82 fixed the refund sign here (ABS(charged_amount) never matched a negative
    # reimbursement); that same fix is carried in loadSyncedExpenses(), which joins the
    # imported expense row and compares its own amount. Nothing was lost in the move.
