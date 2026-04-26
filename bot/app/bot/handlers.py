import os
import time
import logging
import bcrypt
from aiogram import Dispatcher, types, F
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton

from bot.app.ai.ai_engine import parse_input
from bot.app.bot.states import ExpenseFlow, PinFlow

PIN_TIMEOUT_SECONDS = 300  # 5 minutes

ALLOWED_USER_IDS: set[int] = {int(uid) for uid in os.getenv("TELEGRAM_CHAT_ID", "").split(",") if uid.strip()}


def _auth(user_id: int) -> bool:
    return user_id in ALLOWED_USER_IDS


async def _pin_required(message: types.Message, state: FSMContext, db_manager) -> bool:
    """Returns True if the user must enter their PIN before proceeding."""
    pin_hash = await db_manager.get_user_pin_hash(message.from_user.id)
    if not pin_hash:
        return False  # PIN not set → no lock

    data = await state.get_data()
    last_activity = data.get("last_activity", 0)
    if time.time() - last_activity < PIN_TIMEOUT_SECONDS:
        return False  # still within session window

    # Store context so we can resume after PIN entry
    await state.update_data(pending_message=message.text)
    await state.set_state(PinFlow.waiting_pin)
    await message.reply("🔒 Session locked. Enter your PIN to continue:")
    return True


def _confirmation_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="✅ Confirm", callback_data="confirm_expense"),
            InlineKeyboardButton(text="🗑️ Delete", callback_data="delete_expense"),
        ],
        [
            InlineKeyboardButton(text="✏️ Edit", callback_data="edit_expense"),
            InlineKeyboardButton(text="📂 Change Category", callback_data="change_category"),
        ],
    ])


def _format_confirmation(data: dict) -> str:
    amount = data.get("amount", "?")
    currency = data.get("currency", "ILS")
    item = data.get("item") or data.get("description") or "Unknown item"
    category = data.get("category", "Uncategorized")
    return (
        f"📋 *Expense Summary*\n"
        f"━━━━━━━━━━━━━━\n"
        f"💰 Amount: `{amount} {currency}`\n"
        f"📝 Item: {item}\n"
        f"📂 Category: {category}\n"
        f"━━━━━━━━━━━━━━\n"
        f"Is this correct?"
    )


