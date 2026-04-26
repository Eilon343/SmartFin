import os
import json
import asyncio
import logging
import aiomysql
from dotenv import load_dotenv
from google import genai
from aiogram import Bot, Dispatcher, types
from aiogram.filters import Command

load_dotenv()

GeminiApi = os.getenv("GEMINI_API_KEY")

client = genai.Client(api_key=GeminiApi)

BotApi = os.getenv("TELEGRAM_BOT_TOKEN")
ChatId = os.getenv("TELEGRAM_CHAT_ID")
logging.basicConfig(level=logging.INFO)

bot = Bot(token=BotApi)
dp = Dispatcher()

async def save_expense(amount, category, description):
    try:
        conn = await aiomysql.connect(
            host=os.getenv("DB_HOST"), user=os.getenv("DB_USER"), password=os.getenv("DB_PASSWORD"), db=os.getenv("DB_NAME")
        )
        async with conn.cursor() as cur:
            sql = "INSERT INTO expenses (amount, category, description) VALUES (%s, %s, %s)"
            await cur.execute(sql, (amount, category, description))
            await conn.commit()
        conn.close()
        return True
    except Exception as e:
        logging.error(f"Database error: {e}")
        return False
    
def parse_input(user_input):
    prompt = "Parse the following expense into a JSON format with the following fields: amount, category, date, and description. If any field is missing, return null for that field. Expense: " + user_input
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config={
            "response_mime_type": "application/json"
        }
    )
    return json.loads(response.text)
    
@dp.message(Command("input"))
async def handle_input(message: types.Message):
    user_input = message.text.replace("/input", "").strip()    
    if not user_input:
        await message.reply("Please provide an expense description after the /input command.")
        return
    
    try:
        data = parse_input(user_input)
        success = await save_expense(data.get('amount'), data.get('category'), data.get('description'))
        
        if success:
            response_msg = (
            f"✅ **Parsed Successfully!**\n"
            f"💰 Amount: {data.get('amount')}\n"
            f"🏷️ Category: {data.get('category')}\n"
            f"📝 Info: {data.get('description')}"
            )
        else:
            response_msg = "⚠️ Parsed, but failed to save to Database."
        await message.reply(response_msg, parse_mode="Markdown")
    except Exception as e:
        logging.error(f"Error parsing input: {e}")
        await message.reply("❌ Sorry, I couldn't parse that expense. Please try again with a different description.")
        
async def main():
    print("Bot is starting...")
    await dp.start_polling(bot)
    
if __name__ == '__main__':
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        print("Bot stopped.")
    
