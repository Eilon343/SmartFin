import os
import logging
from datetime import datetime
from aiogram import Dispatcher, types, F
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton

from app.ai.ai_engine import parse_input
from app.bot.states import ExpenseFlow, IncomeFlow, SubscriptionFlow

ALLOWED_USER_IDS: set[int] = {int(uid) for uid in os.getenv("TELEGRAM_CHAT_ID", "").split(",") if uid.strip()}

WITTY_UNSUPPORTED = (
    "🧙 I only do financial magic — expenses, income, subscriptions, and savings.\n"
    "Try: `55 NIS shawarma`, `got salary 15000`, or `add Netflix 39.90 monthly`."
)


def _auth(user_id: int) -> bool:
    return user_id in ALLOWED_USER_IDS



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


def _simple_confirm_keyboard(confirm_data: str, cancel_data: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="✅ Confirm", callback_data=confirm_data),
        InlineKeyboardButton(text="🗑️ Cancel", callback_data=cancel_data),
    ]])


def _format_expense_confirmation(data: dict) -> str:
    amount = data.get("amount", "?")
    currency = data.get("currency", "ILS")
    item = data.get("item") or data.get("description") or "Unknown item"
    category = data.get("category", "Uncategorized")
    warning = data.get("budget_warning", "")
    text = (
        f"📋 *Expense Summary*\n"
        f"━━━━━━━━━━━━━━\n"
        f"💰 Amount: `{amount} {currency}`\n"
        f"📝 Item: {item}\n"
        f"📂 Category: {category}\n"
        f"━━━━━━━━━━━━━━\n"
    )
    if warning:
        text += f"{warning}\n━━━━━━━━━━━━━━\n"
    text += "Is this correct?"
    return text


async def _check_budget_warning(db_manager, user_id: int, category_name: str | None, amount: float) -> str:
    """Returns a warning string if this expense would push the category to >=80% of budget."""
    if not category_name:
        return ""
    try:
        budget = await db_manager.get_category_budget(user_id, category_name)
        if not budget:
            return ""
        limit = budget["monthly_limit"]
        if limit <= 0:
            return ""
        month = datetime.now().strftime("%Y-%m")
        spent = await db_manager.get_category_spending(user_id, category_name, month)
        new_total = spent + amount
        pct = (new_total / limit) * 100
        if pct >= 100:
            return f"🚨 *Over budget!* This puts you at *{pct:.0f}%* of your {category_name} budget (₪{new_total:.0f} / ₪{limit:.0f})"
        if pct >= 80:
            return f"⚠️ *Budget warning!* This puts you at *{pct:.0f}%* of your {category_name} budget (₪{new_total:.0f} / ₪{limit:.0f})"
    except Exception as e:
        logging.warning(f"Budget warning check failed: {e}")
    return ""


