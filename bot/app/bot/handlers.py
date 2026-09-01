import logging
import time
from datetime import datetime
from aiogram import Dispatcher, types, F
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton
from app.ai.ai_engine import parse_input, generate_financial_advice, AIEngineError
from app.bot.states import ExpenseFlow, IncomeFlow, SubscriptionFlow
from app.services import cycle as cycle_svc

WITTY_UNSUPPORTED = (
    "🧙 I only do financial magic — expenses, income, subscriptions, and savings.\n"
    "Try: `55 NIS shawarma`, `got salary 15000`, or `add Netflix 39.90 monthly`."
)


NOT_LINKED = (
    "👋 This Telegram chat isn't connected to a SmartFin account yet.\n\n"
    "Sign in at the SmartFin web app, open *Settings → Telegram bot*, tap "
    "*Generate code*, then send it here as `/link <code>`."
)


async def _resolve_user(tg_id: int, db_manager) -> int | None:
    """Maps a Telegram id to the SmartFin user_id that linked it, or None.

    Every handler goes through this. The bot used to pass message.from_user.id straight into
    queries as users.user_id, which worked only while the bot was also what created accounts.
    Accounts are now created in the web app with a DB-assigned id, so for an app-origin user
    the two numbers differ and the old code matched nothing at all — silently.
    """
    return await db_manager.get_user_id_by_chat_id(tg_id)


# Redemption attempts per chat, for the /link throttle below. In-memory and per-process,
# which is enough: the bot is a single long-polling process, and the code space (32^8) plus
# the 10-minute expiry already make guessing impractical. This closes the remaining gap that
# bot messages bypass the backend's authLimiter entirely.
_LINK_ATTEMPTS: dict[int, list[float]] = {}
_LINK_MAX_ATTEMPTS = 5
_LINK_WINDOW_SECONDS = 600


def _link_throttle_ok(tg_id: int) -> bool:
    now = time.monotonic()
    recent = [t for t in _LINK_ATTEMPTS.get(tg_id, []) if now - t < _LINK_WINDOW_SECONDS]
    if len(recent) >= _LINK_MAX_ATTEMPTS:
        _LINK_ATTEMPTS[tg_id] = recent
        return False
    recent.append(now)
    _LINK_ATTEMPTS[tg_id] = recent
    return True


def _clear_link_throttle(tg_id: int) -> None:
    """A successful link resets the budget — the attempts were legitimate."""
    _LINK_ATTEMPTS.pop(tg_id, None)


