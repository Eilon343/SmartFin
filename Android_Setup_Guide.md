# SmartFin - Android Setup Guide

This guide will walk you through setting up SmartFin on your Android device. It covers installing the Progressive Web App (PWA), connecting to the Telegram bot, understanding how the AI bot works, and configuring automatic expense logging whenever you use Tap-to-Pay (Google Wallet).

---

## 1. Installing the App (PWA)

Unlike iOS where you must add apps to the home screen manually through Safari, Android has native integration for Progressive Web Apps, making them feel exactly like apps downloaded from the Google Play Store.

1. Open **Google Chrome** on your Android phone.
2. Navigate to your SmartFin web address: `https://mac-mini-home.tail61d766.ts.net/`
3. Chrome will likely show a banner at the bottom of the screen saying **"Add to Home screen"** or **"Install SmartFin"**. If it does, tap it.
4. If the banner does not appear, tap the **Three-Dot Menu (⋮)** in the top right corner of Chrome.
5. Select **Install app** (or "Add to Home screen").
6. Confirm the installation. SmartFin will now appear in your Android **App Drawer** and Home screen. It will launch in full-screen mode without the browser UI.

---

## 2. Connecting to the Telegram Bot

The Telegram bot is your primary method for logging manual expenses when you aren't using the dashboard.

1. Download and open **Telegram** on your phone.
2. Search for your SmartFin bot username: `@smartfin110800bot`
3. Tap **Start** to initiate the conversation.
4. The bot is now linked to your Telegram account and ready to accept your commands.

---

## 3. How the Bot Works

SmartFin's bot acts as your personal AI financial assistant. 

* **Natural Language Input:** You don't need to use rigid formats. You can send it voice notes or type messages exactly how you speak (e.g., in Hebrew: *"הוצאתי 7 שקל על קולה, 5 שקל על מסטיק, ו-200 שקל על דלק"*).
* **Multi-Expense Processing:** The AI engine is smart enough to extract multiple transactions from a single message.
* **Automatic Categorization:** The AI automatically identifies the vendor, extracts the exact amount, and classifies the expense into one of your SmartFin categories (e.g., Food, Transport, Utilities).
* **Instant Sync:** Once the bot processes the message, it will reply with a summary confirmation, and the expenses will instantly appear in your SmartFin dashboard.

---

## 4. Automating Tap-to-Pay (Google Wallet / NFC)

To replicate the "Apple Pay Shortcuts" automation on Android, we use a technique called **Notification Interception**. When you tap your phone to pay, Google Wallet (or your banking app) sends a notification. We will use a free app called **MacroDroid** to intercept this notification and forward it to your SmartFin server.

### Step 4.1: Install MacroDroid
1. Open the Google Play Store.
2. Search for and install **MacroDroid - Device Automation**.
3. Open the app and grant it the basic permissions it requests on startup.

### Step 4.2: Create the Automation Macro
1. On the MacroDroid home screen, tap **Add Macro**.

#### A. Set The Trigger
1. Tap the **+** button under the **Triggers** section (red area).
2. Navigate to **Device Events** -> **Notification**.
3. Select **Notification Received**.
4. Choose **Select Application(s)** and check the box for your payment app (e.g., **Google Wallet**, **Google Pay**, or your specific bank app like **Bit** / **PayBox**). Tap OK.
5. Under "Text Content", you can leave it as "Any", or to be safe, select "Contains" and type the currency symbol (`₪`) so it only triggers on actual payment notifications. Tap OK.

#### B. Set The Action (Webhook)
1. Tap the **+** button under the **Actions** section (blue area).
2. Navigate to **Applications** -> **HTTP Request**.
3. Set the following configuration:
   * **Request Type:** `POST`
   * **URL Address:** `https://mac-mini-home.tail61d766.ts.net/api/telegram/apple_pay`
   * **Headers:** Tap the "Headers" tab (or add them via the UI parameters depending on the MacroDroid version), and add the following two headers:
     * Key: `Content-Type` | Value: `application/json`
     * Key: `x-webhook-secret` | Value: `<YOUR_WEBHOOK_SECRET>` *(Ask the admin for this code)*
   * **Body:** You need to send the text of the notification to your server. Switch to the **Body** tab, ensure it is set to send Raw Text / Custom, and use MacroDroid's "Magic Text" button (the blue `[...]` button) to insert the notification title and text. 
   
   It should look exactly like this in the text box:
   ```json
   {
     "text": "[not_title] [not_ticker]"
   }
   ```
4. Tap OK to save the Action.

#### C. Finalize and Save
1. Give your Macro a name at the top of the screen (e.g., "SmartFin Auto Pay").
2. Tap the **Back** arrow or the **Checkmark** button to save the macro.
3. MacroDroid will ask for **Notification Access** permissions in your Android settings. Follow the prompt to enable MacroDroid in the Notification Access screen.

### Step 5: Testing the Automation
Next time you make a purchase using your phone's NFC:
1. Google Wallet will pop up a notification (e.g., *"Paid ₪50.00 to Aroma"*).
2. MacroDroid will instantly catch this notification in the background.
3. It will send the HTTP POST request to your SmartFin server.
4. The SmartFin server will parse the text, log the expense, and send you a Telegram confirmation message!

---
*Note: If your Mac Mini is only accessible on your local Wi-Fi, the webhook will only work when you are at home. If you want this to work everywhere (e.g., buying coffee at the store), ensure your Mac Mini is exposed to the internet securely via a reverse proxy (like Nginx, Cloudflare Tunnels, or ngrok).*
