"""
Tests for bot/app/database/DatabaseManager.py

Mocks the aiomysql connection pool — no real DB required.
"""
import hashlib
import pytest
from unittest.mock import AsyncMock, MagicMock, patch, call


def _make_cursor(fetchall=None, fetchone=None, lastrowid=None, rowcount=1):
    cur = AsyncMock()
    cur.__aenter__ = AsyncMock(return_value=cur)
    cur.__aexit__ = AsyncMock(return_value=False)
    cur.fetchall = AsyncMock(return_value=fetchall or [])
    cur.fetchone = AsyncMock(return_value=fetchone)
    cur.lastrowid = lastrowid or 0
    cur.rowcount = rowcount
    cur.execute = AsyncMock()
    return cur


def _make_conn(cursor):
    conn = AsyncMock()
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=False)
    conn.cursor = MagicMock(return_value=cursor)
    conn.commit = AsyncMock()
    conn.rollback = AsyncMock()
    return conn


def _make_pool(conn):
    pool = AsyncMock()
    pool.acquire = MagicMock(return_value=conn)
    return pool


async def _get_db_with_pool(pool):
    from app.database.DatabaseManager import DatabaseManager
    db = DatabaseManager.__new__(DatabaseManager)
    db.pool = pool
    return db


# ── user resolution & link codes ──────────────────────────────────────────────

class TestResolveUserByChatId:
    """ensure_user() used to live here and is deliberately gone.

    It created a users row keyed by the Telegram id, which is what let the bot mint accounts
    nobody had proven ownership of. The bot now only ever *resolves* an existing link.
    """

    @pytest.mark.asyncio
    async def test_resolves_chat_id_to_the_linked_account(self):
        # An app-origin account: user_id is a DB-assigned id, nothing like the chat id.
        cur = _make_cursor(fetchone=(10000000000007,))
        db = await _get_db_with_pool(_make_pool(_make_conn(cur)))

        user_id = await db.get_user_id_by_chat_id(12345)

        assert user_id == 10000000000007
        sql = cur.execute.call_args[0][0]
        assert "telegram_chat_id" in sql.lower()
        # The lookup must NOT be by user_id — that was the bug.
        assert "where user_id" not in sql.lower()
        assert cur.execute.call_args[0][1] == ("12345",)

    @pytest.mark.asyncio
    async def test_returns_none_for_an_unlinked_chat(self):
        cur = _make_cursor(fetchone=None)
        db = await _get_db_with_pool(_make_pool(_make_conn(cur)))

        assert await db.get_user_id_by_chat_id(999) is None

    @pytest.mark.asyncio
    async def test_the_bot_can_no_longer_create_accounts(self):
        db = await _get_db_with_pool(_make_pool(_make_conn(_make_cursor())))

        assert not hasattr(db, "ensure_user")
        assert not hasattr(db, "link_google_account")


class TestRedeemLinkCode:
    @pytest.mark.asyncio
    async def test_links_the_chat_on_a_valid_code(self):
        # rowcount 1 = the conditional UPDATE claimed the code.
        cur = _make_cursor(fetchone=(777,), rowcount=1)
        db = await _get_db_with_pool(_make_pool(_make_conn(cur)))

        # owner lookup -> 777, then chat-ownership lookup -> 777 (same user, idempotent)
        result = await db.redeem_link_code("ABCD1234", 55501)

        assert result == "ok"
        statements = [c[0][0] for c in cur.execute.call_args_list]
        assert any("UPDATE telegram_link_codes" in s for s in statements)
        assert any("UPDATE users SET telegram_chat_id" in s for s in statements)

    @pytest.mark.asyncio
    async def test_rejects_a_used_or_expired_code_without_linking(self):
        # rowcount 0 = used_at was already set, or expires_at has passed. The single
        # conditional UPDATE covers both, so neither can be redeemed.
        cur = _make_cursor(rowcount=0)
        db = await _get_db_with_pool(_make_pool(_make_conn(cur)))

        result = await db.redeem_link_code("ABCD1234", 55501)

        assert result == "invalid"
        statements = [c[0][0] for c in cur.execute.call_args_list]
        assert not any("UPDATE users" in s for s in statements)

    @pytest.mark.asyncio
    async def test_rejects_an_empty_code_without_touching_the_database(self):
        cur = _make_cursor()
        db = await _get_db_with_pool(_make_pool(_make_conn(cur)))

        assert await db.redeem_link_code("", 55501) == "invalid"
        cur.execute.assert_not_called()

    @pytest.mark.asyncio
    async def test_stores_only_a_hash_never_the_code(self):
        cur = _make_cursor(fetchone=(777,), rowcount=1)
        db = await _get_db_with_pool(_make_pool(_make_conn(cur)))

        await db.redeem_link_code("ABCD1234", 55501)

        expected = hashlib.sha256(b"ABCD1234").hexdigest()
        assert cur.execute.call_args_list[0][0][1] == (expected,)

    @pytest.mark.asyncio
    async def test_normalizes_case_and_separators(self):
        cur = _make_cursor(fetchone=(777,), rowcount=1)
        db = await _get_db_with_pool(_make_pool(_make_conn(cur)))

        await db.redeem_link_code(" abcd-1234 ", 55501)

        expected = hashlib.sha256(b"ABCD1234").hexdigest()
        assert cur.execute.call_args_list[0][0][1] == (expected,)


