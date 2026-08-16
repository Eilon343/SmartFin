const db = require('../config/db');
const { redeemLinkCode } = require('../services/telegramLink');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_USER_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!TELEGRAM_WEBHOOK_SECRET) {
    console.warn(
        'TELEGRAM_WEBHOOK_SECRET is not set — POST /webhook/telegram will refuse every ' +
        'request with 503. This is fine if the bot long-polls, which is the default. To ' +
        'serve the webhook, set the variable and register it with Telegram:\n' +
        '  curl -F "url=<public-url>/webhook/telegram" -F "secret_token=<value>" \\\n' +
        '       https://api.telegram.org/bot<TOKEN>/setWebhook'
    );
}

function buildPrompt(text) {
    return (
        `You are an expense parser. The user describes one or more purchases in a single message.\n` +
        `Your job: return a JSON array with ONE object per purchase. NEVER merge or sum items. NEVER return fewer objects than there are purchases.\n\n` +
        `Example input: "הוצאתי 7 שקל על קולה, 200 שקל על דלק ו5 על חטיף"\n` +
        `Example output:\n` +
        `[\n` +
        `  {"amount": 7.0, "currency": "ILS", "merchant": "קולה", "category": "Food"},\n` +
        `  {"amount": 200.0, "currency": "ILS", "merchant": "דלק", "category": "Transport"},\n` +
        `  {"amount": 5.0, "currency": "ILS", "merchant": "חטיף", "category": "Food"}\n` +
        `]\n\n` +
        `Now parse this message: "${text}"\n\n` +
        `Rules:\n` +
        `- Return ONLY a valid JSON array, no explanation\n` +
        `- One object per purchase, max 10\n` +
        `- DO NOT combine amounts — each purchase is its own object\n` +
        `- amount: numeric only\n` +
        `- currency: "ILS" unless stated otherwise\n` +
        `- merchant: the item/place name from the message (keep original language)\n` +
        `- category: best match from [Food, Transport, Housing, Entertainment, Shopping, Utilities, Health, Other]\n` +
        `- Use null for fields that cannot be determined`
    );
}

// Returns parsed object, or throws with .unavailable = true if Gemini is down
async function callGemini(text) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: buildPrompt(text) }] }],
                        generationConfig: { responseMimeType: 'application/json' },
                    }),
                }
            );
            if (!res.ok) {
                const isRetryable = res.status === 429 || res.status >= 500;
                const errData = await res.json().catch(() => ({}));
                const e = new Error(errData.error?.message || `Gemini HTTP error: ${res.status}`);
                if (isRetryable) e.unavailable = true;
                throw e;
            }
            const data = await res.json();
            if (data.error) throw new Error(`Gemini error: ${data.error.message}`);
            const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!raw) throw new Error('Empty Gemini response');
            const arrayMatch = raw.match(/\[[\s\S]*\]/);
            const objectMatch = raw.match(/\{[\s\S]*\}/);
            if (!arrayMatch && !objectMatch) throw new Error('No JSON found in Gemini response');
            const parsed = JSON.parse(arrayMatch ? arrayMatch[0] : objectMatch[0]);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch (err) {
            if (attempt < 3 && (err.unavailable || err.name === 'TypeError' || err.name === 'SyntaxError')) {
                await new Promise(r => setTimeout(r, 2000 * attempt));
                continue;
            }
            if (err.name === 'TypeError') err.unavailable = true;
            throw err;
        }
    }
}

async function sendTelegramMessage(chatId, text) {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Telegram API error ${res.status}: ${errText}`);
    }
}

async function sendErrorToTelegram(context, err, extra = {}) {
    const timestamp = new Date().toISOString();
    const extraLines = Object.entries(extra)
        .map(([k, v]) => `• *${k}:* \`${String(v).slice(0, 200)}\``)
        .join('\n');
    const msg =
        `🚨 *SmartFin Error*\n` +
        `• *Where:* ${context}\n` +
        `• *Error:* \`${err.message}\`\n` +
        (extraLines ? `${extraLines}\n` : '') +
        `• *Time:* ${timestamp}`;
    try {
        await sendTelegramMessage(TELEGRAM_USER_ID, msg);
    } catch (telegramErr) {
        console.error('Failed to send error to Telegram:', telegramErr.message);
    }
    console.error(`[${context}]`, err);
}

const VALID_CATEGORIES = ['Food', 'Transport', 'Housing', 'Entertainment', 'Shopping', 'Utilities', 'Health', 'Other'];

