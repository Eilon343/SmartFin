import os
import logging
from datetime import datetime, timedelta
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from aiogram import Bot


async def _compute_spending_score(db_manager, user_id: int) -> dict:
    pool = await db_manager.get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            # This week (Mon–today)
            today = datetime.now().date()
            week_start = today - timedelta(days=today.weekday())
            await cur.execute(
                "SELECT COALESCE(SUM(amount), 0) FROM expenses "
                "WHERE user_id = %s AND created_at >= %s",
                (user_id, week_start),
            )
            (week_total,) = await cur.fetchone()

            # Monthly average over the past 3 full months
            await cur.execute(
                "SELECT COALESCE(SUM(amount), 0), COUNT(DISTINCT DATE_FORMAT(created_at,'%%Y-%%m')) "
                "FROM expenses "
                "WHERE user_id = %s AND created_at < DATE_FORMAT(NOW(),'%%Y-%%m-01') "
                "  AND created_at >= DATE_FORMAT(NOW() - INTERVAL 3 MONTH,'%%Y-%%m-01')",
                (user_id,),
            )
            row = await cur.fetchone()
            total_past, months = row
            monthly_avg = float(total_past) / max(int(months), 1)
            # Weekly equivalent of monthly average (month ≈ 4.33 weeks)
            weekly_avg = monthly_avg / 4.33

    return {
        "week_total": float(week_total),
        "weekly_avg": round(weekly_avg, 2),
    }


def _format_score_message(data: dict) -> str:
    week = data["week_total"]
    avg = data["weekly_avg"]
    if avg == 0:
        return "📊 *Weekly Spending Score*\nNot enough history yet — keep logging expenses!"

    ratio = week / avg
    if ratio <= 0.8:
        grade, emoji = "Excellent", "🟢"
    elif ratio <= 1.0:
        grade, emoji = "Good", "🔵"
    elif ratio <= 1.2:
        grade, emoji = "Over budget", "🟡"
    else:
        grade, emoji = "Way over budget", "🔴"

    pct = (ratio - 1) * 100
    direction = "more" if pct > 0 else "less"
    return (
        f"📊 *Weekly Spending Score*\n"
        f"━━━━━━━━━━━━━━\n"
        f"This week: `₪ {week:.2f}`\n"
        f"Weekly avg: `₪ {avg:.2f}`\n"
        f"Result: {emoji} *{grade}*\n"
        f"You spent `{abs(pct):.0f}%` {direction} than usual."
    )


def setup_scheduler(bot: Bot, db_manager) -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler()

    allowed_ids = [
        int(uid)
        for uid in os.getenv("TELEGRAM_CHAT_ID", "").split(",")
        if uid.strip()
    ]

    async def send_spending_scores():
        for user_id in allowed_ids:
            try:
                data = await _compute_spending_score(db_manager, user_id)
                text = _format_score_message(data)
                await bot.send_message(user_id, text, parse_mode="Markdown")
            except Exception as e:
                logging.error(f"Spending score error for {user_id}: {e}")

    # Every Saturday at 09:00 local time
    scheduler.add_job(
        send_spending_scores,
        CronTrigger(day_of_week="sat", hour=9, minute=0),
        id="weekly_spending_score",
        replace_existing=True,
    )

    return scheduler
