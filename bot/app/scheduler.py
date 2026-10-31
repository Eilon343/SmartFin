import logging
from datetime import date
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from aiogram import Bot


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
    # Deliberately a CALENDAR month, not a cycle key. `last_charged_month` exists to keep
    # this job idempotent — a subscription billed on the 12th charges once per calendar
    # month, whatever the user's cycle looks like — and the P&L's "still ahead" test no
    # longer reads this column at all; it resolves billing days to real dates instead.
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
