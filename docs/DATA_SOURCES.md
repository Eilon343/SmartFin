# What bank & card sync actually returns (Step 0)

Inspected against `israeli-bank-scrapers@6.9.0` (the pinned version) — `lib/transactions.d.ts`
and the Leumi, Max and Visa Cal scrapers — and against a real Leumi + Max + Visa Cal account.
Every transaction is stored whole in `bank_transactions_raw.raw_json`, so any field below is
available to SmartFin without changing the scrape.

## Per transaction (all sources)

| Field | Meaning |
|---|---|
| `date`, `processedDate` | ISO; Israel-local midnight expressed in UTC (read with `bankDateOf`) |
| `chargedAmount`, `originalAmount`, `originalCurrency`, `chargedCurrency` | negative = money out |
| `description`, `memo` | merchant / free text |
| `status` | `completed` \| `pending` (only completed rows are imported) |
| `type` | `normal` \| `installments` |
| `installments` | `{ number, total }` — "payment 3 of 12" |
| `identifier` | NOT a transaction id (see CLAUDE.md, dedup is content-hashed) |
| `category` | the issuer's own category label (cards only) |

## Per source

| | Leumi (bank) | Max (card) | Visa Cal (card) |
|---|---|---|---|
| Transactions | ✅ | ✅ | ✅ |
| Installments (`installments.{number,total}`) | ❌ never | ✅ parsed from the "תשלום X מתוך Y" comment | ✅ `curPaymentNum` / `numOfPayments` |
| Issuer category | ❌ | ✅ Max category name | ✅ `branchCodeDesc` |
| Standing orders as such | ❌ — just ordinary debits | ❌ | `trnTypeCode` 9 → mapped to `normal`, not exposed |
| Loans (balance, rate, remaining) | ❌ | ❌ | ❌ |
| Account balance | ✅ `account.balance` — stored per sync (`account_balance_snapshots`, migration 018), shown on the Dashboard | ❌ | ❌ |

## Consequences in the app

- **Installments**: automatic, from the card feeds. `combineInstallments` is now `false` —
  with `true` the library drops payments 2..N of every plan (`filterOldTransactions`), so only
  the first payment of any installment purchase was ever imported. Migration 016 arms a
  one-off 3-month re-scrape per card connection to backfill the missing payments.
- **Account balance**: the bank's own figure, stored once per account per day on every sync
  and shown on the Dashboard with the change since the previous day it was seen.
- **Loans**: **manual entry** (Loans tab). Repayment debits (`פרעון הלוואה`) are imported as
  expenses and offered as a starting point; loan disbursements (`העמדת הלואה`) are no longer
  booked as income.
- **Standing orders**: no source field. Recurring bank debits are found by recurring
  detection (same payee, similar amount, each of the last 3 months) and land in
  Subscriptions as auto-detected.
- **Issuer category**: now passed to Gemini as a hint; deterministic rules
  (`services/categoryRules.js`) run before Gemini for unambiguous payees.