async function insertExpense(userId, parsed) {
    const categoryName = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'Other';
    const [rows] = await db.query(
        'SELECT category_id FROM categories WHERE (user_id IS NULL OR user_id = ?) AND name = ? LIMIT 1',
        [userId, categoryName]
    );
    let categoryId;
    if (rows.length > 0) {
        categoryId = rows[0].category_id;
    } else {
        const [ins] = await db.query(
            'INSERT INTO categories (user_id, name, is_base) VALUES (?, ?, FALSE) ON DUPLICATE KEY UPDATE category_id=LAST_INSERT_ID(category_id)',
            [userId, categoryName]
        );
        categoryId = ins.insertId;
    }
    // 'bot', not 'apple_pay'. Both remaining callers — the Telegram webhook and the
    // Gemini-down queue drain — are Telegram messages; the Apple Pay endpoint that
    // justified the old value is gone. Beyond being mislabelled, an 'apple_pay' row
    // written today would be a deletion target for the bot's /clean_applepay, which
    // hunts exactly that source.
    await db.query(
        'INSERT INTO expenses (user_id, amount, currency, description, category_id, source) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, parsed.amount, parsed.currency || 'ILS', parsed.merchant, categoryId, 'bot']
    );
}

async function processAndSave(userId, text, chatId) {
    const items = await callGemini(text);
    const saved = [];
    for (const parsed of items) {
        if (!parsed.amount) continue;
        await insertExpense(userId, parsed);
        saved.push(parsed);
    }
    if (saved.length === 0) throw new Error('Could not parse any expense');

    let message;
    if (saved.length === 1) {
        const p = saved[0];
        message = `✅ Logged *${p.currency || 'ILS'} ${Number(p.amount).toFixed(2)}* at *${p.merchant || 'Unknown merchant'}*`;
    } else {
        const lines = saved.map(p => `• *${p.currency || 'ILS'} ${Number(p.amount).toFixed(2)}* – ${p.merchant || 'Unknown'}`).join('\n');
        message = `✅ Logged ${saved.length} expenses:\n${lines}`;
    }
    const notifyChatId = chatId || userId;
    try {
        await sendTelegramMessage(notifyChatId, message);
    } catch (err) {
        console.error('Failed to send confirmation message:', err.message);
    }
    return saved;
}

// Background queue processor — runs every 5 minutes
async function processQueue() {
    try {
        const [rows] = await db.query(
            "SELECT wq.*, u.telegram_chat_id FROM webhook_queue wq LEFT JOIN users u ON u.user_id = wq.user_id WHERE wq.status = 'pending' ORDER BY wq.created_at ASC LIMIT 10"
        );
        for (const row of rows) {
            try {
                await processAndSave(row.user_id, row.text, row.telegram_chat_id);
                await db.query("UPDATE webhook_queue SET status = 'processed' WHERE id = ?", [row.id]);
                console.log(`Queue item ${row.id} processed`);
            } catch (err) {
                if (err.unavailable) break; // still down, stop trying
                await db.query("UPDATE webhook_queue SET status = 'failed' WHERE id = ?", [row.id]);
                await sendErrorToTelegram('Queue processor', err, { input: row.text, queue_id: row.id });
            }
        }
    } catch (err) {
        await sendErrorToTelegram('Queue processor (DB)', err);
    }
}

const HELP_TEXT =
    `🤖 *SmartFin Bot — Help*\n\n` +
    `*Log expenses by typing naturally:*\n` +
    `• \`7 שקל על קולה\`\n` +
    `• \`spent 50 on lunch\`\n` +
    `• \`200 דלק, 15 קפה, 80 סופר\`\n\n` +
    `*Multiple expenses in one message:*\n` +
    `Separate with commas or "and/ו". Up to 10 per message.\n\n` +
    `*Auto-logging:*\n` +
    `Connect your bank and credit cards in Settings on the web app — transactions import automatically every night.\n\n` +
    `*Categories detected automatically:*\n` +
    `Food · Transport · Shopping · Housing · Entertainment · Utilities · Health · Other\n\n` +
    `*Commands:*\n` +
    `/help — show this message\n` +
    `/start — show this message\n` +
    `/link <code> — connect this chat to your SmartFin account\n\n` +
    `_All expenses appear in your SmartFin dashboard._`;

