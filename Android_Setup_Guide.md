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

## 4. Automate Tap-to-Pay (Google Wallet / NFC)

When you tap to pay, your banking or wallet app sends a notification. We use **MacroDroid** to intercept that notification and forward it to SmartFin automatically.

### Step 4.1 – Install MacroDroid

1. Install **MacroDroid – Device Automation** from the Google Play Store.
2. Open it and grant the permissions it requests on first launch.

### Step 4.2 – Create the Automation Macro

1. Tap **Add Macro** on the MacroDroid home screen.

#### A. Set the Trigger

1. Tap **+** under **Triggers**.
2. Go to **Device Events** → **Notification** → **Notification Received**.
3. Select your payment app (e.g. **Google Wallet**, **Bit**, **PayBox**). Tap OK.
4. Under "Text Content", select **Contains** and type `₪` — this filters to actual payment notifications only. Tap OK.

#### B. Set the Action (HTTP Webhook)

1. Tap **+** under **Actions**.
2. Go to **Applications** → **HTTP Request**.
3. Configure as follows:

   | Field | Value |
   |-------|-------|
   | Request Type | `POST` |
   | URL | `https://mac-mini-home.tail61d766.ts.net/webhook/apple-pay` |

4. Add two **Headers**:
   - `Content-Type` → `application/json`
   - `x-webhook-secret` → *(ask the admin for this value)*

5. In the **Body** tab, set type to **Raw / Custom** and paste exactly:
   ```json
   {
     "text": "[not_title] [not_ticker]"
   }
   ```
   The `[not_title]` and `[not_ticker]` are MacroDroid magic text variables that insert the notification content at runtime.

6. Tap OK to save the action.

#### C. Save the Macro

1. Name it something like **SmartFin Auto Pay**.
2. Tap the checkmark or back arrow to save.
3. When prompted, grant MacroDroid **Notification Access** in Android Settings.

### Step 4.3 – Disable Battery Optimization for MacroDroid

Android kills background apps aggressively. Without this step, MacroDroid will stop catching notifications after a short while.

1. Open Android **Settings** → **Apps** → **MacroDroid**.
2. Tap **Battery** → select **Unrestricted** (or "Don't optimize").
3. On Samsung devices: also go to **Settings** → **Battery** → **Background usage limits** and make sure MacroDroid is not listed there.

### Step 4.4 – Test It

Make a purchase using NFC. You should see:
1. A payment notification from Google Wallet / your bank app.
2. MacroDroid intercepts it and sends the POST request.
3. SmartFin parses the amount and merchant, logs the expense, and sends you a **Telegram confirmation message**.

