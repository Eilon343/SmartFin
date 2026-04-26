import asyncio
import logging
import os
from aiogram import Bot, Dispatcher
from bot.app.database.DatabaseManager import DatabaseManager
from bot.app.bot.handlers import register_handlers


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

async def main():
    # Load environment variables
    db_manager = DatabaseManager(
        host=os.getenv("DB_HOST"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        db=os.getenv("DB_NAME")
    )
    
    # Initialize bot and dispatcher
    bot = Bot(token=os.getenv("TELEGRAM_BOT_TOKEN"))
    dp = Dispatcher()
    
    # Register handlers
    register_handlers(dp, db_manager)
    
    logging.info("SmartFin Bot is starting...")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())