exports.handleTelegram = async (req, res) => {
    // Telegram echoes the secret_token given to setWebhook on every delivery. Without
    // this check the endpoint is an open door: the update body carries the chat id, so a
    // forged POST can log expenses into any account that has already linked its chat.
    //
    // Fails CLOSED. This used to enforce only when a secret was configured, so an
    // unconfigured deployment accepted anything — and "unconfigured" is the default,
    // because the bot long-polls and most deployments never register a webhook at all.
    // An endpoint that is usually unused but always open is the worst combination: no
    // one notices it, and reaching it is enough to log expenses into a stranger's account.
    //
    // Account *takeover* through this endpoint is closed separately: linking now requires a
    // code issued to an authenticated web session, so a forged update cannot bind a chat to
    // an account it does not already own.
    //
    // Refusing when unset costs nothing in the default configuration and closes the door
    // in the one that matters.
    if (!TELEGRAM_WEBHOOK_SECRET) {
        return res.sendStatus(503);
    }
    const presented = req.headers['x-telegram-bot-api-secret-token'];
    if (presented !== TELEGRAM_WEBHOOK_SECRET) {
        return res.sendStatus(401);
    }

    res.sendStatus(200); // always ack Telegram immediately

    const update = req.body;
    const message = update?.message;
    if (!message) return;

    const chatId = String(message.chat.id);
    const text = (message.text || '').trim();

    if (!text) return;

    try {
        await handleTelegramMessage(chatId, text);
    } catch (err) {
        await sendErrorToTelegram('Telegram message handler', err, { input: text });
        try {
            await sendTelegramMessage(chatId, "❌ An unexpected error occurred. Please try again later.");
        } catch (notifyErr) {
            console.error('Failed to send error notification:', notifyErr.message);
        }
    }
};

async function handleTelegramMessage(chatId, text) {
    // /link <code> is the ONLY pre-auth command, and it proves nothing by itself — the code
    // was issued to an already-authenticated web session, so redeeming it links this chat to
    // the account that asked for it and to no other.
    //
    // It replaces /link_google <email>, which took an email on the sender's word. That let
    // any Telegram user bind their chat to any account whose telegram_chat_id was still NULL
    // (every Google-only account), and let an attacker pre-claim an address so the real
    // owner's later Google sign-in landed in the attacker's row.
    const linkMatch = text.match(/^\/link(?:\s+(\S+))?$/i);
    if (linkMatch) {
        const code = linkMatch[1];
        if (!code) {
            await sendTelegramMessage(chatId,
                `Usage: \`/link <code>\`\n\nGet your code from SmartFin → Settings → Telegram bot.`
            );
            return;
        }
        const result = await redeemLinkCode(code, chatId);
        if (result.ok) {
            await sendTelegramMessage(chatId, `✅ Linked! Start logging expenses anytime.`);
        } else if (result.reason === 'chat_taken') {
            await sendTelegramMessage(chatId, `❌ This Telegram account is already linked to a different SmartFin account.`);
        } else {
            await sendTelegramMessage(chatId, `❌ That code is invalid, expired or already used. Generate a new one in SmartFin → Settings → Telegram bot.`);
        }
        return;
    }

    // Look up user by Telegram chat ID
    const [userRows] = await db.query(
        'SELECT user_id FROM users WHERE telegram_chat_id = ?',
        [chatId]
    );
    if (userRows.length === 0) {
        await sendTelegramMessage(chatId,
            `👋 Welcome to SmartFin Bot!\n\nSign in at the SmartFin web app, then open ` +
            `*Settings → Telegram bot* and tap "Generate code".\n\nSend it here as \`/link <code>\`.`
        );
        return;
    }
    const userId = userRows[0].user_id;

    if (text === '/start' || text === '/help') {
        await sendTelegramMessage(chatId, HELP_TEXT);
        return;
    }

    try {
        await processAndSave(userId, text, chatId);
    } catch (err) {
        if (err.unavailable) {
            await db.query(
                "INSERT INTO webhook_queue (user_id, text, status) VALUES (?, ?, 'pending')",
                [userId, text]
            );
            await sendTelegramMessage(chatId, `⏳ AI is temporarily unavailable. Queued — will log automatically when it recovers.`);
            return;
        }
        await sendErrorToTelegram('Telegram message handler', err, { input: text });
        await sendTelegramMessage(chatId, `❌ Could not parse expense. Try: _"50 שקל על דלק"_ or _"spent 50 on fuel"_`);
    }
};

exports.startQueueProcessor = () => {
    const run = async () => {
        try { await processQueue(); } finally { setTimeout(run, 5 * 60 * 1000); }
    };
    run();
};

