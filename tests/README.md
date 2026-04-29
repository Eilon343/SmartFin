# SmartFin Test Suite

All tests live here — completely separate from source files.

```
tests/
├── backend/      Jest + Supertest (Node.js API tests)
├── bot/          pytest (Python bot tests)
└── math/         Pure math — both Jest and pytest
```

---

## Quick start

### Backend + Math tests (Jest)

```bash
cd tests
npm install
npm test
```

Run specific suites:
```bash
npm run test:backend     # API tests only
npm run test:math        # Math formula tests only
npm run test:coverage    # With coverage report
```

### Bot tests (pytest)

From the project root:
```bash
pip install pytest pytest-asyncio
pytest tests/bot -v
```

### Math tests (Python)

```bash
pytest tests/math/test_pnl_math.py -v
```

### Everything at once

```bash
# From project root
cd tests && npm test && cd .. && pytest tests/bot tests/math/test_pnl_math.py -v
```

---

## Test files

| File | What it tests |
|------|--------------|
| `backend/auth.test.js` | PIN login, JWT middleware, expired tokens, Google OAuth |
| `backend/expenses.test.js` | CRUD, month filtering, amount validation |
| `backend/income.test.js` | Fixed/variable income, type validation, CRUD |
| `backend/pnl.test.js` | P&L math, variable_avg fix, projected_expenses, forecast |
| `backend/subscriptions.test.js` | CRUD, day_of_month 1–28 boundary, pause/resume |
| `backend/savings.test.js` | Goals, deposits, progress, negative amount guard |
| `backend/budgets.test.js` | Upsert, categories, validation |
| `backend/webhook.test.js` | Secret auth, Gemini success/503, queue fallback |
| `bot/test_ai_engine.py` | Intent routing, retry on 503/429, JSON parsing |
| `bot/test_handlers.py` | Budget warning thresholds, FSM, day clamping |
| `bot/test_database.py` | DB layer: add_expense, add_income, category lookup |
| `bot/test_scheduler.py` | Spending score math, subscription due-date logic |
| `math/test_pnl_math.py` | Pure formula correctness (Python) |
| `math/pnl_math.test.js` | Pure formula correctness (JS), end-to-end scenarios |

---

## How mocking works

**Backend:** `jest.moduleNameMapper` intercepts all `require('../config/db')` calls
and returns `backend/setup/dbMock.js` — a jest.fn() you configure per test:

```js
db.query
  .mockResolvedValueOnce([[{ user_id: 42 }]])  // auth check
  .mockResolvedValueOnce([[{ total: '500' }]]); // business query
```

**Bot:** `unittest.mock.patch` replaces the Gemini client and DB pool:

```python
with patch("app.ai.ai_engine._get_client") as mock:
    mock.return_value.models.generate_content.return_value = mock_response
    result = await parse_input("55 coffee", CATEGORIES)
```

**Math:** No mocking — pure functions, deterministic results.

---

## Requirements

**Backend tests:**
- Node.js 18+
- Run `npm install` in `tests/`

**Bot tests:**
- Python 3.11+
- `pip install pytest pytest-asyncio`
- Bot dependencies already installed in the Docker container

**No test writes to production DB or calls real APIs.**