def register_handlers(dp: Dispatcher, db_manager):

    # --- Any non-command text → AI parse → route by intent ---
    @dp.message(F.text & ~F.text.startswith("/"), StateFilter(None))
    async def handle_text(message: types.Message, state: FSMContext):
        if not _auth(message.from_user.id):
            return

        await db_manager.ensure_user(message.from_user.id, message.from_user.username)
        categories = await db_manager.get_user_categories(message.from_user.id)

        try:
            parsed = await parse_input(message.text, categories)
        except Exception as e:
            err_str = str(e)
            logging.error(f"AI parse error: {e}", exc_info=True)
            if "503" in err_str or "UNAVAILABLE" in err_str or "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
                await message.reply("⚠️ AI service is temporarily unavailable (Gemini overloaded). Try again in a minute.")
            else:
                await message.reply("Sorry, I couldn't understand that. Try: '55 NIS for Shawarma'")
            return

        intent = parsed.get("intent", "log_expense")

        if intent == "ERROR_UNSUPPORTED":
            await message.reply(WITTY_UNSUPPORTED, parse_mode="Markdown")
            return

        if intent == "log_income":
            await state.set_state(IncomeFlow.pending_confirmation)
            await state.update_data(parsed=parsed)
            income_type = parsed.get("income_type", "fixed").capitalize()
            source = parsed.get("source") or "Income"
            amount = parsed.get("amount", "?")
            currency = parsed.get("currency", "ILS")
            await message.reply(
                f"💵 *Income Summary*\n"
                f"━━━━━━━━━━━━━━\n"
                f"💰 Amount: `{amount} {currency}`\n"
                f"📌 Source: {source}\n"
                f"🏷️ Type: {income_type}\n"
                f"━━━━━━━━━━━━━━\n"
                f"Log this income?",
                parse_mode="Markdown",
                reply_markup=_simple_confirm_keyboard("confirm_income", "cancel_income"),
            )
            return

        if intent == "log_subscription":
            await state.set_state(SubscriptionFlow.pending_confirmation)
            await state.update_data(parsed=parsed)
            name = parsed.get("name") or "Subscription"
            amount = parsed.get("amount", "?")
            currency = parsed.get("currency", "ILS")
            category = parsed.get("category") or "Uncategorized"
            day = parsed.get("day") or 1
            await message.reply(
                f"🔄 *New Subscription*\n"
                f"━━━━━━━━━━━━━━\n"
                f"📛 Name: {name}\n"
                f"💰 Amount: `{amount} {currency}`\n"
                f"📂 Category: {category}\n"
                f"📅 Charged on day: {day}\n"
                f"━━━━━━━━━━━━━━\n"
                f"Add this recurring subscription?",
                parse_mode="Markdown",
                reply_markup=_simple_confirm_keyboard("confirm_subscription", "cancel_subscription"),
            )
            return

        # Default: log_expense
        warning = await _check_budget_warning(
            db_manager, message.from_user.id,
            parsed.get("category"), float(parsed.get("amount") or 0)
        )
        parsed["budget_warning"] = warning
        await state.set_state(ExpenseFlow.pending_confirmation)
        await state.update_data(parsed=parsed)
        await message.reply(
            _format_expense_confirmation(parsed),
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
        message.text = text
        await handle_text(message, state)

    # --- ✅ Confirm expense ---
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
            source=parsed.get("source", "bot"),
        )

        await state.clear()
        if success:
            await callback.message.edit_text("✅ Expense saved!", reply_markup=None)
        else:
            await callback.message.edit_text("❌ Failed to save. Try again.", reply_markup=None)
        await callback.answer()

    # --- 🗑️ Delete expense ---
    @dp.callback_query(F.data == "delete_expense", ExpenseFlow.pending_confirmation)
    async def callback_delete(callback: types.CallbackQuery, state: FSMContext):
        await state.clear()
        await callback.message.edit_text("🗑️ Expense cancelled.", reply_markup=None)
        await callback.answer()

    # --- ✏️ Edit expense ---
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
        # Re-check budget warning with new amount
        parsed["budget_warning"] = await _check_budget_warning(
            db_manager, message.from_user.id, parsed.get("category"), new_amount
        )
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
            _format_expense_confirmation(parsed),
            parse_mode="Markdown",
            reply_markup=_confirmation_keyboard(),
        )

    # --- 📂 Change Category ---
    @dp.callback_query(F.data == "change_category", ExpenseFlow.pending_confirmation)
    async def callback_change_category(callback: types.CallbackQuery, state: FSMContext):
        user_id = callback.from_user.id
        categories = await db_manager.get_user_categories(user_id)

        buttons = [InlineKeyboardButton(text=cat, callback_data=f"cat:{cat}") for cat in categories]
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
        # Re-check budget warning with new category
        parsed["budget_warning"] = await _check_budget_warning(
            db_manager, callback.from_user.id, selected, float(parsed.get("amount") or 0)
        )
        await state.update_data(parsed=parsed)
        await state.set_state(ExpenseFlow.pending_confirmation)

        await callback.message.delete()
        await callback.message.answer(
            _format_expense_confirmation(parsed),
            parse_mode="Markdown",
            reply_markup=_confirmation_keyboard(),
        )
        await callback.answer()

    # --- ✅ Confirm income ---
    @dp.callback_query(F.data == "confirm_income", IncomeFlow.pending_confirmation)
    async def callback_confirm_income(callback: types.CallbackQuery, state: FSMContext):
        data = await state.get_data()
        parsed = data.get("parsed", {})
        user_id = callback.from_user.id
        month = datetime.now().strftime("%Y-%m")

        success = await db_manager.add_income(
            user_id=user_id,
            source=parsed.get("source") or "Income",
            amount=parsed.get("amount"),
            income_type=parsed.get("income_type", "fixed"),
            month=month,
            currency=parsed.get("currency", "ILS"),
        )

        await state.clear()
        if success:
            await callback.message.edit_text("✅ Income logged!", reply_markup=None)
        else:
            await callback.message.edit_text("❌ Failed to save income. Try again.", reply_markup=None)
        await callback.answer()

    @dp.callback_query(F.data == "cancel_income", IncomeFlow.pending_confirmation)
    async def callback_cancel_income(callback: types.CallbackQuery, state: FSMContext):
        await state.clear()
        await callback.message.edit_text("🗑️ Income cancelled.", reply_markup=None)
        await callback.answer()

    # --- ✅ Confirm subscription ---
    @dp.callback_query(F.data == "confirm_subscription", SubscriptionFlow.pending_confirmation)
    async def callback_confirm_subscription(callback: types.CallbackQuery, state: FSMContext):
        data = await state.get_data()
        parsed = data.get("parsed", {})
        user_id = callback.from_user.id

        day = parsed.get("day") or 1
        try:
            day = max(1, min(28, int(day)))
        except (ValueError, TypeError):
            day = 1

        sub_id = await db_manager.add_subscription(
            user_id=user_id,
            name=parsed.get("name") or "Subscription",
            amount=parsed.get("amount"),
            category_name=parsed.get("category"),
            day_of_month=day,
            currency=parsed.get("currency", "ILS"),
        )

        await state.clear()
        if sub_id:
            await callback.message.edit_text("✅ Subscription added!", reply_markup=None)
        else:
            await callback.message.edit_text("❌ Failed to add subscription. Try again.", reply_markup=None)
        await callback.answer()

    @dp.callback_query(F.data == "cancel_subscription", SubscriptionFlow.pending_confirmation)
    async def callback_cancel_subscription(callback: types.CallbackQuery, state: FSMContext):
        await state.clear()
        await callback.message.edit_text("🗑️ Subscription cancelled.", reply_markup=None)
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

    # --- /add_savings goal_name target_amount monthly_allocation ---
    @dp.message(Command("add_savings"))
    async def handle_add_savings(message: types.Message):
        if not _auth(message.from_user.id):
            return
        parts = message.text.replace("/add_savings", "").strip().split()
        if len(parts) < 2:
            await message.reply(
                "Usage: `/add_savings <name> <target> [monthly_allocation]`\n"
                "Example: `/add_savings \"Flight Tokyo\" 8000 500`",
                parse_mode="Markdown",
            )
            return
        try:
            # Last arg may be monthly_allocation, second-to-last is target, rest is name
            monthly = 0.0
            if len(parts) >= 3:
                try:
                    monthly = float(parts[-1])
                    target = float(parts[-2])
                    name = " ".join(parts[:-2])
                except ValueError:
                    target = float(parts[-1])
                    name = " ".join(parts[:-1])
            else:
                target = float(parts[-1])
                name = " ".join(parts[:-1])
        except ValueError:
            await message.reply("Target amount must be a number.")
            return

        await db_manager.ensure_user(message.from_user.id, message.from_user.username)
        goal_id = await db_manager.add_savings_goal(
            message.from_user.id, name, target, monthly
        )
        if goal_id:
            alloc_line = f"\nMonthly allocation: ₪{monthly:.2f}" if monthly > 0 else ""
            await message.reply(
                f"✅ Savings goal *{name}* created!\n"
                f"Target: ₪{target:.2f}{alloc_line}",
                parse_mode="Markdown",
            )
        else:
            await message.reply("❌ Failed to create savings goal.")

    @dp.message(Command("list_savings"))
    async def handle_list_savings(message: types.Message):
        if not _auth(message.from_user.id):
            return
        goals = await db_manager.list_savings_goals(message.from_user.id)
        if not goals:
            await message.reply("No savings goals yet. Add one with /add\\_savings", parse_mode="Markdown")
            return
        lines = ["🏦 *Savings Goals*", "━━━━━━━━━━━━━━"]
        for g in goals:
            target = float(g["target_amount"])
            saved = float(g["saved_amount"])
            pct = int((saved / target * 100)) if target > 0 else 0
            alloc = float(g["monthly_allocation"])
            bar = "█" * (pct // 10) + "░" * (10 - pct // 10)
            alloc_line = f" · ₪{alloc:.0f}/mo" if alloc > 0 else ""
            lines.append(
                f"`#{g['goal_id']}` *{g['name']}*\n"
                f"  `{bar}` {pct}%\n"
                f"  ₪{saved:.0f} / ₪{target:.0f}{alloc_line}"
            )
        await message.reply("\n".join(lines), parse_mode="Markdown")

    @dp.message(Command("deposit_savings"))
    async def handle_deposit_savings(message: types.Message):
        if not _auth(message.from_user.id):
            return
        parts = message.text.replace("/deposit_savings", "").strip().split()
        if len(parts) != 2 or not parts[0].isdigit():
            await message.reply("Usage: `/deposit_savings <goal_id> <amount>`", parse_mode="Markdown")
            return
        goal_id = int(parts[0])
        try:
            amount = float(parts[1])
        except ValueError:
            await message.reply("Amount must be a number.")
            return

        ok = await db_manager.deposit_to_savings_goal(message.from_user.id, goal_id, amount)
        await message.reply(
            f"✅ ₪{amount:.2f} deposited to goal #{goal_id}!" if ok else "❌ Goal not found."
        )

    # --- /add_subscription ---
    @dp.message(Command("add_subscription"))
    async def handle_add_subscription(message: types.Message):
        if not _auth(message.from_user.id):
            return
        parts = message.text.replace("/add_subscription", "").strip().split()
        if len(parts) < 4:
            await message.reply(
                "Usage: `/add_subscription <name> <amount> <category> <day>`\n"
                "Example: `/add_subscription Netflix 39.90 Entertainment 15`",
                parse_mode="Markdown",
            )
            return
        name = parts[0]
        try:
            amount = float(parts[1])
            day = int(parts[-1])
            category = " ".join(parts[2:-1])
            if not (1 <= day <= 28):
                raise ValueError("day must be 1-28")
        except ValueError as e:
            await message.reply(f"Invalid input: {e}")
            return

        await db_manager.ensure_user(message.from_user.id, message.from_user.username)
        sub_id = await db_manager.add_subscription(
            message.from_user.id, name, amount, category, day
        )
        if sub_id:
            await message.reply(
                f"✅ Subscription `{name}` (₪{amount:.2f}) added.\n"
                f"Will be auto-charged on day {day} each month under *{category}*.",
                parse_mode="Markdown",
            )
        else:
            await message.reply("❌ Failed to add subscription.")

    @dp.message(Command("list_subscriptions"))
    async def handle_list_subscriptions(message: types.Message):
        if not _auth(message.from_user.id):
            return
        subs = await db_manager.list_subscriptions(message.from_user.id)
        if not subs:
            await message.reply("No subscriptions yet. Add one with /add\\_subscription", parse_mode="Markdown")
            return
        lines = ["📋 *Subscriptions*", "━━━━━━━━━━━━━━"]
        for s in subs:
            status = "✅" if s["active"] else "⏸️"
            lines.append(
                f"{status} `#{s['subscription_id']}` *{s['name']}* — "
                f"₪{float(s['amount']):.2f} on day {s['day_of_month']} ({s['category'] or 'Uncategorized'})"
            )
        await message.reply("\n".join(lines), parse_mode="Markdown")

    @dp.message(Command("del_subscription"))
    async def handle_del_subscription(message: types.Message):
        if not _auth(message.from_user.id):
            return
        arg = message.text.replace("/del_subscription", "").strip()
        if not arg.isdigit():
            await message.reply("Usage: `/del_subscription <id>`", parse_mode="Markdown")
            return
        ok = await db_manager.delete_subscription(message.from_user.id, int(arg))
        await message.reply("✅ Deleted." if ok else "❌ Not found.")

    # --- /set_budget ---
    @dp.message(Command("set_budget"))
    async def handle_set_budget(message: types.Message):
        if not _auth(message.from_user.id):
            return
        parts = message.text.replace("/set_budget", "").strip().rsplit(maxsplit=1)
        if len(parts) != 2:
            await message.reply(
                "Usage: `/set_budget <category> <monthly_limit>`\n"
                "Example: `/set_budget Food 1500`",
                parse_mode="Markdown",
            )
            return
        category, limit_str = parts
        try:
            limit = float(limit_str)
        except ValueError:
            await message.reply("Limit must be a number.")
            return

        await db_manager.ensure_user(message.from_user.id, message.from_user.username)
        ok = await db_manager.set_budget(message.from_user.id, category, limit, carry_over=True)
        if ok:
            await message.reply(
                f"✅ Budget set: *{category}* — ₪{limit:.2f}/month (carry-over enabled).",
                parse_mode="Markdown",
            )
        else:
            await message.reply("❌ Failed to set budget.")

    @dp.message(Command("list_budgets"))
    async def handle_list_budgets(message: types.Message):
        if not _auth(message.from_user.id):
            return
        budgets = await db_manager.list_budgets(message.from_user.id)
        if not budgets:
            await message.reply("No budgets yet. Set one with /set\\_budget", parse_mode="Markdown")
            return
        lines = ["💰 *Budgets*", "━━━━━━━━━━━━━━"]
        for b in budgets:
            roll = "🔄" if b["carry_over"] else "  "
            lines.append(f"{roll} *{b['category']}* — ₪{float(b['monthly_limit']):.2f}/mo")
        await message.reply("\n".join(lines), parse_mode="Markdown")

    # --- /link_google ---
    @dp.message(Command("link_google"))
    async def handle_link_google(message: types.Message):
        if not _auth(message.from_user.id):
            return
        email = message.text.replace("/link_google", "").strip()
        if not email or "@" not in email:
            await message.reply("Usage: `/link_google your@email.com`", parse_mode="Markdown")
            return

        await db_manager.ensure_user(message.from_user.id, message.from_user.username)
        success = await db_manager.link_google_account(message.from_user.id, email)
        if success:
            await message.reply(
                f"✅ Google account `{email}` linked to your Telegram.\n"
                f"You can now sign in at the dashboard with that Google account.",
                parse_mode="Markdown",
            )
        else:
            await message.reply("❌ Failed to link account. Try again.")

    # --- /start ---
    @dp.message(Command("start"))
    async def handle_start(message: types.Message):
        if not _auth(message.from_user.id):
            return
        await message.reply(
            "👋 Welcome to *SmartFin*!\n\n"
            "Just send me anything in natural language:\n"
            "`55 NIS shawarma` → logs an expense\n"
            "`got salary 15000` → logs income\n"
            "`add Netflix 39.90 monthly` → adds a subscription\n\n"
            "*Expenses & Categories*\n"
            "/add\\_category `<name>`\n\n"
            "*Subscriptions*\n"
            "/add\\_subscription `<name> <amount> <category> <day>`\n"
            "/list\\_subscriptions · /del\\_subscription `<id>`\n\n"
            "*Budgets*\n"
            "/set\\_budget `<category> <limit>` · /list\\_budgets\n\n"
            "*Savings Goals*\n"
            "/add\\_savings `<name> <target> [monthly_allocation]`\n"
            "/list\\_savings · /deposit\\_savings `<goal_id> <amount>`\n\n"
            "*Account*\n"
            "/link\\_google `<email>`",
            parse_mode="Markdown",
        )
