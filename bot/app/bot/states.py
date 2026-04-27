from aiogram.fsm.state import State, StatesGroup


class ExpenseFlow(StatesGroup):
    pending_confirmation = State()
    editing_amount = State()
    editing_description = State()
    selecting_category = State()


class IncomeFlow(StatesGroup):
    pending_confirmation = State()


class SubscriptionFlow(StatesGroup):
    pending_confirmation = State()


