import logging
from datetime import datetime, timedelta, date
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


async def _charge_due_subscriptions(bot: Bot, db_manager):
    """Daily: record any subscription whose day_of_month has arrived this month.

    Users with a bank or card connected get NO generated expense row. Their real charge
    is imported by sync with the actual merchant name and the actual amount — which
    drifts as providers raise prices — so a generated row would be a guess competing
    with a fact, and would double-count against the imported charge.

    The subscription is still marked charged, so the job stays idempotent for the month
    and P&L stops forecasting a charge that has already happened.
    """
    today = date.today()
    today_day = today.day
    current_month = today.strftime("%Y-%m")

    due = await db_manager.get_due_subscriptions(today_day, current_month)
    synced_users: dict[int, bool] = {}

    for sub in due:
        try:
            user_id = sub["user_id"]
            if user_id not in synced_users:
                synced_users[user_id] = await db_manager.has_active_bank_sync(user_id)

            if synced_users[user_id]:
                await db_manager.mark_subscription_charged(sub["subscription_id"], current_month)
                logging.info(
                    "Subscription '%s' (sub_id=%s): no expense written — bank/card sync "
                    "imports the real charge",
                    sub["name"], sub["subscription_id"],
                )
                continue

            success = await db_manager.add_expense(
                user_id=user_id,
                amount=sub["amount"],
                description=f"[Subscription] {sub['name']}",
                category_name=sub.get("category"),
                currency=sub["currency"],
                source="bot",
            )
            if not success:
                logging.error(f"Subscription expense failed for sub_id={sub['subscription_id']}, skipping charge mark")
                continue
            await db_manager.mark_subscription_charged(sub["subscription_id"], current_month)
            # The DM goes to telegram_chat_id, NOT user_id. Those are the same number only
            # for legacy bot-origin accounts; an app-origin user_id is a DB-assigned id well
            # outside the chat-id range, so sending to it would fail or, worse, reach an
            # unrelated chat. None means the user never linked Telegram — they are still
            # billed, they just get no message.
            chat_id = sub.get("telegram_chat_id")
            if chat_id:
                try:
                    await bot.send_message(
                        chat_id,
                        f"💳 Auto-charged: *{sub['name']}* — ₪{float(sub['amount']):.2f}",
                        parse_mode="Markdown",
                    )
                except Exception as e:
                    logging.error(f"Subscription notify error: {e}")
        except Exception as e:
            logging.error(f"Subscription charge error for sub_id={sub['subscription_id']}: {e}")


def setup_scheduler(bot: Bot, db_manager) -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler()

    async def send_spending_scores():
        # Resolved per run, not captured at setup: a user who links their account
        # after the bot starts must still get their weekly score.
        #
        # user_id keys the financial queries; chat_id is where the message goes. They are
        # the same number only for legacy bot-origin accounts.
        for user_id, chat_id in await db_manager.get_notifiable_users():
            try:
                data = await _compute_spending_score(db_manager, user_id)
                text = _format_score_message(data)
                await bot.send_message(chat_id, text, parse_mode="Markdown")
            except Exception as e:
                logging.error(f"Spending score error for {user_id}: {e}")

    # Every Saturday at 09:00 local time
    scheduler.add_job(
        send_spending_scores,
        CronTrigger(day_of_week="sat", hour=9, minute=0),
        id="weekly_spending_score",
        replace_existing=True,
    )

    # Must be an `async def`, NOT `lambda: _charge_due_subscriptions(...)`.
    # AsyncIOScheduler routes a job to its event loop only when the function passes
    # iscoroutinefunction(); a plain lambda fails that test, so APScheduler ran it in a
    # worker thread, where it built the coroutine and threw it away without awaiting it.
    # Subscriptions silently stopped being billed from 2026-04-27 (commit 3837072) until
    # this was fixed — the only symptom was a "coroutine was never awaited" warning.
    async def charge_due_subscriptions():
        await _charge_due_subscriptions(bot, db_manager)

    # Every day at 09:00 — bill due subscriptions (idempotent per month)
    scheduler.add_job(
        charge_due_subscriptions,
        CronTrigger(hour=9, minute=0),
        id="daily_subscription_billing",
        replace_existing=True,
    )

    return scheduler