async def _reject_unlinked(callback, state) -> None:
    """Ends a confirmation flow whose chat has no account behind it.

    Reachable when a chat is unlinked (or re-linked elsewhere) between opening a confirmation
    and pressing its button — the FSM state outlives the link.
    """
    await state.clear()
    await callback.message.edit_text(NOT_LINKED, parse_mode="Markdown", reply_markup=None)
    await callback.answer()



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
        # The budget bar on the dashboard is scoped to the user's financial cycle, so this
        # warning has to be too — otherwise the bot and the app quote different percentages
        # for the same budget.
        settings = await db_manager.get_cycle_settings(user_id)
        cycle = cycle_svc.resolve_cycle(cycle_svc.current_cycle_key(settings), settings)
        spent = await db_manager.get_category_spending(user_id, category_name, cycle)
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
        user_id = await _resolve_user(message.from_user.id, db_manager)
        if user_id is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
            return

        categories = await db_manager.get_user_categories(user_id)

        try:
            parsed_list = await parse_input(message.text, categories)
        except AIEngineError as e:
            logging.error("AI parse failed (%s): %s", e.category, e.detail, exc_info=e.original)
            await message.reply(e.telegram_message())
            return
        except Exception as e:
            logging.error(f"AI parse error: {e}", exc_info=True)
            await message.reply(
                "❌ Unexpected error parsing your message\n"
                "━━━━━━━━━━━━━━\n"
                f"• {type(e).__name__}: {e}\n"
                "━━━━━━━━━━━━━━\n"
                "Try a simpler phrasing like: 55 NIS for Shawarma"
            )
            return

        if not parsed_list:
            await message.reply("Sorry, I couldn't find any financial intents in that.")
            return

        _FINANCE_KEYWORDS = ["בזבוז", "הוצאתי", "כמה הלך", "תקציב", "בזבזתי", "מצב", "הוצאות"]
        if (
            len(parsed_list) == 1
            and parsed_list[0].get("intent") == "ERROR_UNSUPPORTED"
            and any(kw in message.text.lower() for kw in _FINANCE_KEYWORDS)
        ):
            parsed_list[0] = {
                "intent": "financial_advice",
                "question": message.text,
                "timeframe": "current_month",
                "category": None,
            }

        if len(parsed_list) > 1:
            expenses = [p for p in parsed_list if p.get("intent", "log_expense") == "log_expense"]
            if len(expenses) > 1:
                # Calculate warnings for each
                for exp in expenses:
                    warning = await _check_budget_warning(
                        db_manager, user_id,
                        exp.get("category"), float(exp.get("amount") or 0)
                    )
                    exp["budget_warning"] = warning
                
                await state.set_state(ExpenseFlow.pending_multi_confirmation)
                await state.update_data(parsed_list=expenses)
                
                lines = ["📋 *Multiple Expenses Summary*", "━━━━━━━━━━━━━━"]
                for i, exp in enumerate(expenses, 1):
                    item = exp.get("item") or exp.get("description") or "Unknown item"
                    amount = exp.get("amount", "?")
                    curr = exp.get("currency", "ILS")
                    cat = exp.get("category", "Uncategorized")
                    lines.append(f"{i}. `{amount} {curr}` - {item} ({cat})")
                    if exp.get("budget_warning"):
                        lines.append(f"   {exp['budget_warning']}")
                lines.append("━━━━━━━━━━━━━━\nLog all these expenses?")
                
                await message.reply(
                    "\n".join(lines),
                    parse_mode="Markdown",
                    reply_markup=_simple_confirm_keyboard("confirm_multi_expenses", "cancel_multi_expenses"),
                )
                return
            parsed = parsed_list[0]
        else:
            parsed = parsed_list[0]

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

        if intent == "financial_advice":
            question = parsed.get("question") or message.text
            timeframe = parsed.get("timeframe") or "current_month"
            category = parsed.get("category")

            thinking_msg = await message.reply("🤔 מנתח את הנתונים שלך...")
            try:
                context = await db_manager.get_dynamic_financial_context(
                    user_id, timeframe, category
                )
                import json as _json
                print("[financial_advice] payload sent to Gemini:")
                print(_json.dumps({"question": question, "category": category, "context": context}, ensure_ascii=False, indent=2))
                advice = await generate_financial_advice(question, context)
                await thinking_msg.edit_text(advice)
            except AIEngineError as e:
                logging.error("Financial advice failed (%s): %s", e.category, e.detail,
                              exc_info=e.original)
                await thinking_msg.edit_text(e.telegram_message())
            except Exception as e:
                logging.error(f"Financial advice error: {e}", exc_info=True)
                await thinking_msg.edit_text(
                    "❌ Unexpected error generating advice\n"
                    "━━━━━━━━━━━━━━\n"
                    f"• {type(e).__name__}: {e}\n"
                    "━━━━━━━━━━━━━━\n"
                    "See bot logs for the traceback."
                )
            return

        # Default: log_expense
        warning = await _check_budget_warning(
            db_manager, user_id,
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
        # handle_text resolves the user itself; this only needs the argument check.
        text = message.text.replace("/input", "").strip()
        if not text:
            await message.reply("Please add the expense after the command, e.g. `/input 55 NIS shawarma`")
            return
        message.text = text
        await handle_text(message, state)

    @dp.callback_query(F.data == "confirm_expense", ExpenseFlow.pending_confirmation)
    async def callback_confirm(callback: types.CallbackQuery, state: FSMContext):
        # Resolved, not taken from callback.from_user.id. This used to write an expense with
        # no check at all, keyed by the raw Telegram id — FSM state was the only gate.
        user_id = await _resolve_user(callback.from_user.id, db_manager)
        if user_id is None:
            await _reject_unlinked(callback, state)
            return

        data = await state.get_data()
        parsed = data.get("parsed", {})

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

    # --- ✅ Confirm multi expenses ---
    @dp.callback_query(F.data == "confirm_multi_expenses", ExpenseFlow.pending_multi_confirmation)
    async def callback_confirm_multi(callback: types.CallbackQuery, state: FSMContext):
        user_id = await _resolve_user(callback.from_user.id, db_manager)
        if user_id is None:
            await _reject_unlinked(callback, state)
            return

        data = await state.get_data()
        parsed_list = data.get("parsed_list", [])

        success_count = 0
        for parsed in parsed_list:
            success = await db_manager.add_expense(
                user_id=user_id,
                amount=parsed.get("amount"),
                description=parsed.get("item") or parsed.get("description"),
                category_name=parsed.get("category"),
                currency=parsed.get("currency", "ILS"),
                source=parsed.get("source", "bot"),
            )
            if success:
                success_count += 1

        await state.clear()
        if success_count > 0:
            await callback.message.edit_text(f"✅ {success_count} expenses saved!", reply_markup=None)
        else:
            await callback.message.edit_text("❌ Failed to save. Try again.", reply_markup=None)
        await callback.answer()

    @dp.callback_query(F.data == "cancel_multi_expenses", ExpenseFlow.pending_multi_confirmation)
    async def callback_cancel_multi(callback: types.CallbackQuery, state: FSMContext):
        await state.clear()
        await callback.message.edit_text("🗑️ Expenses cancelled.", reply_markup=None)
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
        user_id = await _resolve_user(message.from_user.id, db_manager)
        if user_id is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
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
            db_manager, user_id, parsed.get("category"), new_amount
        )
        await state.update_data(parsed=parsed)
        await state.set_state(ExpenseFlow.editing_description)
        await message.reply("Now enter the description (or send `-` to keep the current one):")

    @dp.message(ExpenseFlow.editing_description)
    async def handle_edit_description(message: types.Message, state: FSMContext):
        if await _resolve_user(message.from_user.id, db_manager) is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
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
        user_id = await _resolve_user(callback.from_user.id, db_manager)
        if user_id is None:
            await _reject_unlinked(callback, state)
            return
        categories = await db_manager.get_user_categories(user_id)

        buttons = [InlineKeyboardButton(text=cat, callback_data=f"cat:{cat}") for cat in categories]
        rows = [buttons[i:i+2] for i in range(0, len(buttons), 2)]
        keyboard = InlineKeyboardMarkup(inline_keyboard=rows)

        await state.set_state(ExpenseFlow.selecting_category)
        await callback.message.reply("Choose a category:", reply_markup=keyboard)
        await callback.answer()

    @dp.callback_query(F.data.startswith("cat:"), ExpenseFlow.selecting_category)
    async def callback_select_category(callback: types.CallbackQuery, state: FSMContext):
        user_id = await _resolve_user(callback.from_user.id, db_manager)
        if user_id is None:
            await _reject_unlinked(callback, state)
            return

        selected = callback.data.removeprefix("cat:")
        data = await state.get_data()
        parsed = data["parsed"]
        parsed["category"] = selected
        # Re-check budget warning with new category
        parsed["budget_warning"] = await _check_budget_warning(
            db_manager, user_id, selected, float(parsed.get("amount") or 0)
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
        user_id = await _resolve_user(callback.from_user.id, db_manager)
        if user_id is None:
            await _reject_unlinked(callback, state)
            return

        data = await state.get_data()
        parsed = data.get("parsed", {})
        # `income.month` is the calendar month a salary is FOR, not the cycle it funds —
        # the same convention the web form uses. The mapping from one to the other is the
        # user's salary_day, and app.services.cycle.income_month_of owns it.
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
        user_id = await _resolve_user(callback.from_user.id, db_manager)
        if user_id is None:
            await _reject_unlinked(callback, state)
            return

        data = await state.get_data()
        parsed = data.get("parsed", {})

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
        user_id = await _resolve_user(message.from_user.id, db_manager)
        if user_id is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
            return
        name = message.text.replace("/add_category", "").strip()
        if not name:
            await message.reply("Usage: `/add_category Health`")
            return

        success = await db_manager.add_user_category(user_id, name.capitalize())
        if success:
            await message.reply(f"✅ Category *{name.capitalize()}* added.", parse_mode="Markdown")
        else:
            await message.reply("Failed to add category (it may already exist).")

    # --- /add_savings goal_name target_amount monthly_allocation ---
    @dp.message(Command("add_savings"))
    async def handle_add_savings(message: types.Message):
        user_id = await _resolve_user(message.from_user.id, db_manager)
        if user_id is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
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

        goal_id = await db_manager.add_savings_goal(
            user_id, name, target, monthly
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
        user_id = await _resolve_user(message.from_user.id, db_manager)
        if user_id is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
            return
        goals = await db_manager.list_savings_goals(user_id)
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
        user_id = await _resolve_user(message.from_user.id, db_manager)
        if user_id is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
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

        ok = await db_manager.deposit_to_savings_goal(user_id, goal_id, amount)
        await message.reply(
            f"✅ ₪{amount:.2f} deposited to goal #{goal_id}!" if ok else "❌ Goal not found."
        )

    # --- /add_subscription ---
    @dp.message(Command("add_subscription"))
    async def handle_add_subscription(message: types.Message):
        user_id = await _resolve_user(message.from_user.id, db_manager)
        if user_id is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
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

        sub_id = await db_manager.add_subscription(
            user_id, name, amount, category, day
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
        user_id = await _resolve_user(message.from_user.id, db_manager)
        if user_id is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
            return
        subs = await db_manager.list_subscriptions(user_id)
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
        user_id = await _resolve_user(message.from_user.id, db_manager)
        if user_id is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
            return
        arg = message.text.replace("/del_subscription", "").strip()
        if not arg.isdigit():
            await message.reply("Usage: `/del_subscription <id>`", parse_mode="Markdown")
            return
        ok = await db_manager.delete_subscription(user_id, int(arg))
        await message.reply("✅ Deleted." if ok else "❌ Not found.")

    # --- /set_budget ---
    @dp.message(Command("set_budget"))
    async def handle_set_budget(message: types.Message):
        user_id = await _resolve_user(message.from_user.id, db_manager)
        if user_id is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
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

        ok = await db_manager.set_budget(user_id, category, limit, carry_over=True)
        if ok:
            await message.reply(
                f"✅ Budget set: *{category}* — ₪{limit:.2f}/month (carry-over enabled).",
                parse_mode="Markdown",
            )
        else:
            await message.reply("❌ Failed to set budget.")

    @dp.message(Command("list_budgets"))
    async def handle_list_budgets(message: types.Message):
        user_id = await _resolve_user(message.from_user.id, db_manager)
        if user_id is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
            return
        budgets = await db_manager.list_budgets(user_id)
        if not budgets:
            await message.reply("No budgets yet. Set one with /set\\_budget", parse_mode="Markdown")
            return
        lines = ["💰 *Budgets*", "━━━━━━━━━━━━━━"]
        for b in budgets:
            roll = "🔄" if b["carry_over"] else "  "
            lines.append(f"{roll} *{b['category']}* — ₪{float(b['monthly_limit']):.2f}/mo")
        await message.reply("\n".join(lines), parse_mode="Markdown")

    # --- /link <code> ---
    #
    # Replaces /link_google <email>, which took the sender's word for the address. Because
    # the re-link guard only fired once telegram_chat_id was set, any Telegram user who knew
    # an email could bind their chat to that account — and every Google-only account had a
    # NULL chat id. An attacker could also claim an unregistered address so its real owner's
    # later Google sign-in landed in the attacker's account.
    #
    # A code proves the sender has an authenticated web session for the account. It is
    # single-use, expires in 10 minutes, and is stored only as a SHA-256.
    @dp.message(Command("link"))
    async def handle_link(message: types.Message):
        code = message.text.replace("/link", "", 1).strip()
        if not code:
            await message.reply(
                "Usage: `/link <code>`\n\n"
                "Get your code from SmartFin → *Settings → Telegram bot*.",
                parse_mode="Markdown",
            )
            return

        # Bot messages never pass through the backend's authLimiter, so redemption is paced
        # here instead. Without it the 10-minute window is open to unlimited guessing.
        if not _link_throttle_ok(message.from_user.id):
            await message.reply("⏳ Too many attempts. Wait a few minutes and try again.")
            return

        result = await db_manager.redeem_link_code(code, message.from_user.id)
        if result == "ok":
            _clear_link_throttle(message.from_user.id)
            await message.reply(
                "✅ Linked! Send me an expense any time — try `55 NIS shawarma`.",
                parse_mode="Markdown",
            )
        elif result == "chat_taken":
            await message.reply("❌ This Telegram account is already linked to a different SmartFin account.")
        else:
            # Unknown, expired and already-used are one message on purpose — distinguishing
            # them would help someone guessing at the code space.
            await message.reply(
                "❌ That code is invalid, expired or already used.\n"
                "Generate a new one in SmartFin → *Settings → Telegram bot*.",
                parse_mode="Markdown",
            )

    # --- /clean_dupes ---
    # Cleanup itself lives in the web app (Settings → Duplicate cleanup). Two reasons it
    # is not run from here:
    #   1. Chat is the wrong surface for approving a hundred irreversible deletions. The
    #      web screen shows each hand-logged row beside the imported transaction that
    #      covers it, with a checkbox, so the user approves pairs rather than a number.
    #   2. Restoring what it removes is a 30-day archive browse, which is a screen, not a
    #      chat transcript.
    # The command is kept because it is documented and users will still type it.
    @dp.message(Command("clean_dupes", "clean_applepay"))
    async def handle_clean_dupes(message: types.Message):
        await message.reply(
            "🧾 *Duplicate cleanup has moved to the web app.*\n\n"
            "Open *Settings → Duplicate cleanup*. You'll see every expense you logged by "
            "hand next to the bank or card transaction that now covers it, and you choose "
            "what goes.\n\n"
            "Anything with no match — cash, Bit, PayBox — is kept automatically, and "
            "whatever you do remove can be restored for 30 days.",
            parse_mode="Markdown",
        )
    # --- /start ---
    @dp.message(Command("start"))
    async def handle_start(message: types.Message):
        if await _resolve_user(message.from_user.id, db_manager) is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
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
            "*Automatic logging*\n"
            "Connect your bank and credit cards in Settings on the web app —\n"
            "transactions import automatically every night.\n"
            "/clean\\_dupes — remove expenses your bank/card sync now imports itself\n\n"
            "*Account*\n"
            "/link `<code>` — connect this chat to your SmartFin account",
            parse_mode="Markdown",
        )

    # --- /help ---
    @dp.message(Command("help"))
    async def handle_help(message: types.Message):
        if await _resolve_user(message.from_user.id, db_manager) is None:
            await message.reply(NOT_LINKED, parse_mode="Markdown")
            return

        await message.reply(
            "🤖 *SmartFin Bot — Commands*\n\n"
            "/start — show the welcome message and quick usage guide.\n"
            "/help — show this list of commands.\n"
            "/input `<text>` — log an expense from text without free-form parsing ambiguity.\n"
            "/add\\_category `<name>` — create a new expense category.\n"
            "/add\\_subscription `<name> <amount> <category> <day>` — add a recurring monthly charge.\n"
            "/list\\_subscriptions — list all your active subscriptions.\n"
            "/del\\_subscription `<id>` — remove a subscription by its id.\n"
            "/set\\_budget `<category> <limit>` — set a monthly spending limit for a category.\n"
            "/list\\_budgets — show all your category budgets and usage.\n"
            "/add\\_savings `<name> <target> [monthly_allocation]` — create a savings goal.\n"
            "/list\\_savings — list all your savings goals and progress.\n"
            "/deposit\\_savings `<goal_id> <amount>` — add money toward a savings goal.\n"
            "/clean\\_dupes — remove hand-logged expenses that your bank/card sync now imports itself.\n"
            "/link `<code>` — connect this chat to your SmartFin account (get the code in Settings → Telegram bot).\n\n"
            "_You can also just type naturally, e.g. \"55 nis shawarma\" or \"got salary 15000\"._",
            parse_mode="Markdown",
        )
