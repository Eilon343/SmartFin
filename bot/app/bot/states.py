from aiogram.fsm.state import State, StatesGroup


class ExpenseFlow(StatesGroup):
    pending_confirmation = State()
    editing_amount = State()
    editing_description = State()
    selecting_category = State()


class PinFlow(StatesGroup):
    waiting_pin = State()       # user must enter PIN to unlock
    setting_pin = State()       # user is creating/changing their PIN
    confirming_pin = State()    # user re-enters PIN to confirm
