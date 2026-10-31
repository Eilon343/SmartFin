# Weekly Score and Math Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the weekly score a fair, understandable closed-week comparison, and fix the verified math bugs in `forecastMath.js` and Insights.

**Architecture:** Formulas stay pure in `forecastMath.js`. The weekly job moves from the bot to a new backend service, so it shares one baseline with Insights. The job is scheduled in `Asia/Jerusalem` with `Intl`, and a per-user marker prevents double sends.

**Tech Stack:** Node 20, Express 5, mysql2, Jest with `dbMock`, MySQL 8, Python bot (removal only).

**Spec:** `docs/MATH_FIXES_REVIEW.md`, plus `docs/WEEKLY_SPENDING_SCORE.md` for background.

## Global Constraints

- Do not set `TZ` on any container. Local time comes from `Intl` with `Asia/Jerusalem`.
- Never add a query to `middleware/auth.js`.
- Keep the query count and order in `getInsights`: tests use positional mocks. Extra columns are fine.
- Every query over `expenses` filters `is_virtual = FALSE`.
- Rounding happens once at the response boundary (`fx.money`), never mid-formula.
- New migrations are idempotent and also change `db/init.sql`.
- Bot-facing copy is English. Hebrew and English both need updating in `I18nContext.jsx`.
- `three_mo_avg` keeps its API name.
- Do not touch `getPnL` averages, `forecastRange`, or currency handling.

## Review Focus

