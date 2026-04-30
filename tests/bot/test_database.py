"""
Tests for bot/app/database/DatabaseManager.py

Mocks the aiomysql connection pool — no real DB required.
"""
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


# ── ensure_user ───────────────────────────────────────────────────────────────

class TestEnsureUser:
    @pytest.mark.asyncio
    async def test_inserts_new_user(self):
        cur = _make_cursor()
        conn = _make_conn(cur)
        pool = _make_pool(conn)
        db = await _get_db_with_pool(pool)

        await db.ensure_user(12345, "eilon")

        cur.execute.assert_called_once()
        sql = cur.execute.call_args[0][0]
        assert "INSERT" in sql.upper()
        assert "users" in sql.lower()

    @pytest.mark.asyncio
    async def test_handles_existing_user_via_upsert(self):
        """ON DUPLICATE KEY UPDATE means calling twice should not raise."""
        cur = _make_cursor()
        conn = _make_conn(cur)
        pool = _make_pool(conn)
        db = await _get_db_with_pool(pool)

        await db.ensure_user(12345, "eilon")
        await db.ensure_user(12345, "eilon")

        assert cur.execute.call_count == 2


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
