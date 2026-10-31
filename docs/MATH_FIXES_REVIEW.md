# Review of Gemini's math findings

Reviewed 2026-10-31 against `dev` at `e8fbb3f`. Source: `math_weekly_bot_fixes_handoff.md`.
The implementation plan is in
[superpowers/plans/2026-10-31-weekly-score-and-math-fixes.md](superpowers/plans/2026-10-31-weekly-score-and-math-fixes.md).

## 1. Verdict

**Gemini's handoff is a useful direction, but it should not be executed as written.** It found
two real bugs I had not audited (§3.1 and §3.3), and most of its weekly-score fixes are right.
However, it treats one already-fixed bug as live, its timezone instruction would break a known
rule of this repo, and two of its fixes rest on weak evidence.

| Item | Claim | Verdict | What we do |
|---|---|---|---|
| Part 1 | Stop computing the score in Python | **Goal accepted, both options replaced** | Move the whole job to the backend |
| 2.1 | Exclude fixed costs | **Accept** | Fix the join: the key is `category_id`, not `c.id` |
| 2.2.1 | Run Sunday 08:30 Israel time | **Accept the time, reject the method** | No container timezone change |
| 2.2.2 | Report the closed Sun-Sat week | **Accept** | Reduces the pending problem but does not end it |
| 2.2.3 | Mid-week seasonal scaling | **Reject** | Nothing runs mid-week (YAGNI) |
| 2.3.1 | Ignore a too-short first cycle | **Accept** | Shared by the weekly score and Insights |
| 2.3.2 | Use `pacing_target.variable` or decayed mean | **Accept, simplified** | One formula, no branch |
| 2.3.3 | Better weekly conversion | **Accept** | Daily rate × 7. Gemini's constant is slightly wrong |
| 2.3.4 | Honest wording | **Accept** | Rewritten message |
| 2.4 | Pending footnote | **Accept with a caveat** | The amount can only be approximate |
| 2.4 | Currency guard | **Defer** | App-wide issue, needs a data check first |
| 3.1 | `w` and `ρ` mismatch | **Accept** | One-line fix. Real, but only in some cases |
| 3.2 | Broken subscription filter | **Reject: already fixed** | Only the stale docs need fixing |
| 3.3 | Category average inflation | **Accept** | A real bug in Insights |
| 3.4 | Unify lookback in Insights | **Accept** | Done together with 3.3 |
| 3.5 | Forecast range formula | **Reject 1, defer 2** | Backtest on real data first |
| 3.6 | Cap budget carry-over | **Accept the cap, reject the rest** | Your product decision (see §5) |

## 2. Where Gemini was wrong

**§3.2 describes code that no longer exists.** There is no `DAY(CURDATE())` filter.
`getPnL` already uses `chargeDateInCycle`, which does exactly what Gemini proposes
(`expenseController.js:485-487`, `cycle.js:203`). Gemini was misled by a stale line in
`docs/CALCULATIONS.md:174`. The real fix is to correct that doc. Gemini's test case is still
worth adding as a pin, because it is cheap.

**§2.2 "ensure the container uses Asia/Jerusalem" would break a known rule.** The containers
are deliberately left on UTC, because the time comparisons in `bankSyncScheduler.js` depend on
Node and MySQL agreeing. Changing one container's `TZ` silently skews scheduled queries. Moving
the job to the backend avoids this: it can use the same `Intl` approach the bank sync already
uses for its DST-aware 07:00 and 19:00 slots.

**§3.5.1 weighted variance gives little benefit.** Gemini says a permanent step-up makes the
unweighted spread "artificially huge". I tested it on a 3,000 → 5,000 step:

| History | Unweighted σ | Weighted around decayed mean |
|---|---|---|
| Step change, 3,000 then 5,000 | 1,095 | 995 |
| Stable, around 4,000 | 237 | 283 |

That is only 9% lower on the case it targets, and it is noisier on stable history. With at most
6 data points, it adds complexity for no clear gain. The current choice is also documented as
deliberate (`forecastMath.js:160-167`).

**§3.5.2 is a reasonable theory with an invented number.** `√ρ` is the correct formula if days
are independent, and the current linear `ρ` is the correct formula if they are fully correlated.
Real spending is somewhere between. The proposed `ρ^0.75` has no evidence behind it. At
`σ = 1,000` and `ρ = 0.1`, the band would be 100, 178 or 316 depending on the choice. A backtest
on real months can settle this, so I'd not change it blind. It only affects a displayed range.

**§3.6 overstates the problem.** Budget carry-over is opt-in per budget, and the replay is one
query rather than one per month. A "reset each calendar year" also doesn't fit a system built on
financial cycles. The cap itself is sensible and simple.