- A user-defined category name containing `_`, `*`, `` ` `` or `[` must not break Telegram Markdown. Pinned in Task 5.
- A chat that blocked the bot must not be retried all Sunday. Pinned in Task 6.
- A backend restart on Sunday must not send a second message. Pinned in Task 6.
- Bank rows stored as date-only values must land in the right week across the Saturday/Sunday boundary and in DST weeks. Pinned in Task 6.
- A week with refunds exceeding spending must read as a refund week, not "-110%". Pinned in Task 5.

---

### Task 1: Correct stale docs and pin subscription behaviour

**Files:**
- Modify: `docs/CALCULATIONS.md:171-175`, `backend/src/controllers/expenseController.js:338`
- Test: `tests/backend/cycle.test.js`

- [ ] **Step 1: Add the pin test** to the `chargeDateInCycle` describe. This passes immediately, because the code is already correct.

```js
it('anchor 10 on Oct 25: the 5th is still ahead, the 15th has passed', () => {
    const c = cy.resolveCycle('2026-10', { cycle_anchor_day: 10, salary_day: 1 });
    expect(cy.chargeDateInCycle(c, 5)).toBe('2026-11-05');
    expect(cy.chargeDateInCycle(c, 15)).toBe('2026-10-15');
    expect(cy.chargeDateInCycle(c, 5) > '2026-10-25').toBe(true);
    expect(cy.chargeDateInCycle(c, 15) > '2026-10-25').toBe(false);
});
```

- [ ] **Step 2: Fix the docs.** In `CALCULATIONS.md`, replace `day_of_month > DAY(CURDATE())` with: "current cycle → those whose `chargeDateInCycle` date is after today". In the `expenseController.js` comment, change `w = d / (d + 7)` to `w = d_eff / (d_eff + 10)`.

- [ ] **Step 3: Run** `cd tests && npx jest backend/cycle.test.js`. Expected: PASS.

- [ ] **Step 4: Commit** with message `docs(math): correct stale subscription and credibility notes`.

### Task 2: Credibility weight on effective days

**Files:**
- Modify: `backend/src/services/forecastMath.js:428` and its comments at lines 44-57 and 382-407
- Modify: `docs/CALCULATIONS.md` (§0.1 `w`, §1 expense projection, the leverage bullet)
- Test: `tests/math/pnl_math.test.js`

**Interfaces:**
- Produces: `projectVariableExpenses` keeps its signature. `credibilityWeight` is unchanged.

- [ ] **Step 1: Write the failing test.**

```js
describe('projectVariableExpenses - skewed day-of-week weights', () => {
    const quietSaturday = fx.dowWeights([1000, 1000, 1000, 1000, 1000, 2000, 0], new Array(7).fill(26));
    const base = { days: 30, historicalMean: 6000, monthsWithData: 6, startDate: '2026-08-01' };

    it('a purchase on a quiet first day cannot run away with the forecast', () => {
        const p = fx.projectVariableExpenses({ ...base, spentToDate: 300, dayIndex: 1, weights: quietSaturday });
        expect(Math.round(p)).toBe(6945);
    });

    it('is identical to d/(d+K) under flat weights', () => {
        const flat = new Array(7).fill(1 / 7);
        const d = 4, S = 800, rem = 26 / 30, w = d / (d + fx.CREDIBILITY_K);
        const expected = S + w * S * (rem / (4 / 30)) + (1 - w) * 6000 * rem;
        const p = fx.projectVariableExpenses({ ...base, spentToDate: S, dayIndex: d, weights: flat });
        expect(p).toBeCloseTo(expected, 8);
    });
});
```

- [ ] **Step 2: Run** `cd tests && npx jest math/pnl_math.test.js`. Expected: the first test FAILS with 8550.

- [ ] **Step 3: Implement.** Replace line 428 with `const w = credibilityWeight(elapsed * days, monthsWithData);`. Update the comments and docs: the leverage is `S_d × ρD / ((1−ρ)D + K)`, for any weights.

- [ ] **Step 4: Run the same command.** Expected: all PASS, including the existing tuned-K cases.

- [ ] **Step 5: Commit** with message `fix(forecast): measure credibility in effective days so skewed weeks stay bounded`.

### Task 3: One baseline for Insights

Covers review items 3.3, 3.4 and 2.3.1.

**Files:**
- Modify: `backend/src/services/forecastMath.js`, `backend/src/controllers/insightsController.js:37-44,80-91,164-207`
- Modify: `frontend/src/context/I18nContext.jsx:457,1016`
- Modify: `docs/CALCULATIONS.md` (§3 and the §5 denominator rule)
- Test: `tests/math/pnl_math.test.js`, `tests/backend/insights.test.js`

**Interfaces:**
- Produces: `fx.categoryHabits(rows, { anchorMonth, cycleEndOf }) → { byCategory: Map<category_id|null, number>, months: string[] }`. `rows` is `[{ category_id, mo, total, first_at? }]`. `cycleEndOf(mo)` returns the cycle's exclusive end as `YYYY-MM-DD`.
- Produces: `fx.MIN_CYCLE_HISTORY_DAYS = 14`.
- Produces: `fx.pacingTarget` returns a new field `budgeted_variable_categories`.

- [ ] **Step 1: Write the failing math tests.**

```js
describe('categoryHabits', () => {
    const cycleEndOf = (mo) => ({ '2026-07': '2026-08-01', '2026-08': '2026-09-01', '2026-09': '2026-10-01' }[mo]);
    const rows = [
        { category_id: 1, mo: '2026-07', total: 2000 }, { category_id: 1, mo: '2026-08', total: 2000 },
        { category_id: 1, mo: '2026-09', total: 2000 }, { category_id: 2, mo: '2026-07', total: 900 },
    ];

    it('counts a silent cycle as zero for a sparse category', () => {
        const { byCategory, months } = fx.categoryHabits(rows, { anchorMonth: '2026-10', cycleEndOf });
        expect(months).toHaveLength(3);
        expect(byCategory.get(2)).toBeCloseTo(203.89, 2);
    });

    it('category habits sum to the decayed mean of the totals', () => {
        const { byCategory } = fx.categoryHabits(rows, { anchorMonth: '2026-10', cycleEndOf });
        const sum = [...byCategory.values()].reduce((a, b) => a + b, 0);
        const totals = [{ month: '2026-07', total: 2900 }, { month: '2026-08', total: 2000 }, { month: '2026-09', total: 2000 }];
        expect(sum).toBeCloseTo(fx.decayedMean(totals, '2026-10'), 8);
    });

    it('drops a first cycle with under 14 days of history', () => {
        const short = [
            { category_id: 1, mo: '2026-08', total: 500, first_at: '2026-08-27' },
            { category_id: 1, mo: '2026-09', total: 6000, first_at: '2026-09-01' },
        ];
        const { months, byCategory } = fx.categoryHabits(short, { anchorMonth: '2026-10', cycleEndOf });
        expect(months).toEqual(['2026-09']);
        expect(byCategory.get(1)).toBe(6000);
    });

    it('returns no months when the only cycle is too short', () => {
        const only = [{ category_id: 1, mo: '2026-09', total: 500, first_at: '2026-09-27' }];
        expect(fx.categoryHabits(only, { anchorMonth: '2026-10', cycleEndOf }).months).toEqual([]);
    });
});
```

Add to the existing `pacingTarget` describe: with `[{ is_fixed: true, three_mo_avg: 0, budget_limit: 4000 }, { is_fixed: false, three_mo_avg: 0, budget_limit: 1000 }]`, `budgeted_variable_categories` is 1.

- [ ] **Step 2: Run** `cd tests && npx jest math/pnl_math.test.js`. Expected: FAIL, `categoryHabits` is not a function.

- [ ] **Step 3: Implement `categoryHabits`.** Active months are the distinct `mo` values. Take the earliest `first_at` across all rows; a row without `first_at` makes no claim. Keep a month when `cycleEndOf(mo)` minus that earliest date is at least `MIN_CYCLE_HISTORY_DAYS` days. For each category, zero-fill the kept months and call `decayedMean`. Add `budgeted_variable_categories` to `pacingTarget`.

- [ ] **Step 4: Update `getInsights`.** Remove the 3-month `lookback` array. Use `dowWindowStart` for the bucket query and add `MIN(created_at) AS first_at` to it. Replace `avgAccum` with `fx.categoryHabits`, passing `cycleEndOf: k => cy.resolveCycle(k, settings).end`. Fill `three_mo_avg` through `fx.money`, for the Uncategorized row too. Add a comment that the field now holds the typical cycle.

- [ ] **Step 5: Update `tests/backend/insights.test.js`.** Change the Uncategorized expectation at line 140 from 400 to `417.16`, because the mean is now decayed. Leave line 158 at 900. Add a test with two categories, where category 1 spends 900 only in `2025-01` and category 2 spends in both `2025-01` and `2025-02`: expect category 1's `three_mo_avg` to be `372.79`.

- [ ] **Step 6: Update labels and docs.** `ins_trend_sub` becomes "vs. your typical month" and "לעומת חודש טיפוסי". In `CALCULATIONS.md` §5, the rule becomes: a user's denominator is the cycles *they* were active; a category inside that user uses the same denominator.

- [ ] **Step 7: Run** `cd tests && npm test`. Expected: all PASS.

- [ ] **Step 8: Commit** with message `fix(insights): average categories over the user's active cycles on the 6-cycle decay`.

### Task 4: Cap budget carry-over

**Files:**
- Modify: `backend/src/services/forecastMath.js`, `backend/src/controllers/expenseController.js:137-138`
- Modify: `docs/CALCULATIONS.md` (carry-over block)
- Test: `tests/math/pnl_math.test.js`, `tests/backend/budgets.test.js`

**Interfaces:**
- Produces: `fx.carryForward(limit, carry, spent) → number`, clamped to `[0, limit]`.

- [ ] **Step 1: Write the failing tests.**

```js
describe('carryForward', () => {
    it('keeps an ordinary underspend', () => expect(fx.carryForward(1000, 0, 400)).toBe(600));
    it('caps at one monthly limit', () => expect(fx.carryForward(1000, 600, 100)).toBe(1000));
    it('never rolls a deficit forward', () => expect(fx.carryForward(1000, 0, 1500)).toBe(0));
});
```

In `budgets.test.js`, add a case with `carry_over: 1` and a `start_month` 3 cycles back with no spending. Expect `carried_in` to be 1500 and `effective_limit` to be 3000 for the existing ₪1,500 limit.

- [ ] **Step 2: Run** `cd tests && npx jest math/pnl_math.test.js backend/budgets.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement** `carryForward`, and use it inside the `getBudgets` loop.

- [ ] **Step 4: Run the same command.** Expected: PASS.

- [ ] **Step 5: Commit** with message `fix(budgets): cap carry-over at one monthly limit`.

### Task 5: Pure weekly score and message

**Files:**
- Modify: `backend/src/services/forecastMath.js`
- Create: `backend/src/services/weeklyScoreMessage.js`
- Create: `tests/math/weekly_score.test.js`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `fx.weeklyScore({ weekTotal, monthlyTarget, cycleDays }) → { state, expected, ratio, delta, pct } | null`. It returns null when `monthlyTarget` is not above 0. `state` is one of `'well_under' | 'under' | 'on_pace' | 'over' | 'well_over' | 'refund'`.
- Produces: `formatWeeklyMessage({ score, weekStart, weekEnd, basis, topCategories, pendingTotal }) → string`, where `basis` is `'usual' | 'target'`, and `formatNoHistoryMessage() → string`.

- [ ] **Step 1: Write the failing tests.** Core cases:

```js
const score = (weekTotal, monthlyTarget = 9000, cycleDays = 30) =>
    fx.weeklyScore({ weekTotal, monthlyTarget, cycleDays });

it('expects seven days at the daily rate', () => expect(score(2100).expected).toBeCloseTo(2100, 8));
it('uses the real cycle length', () => expect(score(0, 9000, 28).expected).toBeCloseTo(2250, 8));
it('grades on the rounded ratio', () => {
    expect(score(1680).state).toBe('well_under');   // 0.80
    expect(score(1701).state).toBe('under');        // 0.81
    expect(score(2100).state).toBe('on_pace');      // 1.00
    expect(score(2121).state).toBe('over');         // 1.01
    expect(score(2541).state).toBe('well_over');    // 1.21
});
it('calls a net-negative week a refund', () => expect(score(-50).state).toBe('refund'));
it('has no score without a baseline', () => expect(score(500, 0)).toBeNull());
```

Message tests must assert:
- The header shows `25–31 Oct`.
- `basis: 'target'` prints "Your weekly target", and `'usual'` prints "Your usual week".
- `on_pace` prints "Right on your usual pace" and never prints `0%`.
- `refund` prints "Net refund week".
- Fixed costs are named as excluded.
- The pending line appears only when `pendingTotal > 0`.
- A category named `Food_out*` comes out as `Food\_out\*`.

- [ ] **Step 2: Run** `cd tests && npx jest math/weekly_score.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement.** `expected = monthlyTarget / cycleDays × 7`. `ratio = round(weekTotal / expected, 2)`, `pct = (ratio − 1) × 100`, `delta = weekTotal − expected`. Bands are ≤0.80, <1.00, =1.00, ≤1.20 and above. Negative `weekTotal` gives `refund`. Exact copy, with Telegram Markdown:

```
📊 *Your week: 25–31 Oct*
━━━━━━━━━━━━━━
Everyday spending: `₪1,840`
Your usual week: `₪2,200`
🔵 *Under your usual* — ₪360 less (16%)
Biggest: Food ₪900 · Transport ₪420 · Shopping ₪310
_Rent and other fixed costs aren't counted here._
⏳ About ₪120 in card charges is still pending.
```

State lines: 🟢 `Well under your usual`, 🔵 `Under your usual`, 🔵 `Right on your usual pace`, 🟡 `Above your usual`, 🔴 `Well above your usual`, 💸 `Net refund week — ₪X came back`. With `basis: 'target'`, replace "your usual" with "your target". No-history copy: `📊 *Your week*\nNot enough history yet. Your weekly summary starts after about two weeks of spending.`

- [ ] **Step 4: Run the same command.** Expected: PASS.

- [ ] **Step 5: Commit** with message `feat(weekly): pure score and clearer message`.

### Task 6: Backend weekly job

**Files:**
- Create: `db/migrate_014_weekly_score.sql`
- Modify: `db/init.sql`
- Create: `backend/src/utils/zonedTime.js`
- Modify: `backend/src/services/bankSyncScheduler.js` (use the moved helpers)
- Create: `backend/src/services/weeklyScore.js`
- Modify: `backend/src/index.js`
- Create: `tests/backend/weeklyScore.test.js`

**Interfaces:**
- Consumes: `fx.categoryHabits`, `fx.pacingTarget`, `fx.weeklyScore`, `formatWeeklyMessage`, `notifyUser`.
- Produces: `zonedParts(instant, timeZone)` and `instantAtLocalHour(dateParts, hour, timeZone)`, moved unchanged. `zonedTime.js` also exports `addLocalDays(dateParts, n)`.
- Produces: `weekWindow(now) → { start: Date, end: Date, weekKey: 'YYYY-MM-DD', lastDayISO: 'YYYY-MM-DD' } | null`. It returns null unless the Israel clock is Sunday at or after 08:30.
- Produces: `buildUserScore(user, window) → string` (the message), `runWeeklyScores(now = new Date())`, and `start()`.

- [ ] **Step 1: Write the migration.** Add `users.weekly_score_sent_for DATE NULL`, idempotent through `INFORMATION_SCHEMA`, and mirror it in `init.sql`.

- [ ] **Step 2: Write the failing tests.**
- `weekWindow`: Sunday 2026-11-01 08:29 Israel returns null, and 08:30 returns a window. Start is Sat 2026-10-24 21:00Z and end is Sat 2026-10-31 22:00Z, because this week crosses the DST change. Monday returns null.
- `weekWindow`: a mid-summer week spans exactly 168 hours.
- Date-only bank rows: `2026-10-25T00:00:00Z` is inside the window, and `2026-11-01T00:00:00Z` is outside it.
- `runWeeklyScores`: sends once and stores `weekly_score_sent_for`. A user whose marker already equals `weekKey` is skipped, so a second run sends nothing.
- `runWeeklyScores`: when `notifyUser` returns false, the marker is not written, and it is written after the third failure with an error log.
- `buildUserScore`: the week query has `is_virtual = FALSE`, `COALESCE(c.is_fixed, FALSE) = FALSE`, and `created_at >= ? AND created_at < ?`.
- `buildUserScore`: an account with no complete cycle and no variable budget gets the no-history copy.
- One user failing does not stop the next user.

- [ ] **Step 3: Run** `cd tests && npx jest backend/weeklyScore.test.js`. Expected: FAIL.

- [ ] **Step 4: Move `zonedParts`, `zoneOffsetMs` and `instantAtLocalHour`** to `utils/zonedTime.js`, and run `cd tests && npx jest backend/bankSync.test.js`. Expected: PASS.

- [ ] **Step 5: Implement `weeklyScore.js`.**
- `cycle` is the cycle containing `lastDayISO`. `lookback` is `fx.pastMonths(cycle.key)`.
- The queries are categories, per-category buckets with `first_at` (same SQL shape as Task 3), budgets, the week's variable spend per category, and pending.
- `monthlyTarget` is `pacingTarget(...).variable`, using habits from `categoryHabits`.
- `basis` is `'target'` when `budgeted_variable_categories > 0`, else `'usual'`.
- `topCategories` is the top 3 by spend, omitting amounts at or below 0.
- `pendingTotal`: `SELECT COALESCE(SUM(-charged_amount),0) FROM bank_transactions_raw WHERE user_id=? AND status='pending' AND import_status='pending_categorization' AND charged_amount<0 AND currency='ILS' AND txn_date>=? AND txn_date<?`, with local week dates. A pending row that later settled under a new hash may be counted, which is why the copy says "About".
- Users are selected with `telegram_chat_id IS NOT NULL AND (weekly_score_sent_for IS NULL OR weekly_score_sent_for < ?)`.
- `start()` ticks every 15 minutes with `.unref()` and an in-flight guard. It tracks failed attempts in memory and gives up after `MAX_SEND_ATTEMPTS = 3`. Call it from the `listen` callback in `index.js`.

- [ ] **Step 6: Run** `cd tests && npm test`. Expected: all PASS.

- [ ] **Step 7: Commit** with message `feat(weekly): send the closed-week score from the backend on Sunday morning`.

### Task 7: Remove the bot's copy and finish the docs

**Files:**
- Modify: `bot/app/scheduler.py` (remove `_week_start`, `_compute_spending_score`, `_format_score_message`, `send_spending_scores` and its job)
- Modify: `bot/app/database/DatabaseManager.py` (remove `get_notifiable_users` if nothing else calls it)
- Delete: `tests/math/test_pnl_math.py`
- Modify: `tests/bot/test_scheduler.py` (remove `TestSpendingScoreMath`)
- Modify: `docs/CALCULATIONS.md` §4 and §5, `docs/WEEKLY_SPENDING_SCORE.md`, `docs/CLAUDE.md`

- [ ] **Step 1: Remove the code and tests.** Then search for `get_notifiable_users`, `spending_score` and `_week_start` across `bot/` and `tests/`. Expected: no references remain, except any `get_notifiable_users` caller that justifies keeping it.

- [ ] **Step 2: Update the docs.** `CALCULATIONS.md` §4 describes the new formula and job. `WEEKLY_SPENDING_SCORE.md` gets a status note at the top marking its audit as historical, and listing which problems are fixed. `CLAUDE.md` replaces "Saturday 09:00 spending-score DM" with the backend job, and the commands section drops `pytest tests/math/test_pnl_math.py`.

- [ ] **Step 3: Run both suites.** `cd tests && npm test`, then `bot\venv\Scripts\python.exe -m pytest tests/bot -q`. Expected: all PASS.

- [ ] **Step 4: Commit** with message `refactor(bot): remove the weekly score now owned by the backend`.

---

## Deployment Notes

Apply `db/migrate_014_weekly_score.sql` to production **before** deploying the backend. Until it is applied, the job's user query fails and logs an error each tick, but the rest of the backend is unaffected.

The first message arrives on the first Sunday at 08:30 Israel time after deployment. Deployed before then, you will get no Saturday message that week.

## Deferred

- **Forecast band (§3.5.2):** backtest `ρ` against `√ρ` on real months before changing anything.
- **Foreign currency:** count non-ILS rows in production, then decide app-wide.
- **Short first cycle in P&L:** left alone for now.
- **Carry-over replay using the current limit:** left alone for now.
