import asyncio
import logging
import os
from aiogram import Bot, Dispatcher
from app.database.DatabaseManager import DatabaseManager
from app.bot.handlers import register_handlers
from app.scheduler import setup_scheduler


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)


async def main():
    db_manager = DatabaseManager(
        host=os.getenv("DB_HOST"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        db=os.getenv("DB_NAME"),
    )

    bot = Bot(token=os.getenv("TELEGRAM_BOT_TOKEN"))
    dp = Dispatcher()

    register_handlers(dp, db_manager)

    scheduler = setup_scheduler(bot, db_manager)
    scheduler.start()

    logging.info("SmartFin Bot is starting...")
    try:
        await dp.start_polling(bot)
    finally:
        scheduler.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