**Smaller errors:**

- §2.1 joins on `c.id`. The real key is `categories.category_id`.
- §2.3.3 gives `4.348125`. The true value is `4.348214`.
- §2.2.2 says the closed week "completely" solves the cut-off. It does fix the bug, but a
  Saturday-night card purchase will probably still be pending on Sunday morning.

## 3. Where Gemini was right, tested

All figures come from running the real `forecastMath.js`.

**§3.1 the bug is real, but narrower than described.** The docs promise that one day's spending
has bounded leverage, and that promise only holds for flat weights. The `dowWeights` shrinkage
limits the worst case, so Gemini's "74×" becomes a net leverage of about 9.5, not the documented
2.6. The effect appears when a cycle starts on a day you rarely spend.

₪300 spent on day 1, with a ₪6,000 habit, on a cycle starting Saturday:

| Weekly pattern | Effective days | Current forecast | With the fix |
|---|---|---|---|
| Flat | 1.00 | ₪6,364 | ₪6,364 |
| Typical (Friday double, Saturday half) | 0.62 | ₪6,925 | ₪6,660 |
| Extreme (never spends on Saturday) | 0.28 | ₪8,550 | ₪6,945 |

Across all 7 start days and 3 patterns, flat weights were unchanged and the last day still
landed exactly on actuals. The fix is one line, because `elapsedShare` is already computed.

**§3.3 this is a real bug, and it's bigger than it looks.** Each category divides only by its
own active months, so the category averages no longer add up to your real monthly average. In a
test with one steady category and three occasional ones, the true average was ₪3,000 and the sum
of the category averages was ₪5,000, **67% too high**. That sum is the Momentum chart's target
and the burn-rate figure.

Dividing by the cycles the *user* was active keeps the original protection for new users: the
existing test where a 2-month user is divided by 2 still passes. It also creates a useful
guarantee, confirmed numerically: the category figures now sum exactly to the user's total.

This reverses a rule written in `CALCULATIONS.md` §5, so that rule needs rewording.

**§3.4 the mismatch is real.** P&L uses 6 decayed cycles and Insights uses 3 flat ones.
Combined with §3.3, this produces a useful simplification: with no budgets set,
`pacing_target.variable` *is* the decayed variable mean. So the weekly score needs one formula,
not Gemini's two-way branch. The two figures can still differ very slightly, because P&L counts
only months with variable spending. Short first cycles stay in P&L for now.

## 4. Part 1: a better option than either of Gemini's

Gemini offers two options. Each has a cost:

- **Internal API:** needs a new service-to-service credential and a new route outside the normal
  user auth, for a bot that currently never calls the backend.
- **Python port:** adds a third hand-maintained copy of the math.

**Recommended: move the whole job into the backend.** The checks show nothing blocks this:

- The backend already sends Telegram messages (`utils/telegram.js`) and Web Push.
- The token is already in the shared `.env`.
- It already has DST-aware scheduling.
- All the math it needs is already in `forecastMath.js`.

So there is no new network path and no new credential, and the Python score code and its tests
can be deleted. Push becomes easy to add later too. The one new need is a stored "sent for this
week" marker, so a restart can't send the message twice.

## 5. Decisions

The plan assumes these. Tell me if you want any changed.

1. **Move the job to the backend**, as above.
2. **Cap carry-over at 1× the monthly limit**, so `effective_limit` is at most 2× the limit.
3. **Insights figures will change.** The Momentum target will fall for anyone with occasional
   categories. A rare purchase will also show larger on the Trend bars: ₪900 of clothes against
   a typical ₪300 reads as +200%, where today it reads as 0%. That is more honest, but you'll
   notice it.
4. **Telegram stays the only channel** for the weekly message. Adding push would mean two
   notifications for one event.
5. **`three_mo_avg` keeps its API name**, though it will hold a 6-cycle figure. A cached PWA can
   run old frontend code against the new API, so a rename could blank those charts. The label
   users see does change.

## 6. Not verified

- **No real data:** the SmartFin database isn't available here, so the size of each effect on
  your account is unknown. All figures above use invented inputs.
- **Pending rows:** I couldn't confirm how often your banks return pending rows, or what amounts
  they carry.
- **Foreign currency:** there is no exchange-rate table, and I don't know how many non-ILS rows
  you have. Filtering only the weekly score would make it disagree with the dashboard, so this
  needs a separate decision after counting rows.

**Extra finding, not in Gemini's list:** carry-over replays history using the *current* limit, so
editing a budget rewrites past months' carry. It's left as is in this plan.