def register_handlers(dp: Dispatcher, db_manager):

    # --- Any non-command text → treat as expense input ---
    @dp.message(F.text & ~F.text.startswith("/"))
    async def handle_expense_text(message: types.Message, state: FSMContext):
        if not _auth(message.from_user.id):
            return

        await db_manager.ensure_user(message.from_user.id, message.from_user.username)

        if await _pin_required(message, state, db_manager):
            return

        await state.update_data(last_activity=time.time())
        categories = await db_manager.get_user_categories(message.from_user.id)

        try:
            parsed = await parse_input(message.text, categories)
        except Exception as e:
            logging.error(f"AI parse error: {e}")
            await message.reply("Sorry, I couldn't understand that. Try: '55 NIS for Shawarma'")
            return

        await state.set_state(ExpenseFlow.pending_confirmation)
        await state.update_data(parsed=parsed)

        await message.reply(
            _format_confirmation(parsed),
            parse_mode="Markdown",
            reply_markup=_confirmation_keyboard(),
        )

    # --- /input command (alias for backward compat) ---
    @dp.message(Command("input"))
    async def handle_input_command(message: types.Message, state: FSMContext):
        if not _auth(message.from_user.id):
            return
        text = message.text.replace("/input", "").strip()
        if not text:
            await message.reply("Please add the expense after the command, e.g. `/input 55 NIS shawarma`")
            return
        message.text = text  # reuse the handler above
        await handle_expense_text(message, state)

    # --- ✅ Confirm ---
    @dp.callback_query(F.data == "confirm_expense", ExpenseFlow.pending_confirmation)
    async def callback_confirm(callback: types.CallbackQuery, state: FSMContext):
        data = await state.get_data()
        parsed = data.get("parsed", {})
        user_id = callback.from_user.id

        success = await db_manager.add_expense(
            user_id=user_id,
            amount=parsed.get("amount"),
            description=parsed.get("item") or parsed.get("description"),
            category_name=parsed.get("category"),
            currency=parsed.get("currency", "ILS"),
        )

        await state.clear()
        if success:
            await callback.message.edit_text("✅ Expense saved!", reply_markup=None)
        else:
            await callback.message.edit_text("❌ Failed to save. Try again.", reply_markup=None)
        await callback.answer()

    # --- 🗑️ Delete ---
    @dp.callback_query(F.data == "delete_expense", ExpenseFlow.pending_confirmation)
    async def callback_delete(callback: types.CallbackQuery, state: FSMContext):
        await state.clear()
        await callback.message.edit_text("🗑️ Expense cancelled.", reply_markup=None)
        await callback.answer()

    # --- ✏️ Edit → ask what to change ---
    @dp.callback_query(F.data == "edit_expense", ExpenseFlow.pending_confirmation)
    async def callback_edit(callback: types.CallbackQuery, state: FSMContext):
        await state.set_state(ExpenseFlow.editing_amount)
        await callback.message.reply("Enter the corrected amount (numbers only, e.g. `42.50`):")
        await callback.answer()

    @dp.message(ExpenseFlow.editing_amount)
    async def handle_edit_amount(message: types.Message, state: FSMContext):
        if not _auth(message.from_user.id):
            return
        try:
            new_amount = float(message.text.strip())
        except ValueError:
            await message.reply("Please enter a valid number, e.g. `42.50`")
            return

        data = await state.get_data()
        parsed = data["parsed"]
        parsed["amount"] = new_amount
        await state.update_data(parsed=parsed)
        await state.set_state(ExpenseFlow.editing_description)
        await message.reply("Now enter the description (or send `-` to keep the current one):")

    @dp.message(ExpenseFlow.editing_description)
    async def handle_edit_description(message: types.Message, state: FSMContext):
        if not _auth(message.from_user.id):
            return
        data = await state.get_data()
        parsed = data["parsed"]
        if message.text.strip() != "-":
            parsed["item"] = message.text.strip()
        await state.update_data(parsed=parsed)
        await state.set_state(ExpenseFlow.pending_confirmation)
        await message.reply(
            _format_confirmation(parsed),
            parse_mode="Markdown",
            reply_markup=_confirmation_keyboard(),
        )

    # --- 📂 Change Category ---
    @dp.callback_query(F.data == "change_category", ExpenseFlow.pending_confirmation)
    async def callback_change_category(callback: types.CallbackQuery, state: FSMContext):
        user_id = callback.from_user.id
        categories = await db_manager.get_user_categories(user_id)

        buttons = [
            InlineKeyboardButton(text=cat, callback_data=f"cat:{cat}")
            for cat in categories
        ]
        # Layout: 2 columns
        rows = [buttons[i:i+2] for i in range(0, len(buttons), 2)]
        keyboard = InlineKeyboardMarkup(inline_keyboard=rows)

        await state.set_state(ExpenseFlow.selecting_category)
        await callback.message.reply("Choose a category:", reply_markup=keyboard)
        await callback.answer()

    @dp.callback_query(F.data.startswith("cat:"), ExpenseFlow.selecting_category)
    async def callback_select_category(callback: types.CallbackQuery, state: FSMContext):
        selected = callback.data.removeprefix("cat:")
        data = await state.get_data()
        parsed = data["parsed"]
        parsed["category"] = selected
        await state.update_data(parsed=parsed)
        await state.set_state(ExpenseFlow.pending_confirmation)

        await callback.message.edit_text(
            _format_confirmation(parsed),
            parse_mode="Markdown",
            reply_markup=_confirmation_keyboard(),
        )
        await callback.answer()

    # --- /add_category ---
    @dp.message(Command("add_category"))
    async def handle_add_category(message: types.Message):
        if not _auth(message.from_user.id):
            return
        name = message.text.replace("/add_category", "").strip()
        if not name:
            await message.reply("Usage: `/add_category Health`")
            return

        success = await db_manager.add_user_category(message.from_user.id, name.capitalize())
        if success:
            await message.reply(f"✅ Category *{name.capitalize()}* added.", parse_mode="Markdown")
        else:
            await message.reply("Failed to add category (it may already exist).")

    # --- PIN unlock ---
    @dp.message(PinFlow.waiting_pin)
    async def handle_pin_entry(message: types.Message, state: FSMContext):
        if not _auth(message.from_user.id):
            return
        pin_hash = await db_manager.get_user_pin_hash(message.from_user.id)
        entered = message.text.strip().encode()
        if pin_hash and bcrypt.checkpw(entered, pin_hash.encode()):
            await state.update_data(last_activity=time.time())
            data = await state.get_data()
            pending = data.get("pending_message")
            await state.set_state(None)
            await message.reply("🔓 Unlocked!")
            if pending:
                message.text = pending
                await handle_expense_text(message, state)
        else:
            await message.reply("❌ Wrong PIN. Try again:")

    # --- /set_pin ---
    @dp.message(Command("set_pin"))
    async def handle_set_pin(message: types.Message, state: FSMContext):
        if not _auth(message.from_user.id):
            return
        await state.set_state(PinFlow.setting_pin)
        await message.reply("Enter your new 4-digit PIN:")

    @dp.message(PinFlow.setting_pin)
    async def handle_pin_input(message: types.Message, state: FSMContext):
        if not _auth(message.from_user.id):
            return
        pin = message.text.strip()
        if not pin.isdigit() or len(pin) < 4:
            await message.reply("PIN must be at least 4 digits. Try again:")
            return
        await state.update_data(new_pin=pin)
        await state.set_state(PinFlow.confirming_pin)
        await message.reply("Confirm your PIN (enter it again):")

    @dp.message(PinFlow.confirming_pin)
    async def handle_pin_confirm(message: types.Message, state: FSMContext):
        if not _auth(message.from_user.id):
            return
        data = await state.get_data()
        if message.text.strip() != data.get("new_pin"):
            await state.set_state(PinFlow.setting_pin)
            await message.reply("PINs don't match. Enter your new PIN again:")
            return
        pin_hash = bcrypt.hashpw(message.text.strip().encode(), bcrypt.gensalt()).decode()
        await db_manager.set_user_pin(message.from_user.id, pin_hash)
        await state.clear()
        await message.reply("✅ PIN set successfully. You'll be asked for it after 5 minutes of inactivity.")

    # --- /start ---
    @dp.message(Command("start"))
    async def handle_start(message: types.Message):
        if not _auth(message.from_user.id):
            return
        await message.reply(
            "👋 Welcome to *SmartFin*!\n\n"
            "Just send me any expense, e.g.:\n"
            "`55 NIS shawarma`\n"
            "`200 groceries`\n\n"
            "Commands:\n"
            "/add\\_category `<name>` — add a custom category\n"
            "/set\\_pin — set a session PIN lock",
            parse_mode="Markdown",
        )
