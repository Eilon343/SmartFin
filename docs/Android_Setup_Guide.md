# SmartFin – Android Setup Guide

Everything you need to get SmartFin running on Android: installing the app, connecting the Telegram bot, and automating expense logging when you tap to pay.

---

## 1. Install the App (PWA)

1. Open **Google Chrome** on your Android phone.
2. Go to: `https://mac-mini-home.tail61d766.ts.net/`
3. Chrome will show a banner: **"Add SmartFin to Home screen"** or **"Install app"** — tap it.
   - If no banner appears, tap the **⋮ menu** (top-right) → **Install app**.
4. Confirm the installation. SmartFin will appear in your App Drawer and Home screen, launching in full-screen like a native app.
5. Open the app and sign in with your **Google Account**.

---

## 2. Connect the Telegram Bot

The bot is your quick way to log expenses without opening the dashboard.

1. Open **Telegram** and search for `@smartfin110800bot`.
2. Tap **Start**.
3. Link your Telegram account to your SmartFin profile by sending:
   ```
   /link_google your_email@gmail.com
   ```
   Use the same email you registered with in the app.

---

## 3. How the Bot Works

- **Natural language:** Type expenses how you'd say them, including Hebrew.
  *Example: "הוצאתי 7 שקל על קולה, 5 שקל מסטיק, ו-200 שקל דלק"*
- **Multiple expenses:** One message can contain several transactions — the AI extracts all of them.
- **Auto-categorization:** The AI identifies the vendor, amount, and category automatically.
- **Instant sync:** Expenses appear in the dashboard immediately after confirmation.

---

## 4. Automatic Expense Logging (Bank & Card Sync)

Nothing to install on the phone. SmartFin logs in to your bank and credit cards for you
and imports transactions every night.

1. Open SmartFin in your browser → **Settings** → **Bank sync**.
2. Tap **Connect**, choose your bank, and enter the same details you use on the bank's
   own website. They're encrypted before they're stored and are never shown again.
3. Repeat for **each credit card** (Isracard, Max, Visa Cal, Amex…).

Connecting the cards as well as the bank matters: the bank statement shows only one
lump settlement per card per month, not what you actually bought. With the card
connected, SmartFin imports the individual purchases and drops the duplicate
settlement automatically.

The first sync backfills about three months and takes a few minutes; you'll get a
Telegram message when it's done, and again after each nightly sync that finds
something new.

### Replaced: the MacroDroid / notification webhook

Earlier versions forwarded Google Wallet payment notifications to SmartFin with
MacroDroid. That endpoint has been removed — a tap-to-pay purchase is a credit-card
purchase, so the card connection already imports it, with the real merchant name
instead of a notification string. Running both logged everything twice.

If you set up that macro, **delete it in MacroDroid**, then send the bot
`/clean_applepay` to review and remove the duplicates it left behind. The command
shows you what it would delete before deleting anything, and only removes rows it can
match to a real synced transaction unless you explicitly ask for more.
