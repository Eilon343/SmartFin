"""Quick smoke-test for get_dynamic_financial_context.
Run from repo root:  python bot/test_context.py
Requires: pip install aiomysql python-dotenv   (already in bot/requirements.txt)
"""
import asyncio
import sys
import os
import json
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from app.database.DatabaseManager import DatabaseManager

USER_ID = 938418219  # Telegram chat ID = bot user_id

async def main():
    db = DatabaseManager(
        host="localhost",
        user="root",
        password="7549649Ee",
        db="smartfin",
    )
    # aiomysql needs port kwarg separately
    db.config["port"] = 3307

    print("=== TEST 1: current_month + Food ===")
    ctx = await db.get_dynamic_financial_context(USER_ID, "current_month", "Food")
    print(json.dumps(ctx, indent=2, ensure_ascii=False, default=str))

    print("\n=== TEST 2: March 2026 (manual date patch) ===")
    # Temporarily override today inside the method by calling internal queries directly
    pool = await db.get_pool()
    start = date(2026, 3, 1)
    end   = date(2026, 3, 31)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            # total spending March
            await cur.execute(
                "SELECT COALESCE(SUM(e.amount),0) FROM expenses e "
                "WHERE e.user_id=%s AND e.is_virtual=FALSE "
                "AND e.created_at BETWEEN %s AND %s",
                (USER_ID, start, end),
            )
            (total,) = await cur.fetchone()

            # by category March
            await cur.execute(
                "SELECT c.name, COALESCE(SUM(e.amount),0) "
                "FROM expenses e LEFT JOIN categories c ON e.category_id=c.category_id "
                "WHERE e.user_id=%s AND e.is_virtual=FALSE "
                "AND e.created_at BETWEEN %s AND %s "
                "GROUP BY c.name ORDER BY 2 DESC",
                (USER_ID, start, end),
            )
            rows = await cur.fetchall()

    print(f"total_spending March: ₪{float(total):,.2f}")
    print("by category:")
    for name, amt in rows:
        print(f"  {name or 'Uncategorized'}: ₪{float(amt):,.2f}")

    pool.close()
    await pool.wait_closed()

asyncio.run(main())
