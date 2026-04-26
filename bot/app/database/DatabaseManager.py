import aiomysql
import logging
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

    async def set_user_pin(self, user_id: int, pin_hash: str) -> bool:
        try:
            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "UPDATE users SET pin_hash = %s WHERE user_id = %s",
                        (pin_hash, user_id),
                    )
            return True
        except Exception as e:
            logging.error(f"set_user_pin error: {e}")
            return False

    async def get_user_pin_hash(self, user_id: int) -> str | None:
        pool = await self.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute("SELECT pin_hash FROM users WHERE user_id = %s", (user_id,))
                row = await cur.fetchone()
        return row[0] if row else None

    async def link_google_account(self, user_id: int, email: str) -> bool:
        try:
            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "UPDATE users SET google_email = %s WHERE user_id = %s",
                        (email.lower().strip(), user_id),
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

    async def add_expense(
        self,
        user_id: int,
        amount: float,
        description: str | None,
        category_name: str | None,
        currency: str = "ILS",
    ) -> bool:
        try:
            category_id = None
            if category_name:
                category_id = await self.get_or_create_category_id(user_id, category_name)

            pool = await self.get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "INSERT INTO expenses (user_id, amount, currency, description, category_id) "
                        "VALUES (%s, %s, %s, %s, %s)",
                        (user_id, amount, currency, description, category_id),
                    )
            return True
        except Exception as e:
            logging.error(f"add_expense error: {e}")
            return False
