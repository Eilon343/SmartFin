# Weekly Spending Score: how it works and what the audit found

Audit date: 2026-10-31. Code audited: `bot/app/scheduler.py` on branch `dev`, commit `e8fbb3f`.

## 1. Verdict

**The arithmetic is done correctly, but the comparison it makes is not a fair one.**

The formulas run as written and the SQL filters are right. The problem is what gets compared:
an incomplete week of spending is measured against a full, complete week of history. Rent and
other monthly costs are also spread evenly across the "expected" figure, but land in one
actual week.

Three problems matter most:

| # | Problem | Effect |
|---|---|---|
| 1 | The message goes out on Saturday morning but is compared with a full 7-day expectation | Reads too low. About 14% too low for someone who spends evenly through the week |
| 2 | Monthly costs (rent, loans) are included in the weekly expectation | Three weeks look great, then one week looks terrible, with no change in behaviour |
| 3 | Card purchases are only imported once settled, so recent ones are missing | Reads even lower, by an amount that varies each week |

Problems 1 and 3 both push the score towards "good", so the message is biased in your favour.
Problem 1 is a real bug: the code and docs say it was fixed, but it wasn't. See §7.

## 2. The message

```
📊 Weekly Spending Score
━━━━━━━━━━━━━━
This week (7d): ₪ 2540.00
Expected by now: ₪ 3002.31
Result: 🔵 Good
You spent 15% less than usual.
```

| Line | What it really means |
|---|---|
| `This week (7d)` | Everything recorded from Sunday up to the moment the message was sent. The `7d` is misleading: Saturday has barely started |
| `Expected by now` | Your average total monthly spending over the last 3 cycles, divided by 4.33. It is **your own past average, not a budget** |
| `Result` | A grade based on the ratio of the two numbers above |
| `X% less/more than usual` | The same ratio, written as a percentage |

Your budgets are never read, so "Over budget" is the wrong label: it only means "above your
own average".

## 3. When it runs and who gets it

- **Schedule:** every Saturday at 09:00 by the scheduler's clock (`scheduler.py:196`). The
  comment says "local time", but nothing in `docker-compose.yml` or `bot/Dockerfile` sets a
  timezone. The container should therefore be on UTC, making it **11:00 Israel time in winter
  and 12:00 in summer**.
- **Recipients:** every user with a linked Telegram chat (`get_notifiable_users`). Web-only
  users get nothing.
- **Latest data available:** the bank sync runs at 07:00 and 19:00 Israel time, so the newest
  bank data is from the Saturday 07:00 run.

## 4. What is counted

| Item | Counted? | Notes |
|---|---|---|
| Hand-logged expenses (bot or web) | Yes | Dated when logged, in UTC |
| Bank and card imports | Yes, **only once `completed`** | Dated by the transaction date. Pending rows wait in staging |
| Rent, loans and other fixed costs | Yes | `is_fixed` is not considered |
| Subscriptions | Yes | As a generated row, or as the real imported charge if sync is connected |
| Refunds | Yes, as negative amounts | They reduce the total of the week they are dated in |
| Savings-goal deposits (`is_virtual = TRUE`) | No | Correctly excluded on both sides |
| Real bank transfers categorised as Savings | Yes | Only virtual rows are excluded |
| Other currencies | Added as if shekels | `SUM(amount)` does no conversion, so $100 counts as ₪100 |

## 5. The calculation, step by step

Line numbers are in `bot/app/scheduler.py`.

**Step 1: find the start of the week** (line 20). The most recent Sunday, or today if today is
Sunday.

```
week_start   = today − ((today.weekday() + 1) mod 7) days
elapsed_days = (today − week_start) + 1        → 7 on a Saturday
```

**Step 2: this week's total** (lines 33-38).

```sql
SUM(amount) WHERE is_virtual = FALSE AND created_at >= week_start
```

**Step 3: the history window** (lines 44-48). The last 3 complete financial cycles, not
calendar months. The current, unfinished cycle is left out.