# ── get_user_categories ───────────────────────────────────────────────────────

class TestGetUserCategories:
    @pytest.mark.asyncio
    async def test_returns_base_and_user_categories(self):
        cur = _make_cursor(fetchall=[
            ("Food",), ("Transport",), ("Gym",)
        ])
        conn = _make_conn(cur)
        pool = _make_pool(conn)
        db = await _get_db_with_pool(pool)

        result = await db.get_user_categories(12345)

        assert "Food" in result
        assert "Gym" in result

    @pytest.mark.asyncio
    async def test_returns_empty_list_when_no_categories(self):
        cur = _make_cursor(fetchall=[])
        conn = _make_conn(cur)
        pool = _make_pool(conn)
        db = await _get_db_with_pool(pool)

        result = await db.get_user_categories(12345)

        assert result == []


# ── add_expense ───────────────────────────────────────────────────────────────

class TestAddExpense:
    @pytest.mark.asyncio
    async def test_adds_expense_with_existing_category(self):
        cur = _make_cursor(
            fetchone=(3,),  # get_or_create_category_id returns row[0]
            lastrowid=100
        )
        conn = _make_conn(cur)
        pool = _make_pool(conn)
        db = await _get_db_with_pool(pool)

        result = await db.add_expense(
            user_id=12345, amount=55.0, description="coffee",
            category_name="Food", currency="ILS", source="bot"
        )

        assert result is True

    @pytest.mark.asyncio
    async def test_adds_expense_with_null_category(self):
        cur = _make_cursor(lastrowid=101)
        conn = _make_conn(cur)
        pool = _make_pool(conn)
        db = await _get_db_with_pool(pool)

        result = await db.add_expense(
            user_id=12345, amount=55.0, description="mystery",
            category_name=None, currency="ILS", source="bot"
        )

        assert result is True

    @pytest.mark.asyncio
    async def test_returns_false_on_db_error(self):
        cur = _make_cursor()
        cur.execute = AsyncMock(side_effect=Exception("DB error"))
        conn = _make_conn(cur)
        pool = _make_pool(conn)
        db = await _get_db_with_pool(pool)

        result = await db.add_expense(
            user_id=12345, amount=55.0, description="coffee",
            category_name="Food", currency="ILS", source="bot"
        )

        assert result is False


# ── add_income ────────────────────────────────────────────────────────────────

class TestAddIncome:
    @pytest.mark.asyncio
    async def test_adds_fixed_income(self):
        cur = _make_cursor(lastrowid=10)
        conn = _make_conn(cur)
        pool = _make_pool(conn)
        db = await _get_db_with_pool(pool)

        result = await db.add_income(
            user_id=12345, source="Salary", amount=15000.0,
            income_type="fixed", month="2026-04", currency="ILS"
        )

        assert result is True

    @pytest.mark.asyncio
    async def test_adds_variable_income(self):
        cur = _make_cursor(lastrowid=11)
        conn = _make_conn(cur)
        pool = _make_pool(conn)
        db = await _get_db_with_pool(pool)

        result = await db.add_income(
            user_id=12345, source="Table sale", amount=800.0,
            income_type="variable", month="2026-04", currency="ILS"
        )

        assert result is True


# ── get_category_spending ─────────────────────────────────────────────────────

class TestGetCategorySpending:
    @pytest.mark.asyncio
    async def test_returns_total_spent(self):
        cur = _make_cursor(fetchone=(450.0,))
        conn = _make_conn(cur)
        pool = _make_pool(conn)
        db = await _get_db_with_pool(pool)

        result = await db.get_category_spending(12345, "Food", "2026-04")

        assert result == 450.0

    @pytest.mark.asyncio
    async def test_returns_zero_when_no_expenses(self):
        cur = _make_cursor(fetchone=(0,))  # COALESCE in SQL prevents NULL
        conn = _make_conn(cur)
        pool = _make_pool(conn)
        db = await _get_db_with_pool(pool)

        result = await db.get_category_spending(12345, "Food", "2026-04")

        assert result == 0.0


# ── deposit_to_savings_goal ───────────────────────────────────────────────────

class TestDepositToSavingsGoal:
    @pytest.mark.asyncio
    async def test_successful_deposit(self):
        cur = _make_cursor(rowcount=1)
        conn = _make_conn(cur)
        pool = _make_pool(conn)
        db = await _get_db_with_pool(pool)

        result = await db.deposit_to_savings_goal(12345, goal_id=1, amount=500.0)

        assert result is True

    @pytest.mark.asyncio
    async def test_returns_false_for_unknown_goal(self):
        cur = _make_cursor(rowcount=0)  # no rows affected
        conn = _make_conn(cur)
        pool = _make_pool(conn)
        db = await _get_db_with_pool(pool)

        result = await db.deposit_to_savings_goal(12345, goal_id=999, amount=500.0)

        assert result is False