```
window_start = start of (current cycle − 3)
window_end   = start of current cycle
```

**Step 4: average per cycle** (lines 50-60). The divisor is the number of cycles that have
**at least one row**, not always 3.

```
total_past  = SUM(amount) in the window, is_virtual = FALSE
months      = number of distinct cycles with data
monthly_avg = total_past / max(months, 1)
```

**Step 5: convert to a week** (line 62).

```
weekly_avg = monthly_avg / 4.33
```

**Step 6: scale for days elapsed** (line 67).

```
expected = weekly_avg × (elapsed_days / 7)     → weekly_avg × 1 on a Saturday
```

**Step 7: ratio and percentage** (lines 88, 98). The ratio is rounded to 2 decimals, and
everything after that uses the rounded value.

```
ratio = round(week_total / expected, 2)
pct   = (ratio − 1) × 100
```

**Step 8: grade** (lines 89-96).

| Rounded ratio | Unrounded ratio, about | Grade |
|---|---|---|
| ≤ 0.80 | below 0.805 | 🟢 Excellent |
| 0.81 to 1.00 | 0.805 to 1.005 | 🔵 Good |
| 1.01 to 1.20 | 1.005 to 1.205 | 🟡 Over budget |
| above 1.20 | 1.205 and up | 🔴 Way over budget |

If `weekly_avg` or `expected` is 0, the message says "Not enough history yet" instead.

## 6. Worked example (invented numbers)

User with cycle anchor day 10. The job runs on Saturday 31 Oct 2026.

| Step | Calculation | Result |
|---|---|---|
| Week start | Most recent Sunday | 25 Oct 2026 |
| Elapsed days | Sun to Sat inclusive | 7 |
| Current cycle | Contains 31 Oct | 10 Oct to 9 Nov (key `2026-10`) |
| History window | 3 cycles back | 10 Jul to 9 Oct |
| History total | 12,000 + 14,000 + 13,000 | ₪39,000 |
| `monthly_avg` | 39,000 / 3 | ₪13,000 |
| `weekly_avg` | 13,000 / 4.33 | ₪3,002.31 |
| `expected` | 3,002.31 × 7/7 | ₪3,002.31 |
| `week_total` | Sum of this week's rows | ₪2,540 |
| `ratio` | round(2,540 / 3,002.31, 2) = round(0.846, 2) | 0.85 |
| `pct` | (0.85 − 1) × 100 | −15, shown as "15% less" |
| Grade | 0.85 is between 0.81 and 1.00 | 🔵 Good |

## 7. Problems found

### High impact

**1. The Saturday bug was never fixed.** The comment at `scheduler.py:64-66` and
`docs/CALCULATIONS.md:408-410` say the job runs when the week is 6 days old, and that
`expected` now scales for this. In reality Sunday to Saturday counts as **7**, so
`elapsed_days / 7 = 1` and nothing is scaled. Saturday's spending has barely begun, yet
`expected` includes a full Saturday.

- A person spending exactly ₪200 every day gets `₪1200 vs ₪1416.47`, "15% less than usual".
- The real error is the share of your normal week that falls after the cut-off. Spending
  evenly, that is about 14%. If you spend little on Shabbat, it will be smaller.
- The tests missed this because they pass `elapsed_days=6` by hand
  (`tests/bot/test_scheduler.py:56`, `tests/math/test_pnl_math.py:141`). Another test in the
  same file asserts that Saturday gives 7 (`test_pnl_math.py:62`). All 46 tests pass.

**2. Monthly costs distort the score.** `monthly_avg` includes rent and similar, and dividing
by 4.33 spreads them evenly over every week. The real charge lands in a single week. With
₪6,000 rent on the 1st plus ₪100 a day, identical behaviour produced:

| Week | This week | Expected | Result |
|---|---|---|---|
| Without rent | ₪600 | ₪2,093.92 | 🟢 Excellent, 71% less |
| With rent | ₪6,700 | ₪2,093.92 | 🔴 Way over budget, 220% more |

This is probably the main reason the message is hard to interpret: the grade can depend more
on the calendar than on your behaviour.

**3. Recent card purchases are missing.** Only `completed` transactions are imported
(`bankSyncScheduler.js:183`). Purchases still pending on Saturday morning are absent from
`week_total`, while the history contains everything. In the steady ₪200-a-day example, with
Thursday and Friday still pending, the result falls to ₪800, "44% less" and 🟢 Excellent. The
real size depends on how long your cards take to settle, which I couldn't measure.

### Medium impact

**4. Some spending never appears in any weekly message.** Each message takes a snapshot on
Saturday morning, and the next one starts from the following Sunday. Anything dated later on
Saturday, including Saturday-night outings, is in no message. The same applies to purchases
from earlier in the week that settle after the snapshot. They still count towards future
averages.

**5. A short history produces false alarms.** Any cycle with even one row counts as a full
cycle. With only 5 days of history in the first cycle, the steady ₪200-a-day user gets
`₪1200 vs ₪230.95`, 🔴 "420% more", with no change in spending. This affects new users, and
it can also happen after a gap in logging.

**6. The baseline moves with you.** "Usual" means your own recent average. After three
expensive months, the bar rises and an expensive week can still read as "Good". One large
one-off purchase also raises the bar for three cycles. Even correct numbers can't tell you
whether your spending is actually healthy.

**7. Other currencies are added as shekels.** This only affects rows not in ILS, such as
"20 usd lunch" through the bot. I didn't check how the other screens handle this.

### Low impact

| # | Issue | Effect |
|---|---|---|
| 8 | 4.33 weeks per month. The true value is 4.348 (365.25 / 12 / 7) | `expected` is about 0.4% high. Harmless |
| 9 | Exactly on target prints "0% less than usual" | Wording only |
| 10 | A week where refunds exceed spending gives a negative ratio, such as "110% less" | Wording only |
| 11 | "Saturday 09:00 local time" is actually 09:00 UTC (see §3) | The comment and docs are wrong |
| 12 | Hand-logged spending from midnight to about 02:00-03:00 Sunday Israel time is stored as Saturday UTC | It falls in the previous week. Tiny |
| 13 | `docs/CALCULATIONS.md` §4 says "3 complete months" (they are cycles) and "three things" before listing four | Docs only |

## 8. What was checked and found correct

- The week starts on Sunday, including across month and year boundaries.
- Virtual savings transfers are excluded from both sides.
- The history window and the cycle count both use the anchor day. For anchor 10 on 31 Oct, the
  window starts on 10 Jul and uses a 9-day shift, as expected.
- The current, unfinished cycle stays out of the history.
- The grade can't disagree with the printed percentage, because both use the rounded ratio.
- Having no history doesn't cause a divide-by-zero.

## 9. How this was verified

- I ran the real `_compute_spending_score`, `_format_score_message` and `_week_start` from
  `scheduler.py` on invented transactions. All message figures in §7 are real output.
- The database was replaced by a fake cursor that reproduces the two queries in Python, so
  **the SQL itself did not run on MySQL**. I reviewed it by reading.
- The existing tests pass: `tests/math/test_pnl_math.py` and `tests/bot/test_scheduler.py`,
  46 tests.
- **Not checked against your real data.** The SmartFin database isn't running on this machine,
  so the real size of problems 1, 2 and 3 for your account is unknown.
- The UTC send time is inferred from the config, not observed in production.

To measure problem 1 on your own account, this query shows how your spending falls across the
week. Saturday's share is roughly the bias. It is read-only but hasn't been run. Replace
`YOUR_ID` first:

```sql
SELECT DAYNAME(created_at) AS day,
       ROUND(SUM(amount)) AS total,
       ROUND(100 * SUM(amount) / SUM(SUM(amount)) OVER (), 1) AS pct
FROM expenses
WHERE user_id = YOUR_ID AND is_virtual = FALSE
  AND created_at >= NOW() - INTERVAL 90 DAY
GROUP BY day
ORDER BY total DESC;
```

No application code was changed in this audit.
