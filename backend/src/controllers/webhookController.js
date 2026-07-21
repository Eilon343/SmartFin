const db = require('../config/db');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TELEGRAM_USER_ID = process.env.TELEGRAM_CHAT_ID;

function buildPrompt(text) {
    return (
        `You are an expense parser. The user describes one or more purchases in a single message.\n` +
        `Your job: return a JSON array with ONE object per purchase. NEVER merge or sum items. NEVER return fewer objects than there are purchases.\n\n` +
        `Example input: "הוצאתי 7 שקל על קולה, 200 שקל על דלק ו5 על חטיף"\n` +
        `Example output:\n` +
        `[\n` +
        `  {"amount": 7.0, "currency": "ILS", "merchant": "קולה", "category": "Food", "source": "apple_pay"},\n` +
        `  {"amount": 200.0, "currency": "ILS", "merchant": "דלק", "category": "Transport", "source": "apple_pay"},\n` +
        `  {"amount": 5.0, "currency": "ILS", "merchant": "חטיף", "category": "Food", "source": "apple_pay"}\n` +
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
        `- source: always "apple_pay"\n` +
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
    await db.query(
        'INSERT INTO expenses (user_id, amount, currency, description, category_id, source) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, parsed.amount, parsed.currency || 'ILS', parsed.merchant, categoryId, 'apple_pay']
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
    `Send /setup_applepay for a step-by-step guide to logging payments automatically from your phone.\n\n` +
    `*Categories detected automatically:*\n` +
    `Food · Transport · Shopping · Housing · Entertainment · Utilities · Health · Other\n\n` +
    `*Commands:*\n` +
    `/help — show this message\n` +
    `/start — show this message\n\n` +
    `_All expenses appear in your SmartFin dashboard._`;

exports.handleTelegram = async (req, res) => {
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
    // Handle /link_google before user lookup
    const linkMatch = text.match(/^\/link_google\s+(\S+)$/i);
    if (linkMatch) {
        const email = linkMatch[1].toLowerCase();
        const [rows] = await db.query(
            'SELECT user_id, telegram_chat_id FROM users WHERE google_email = ?',
            [email]
        );
        if (rows.length > 0) {
            const user = rows[0];
            if (user.telegram_chat_id && user.telegram_chat_id !== chatId) {
                await sendTelegramMessage(chatId, `❌ That email is already linked to a different Telegram account.`);
                return;
            }
            // Guard: this Telegram account already linked to a different email
            const [chatRows] = await db.query('SELECT user_id FROM users WHERE telegram_chat_id = ?', [chatId]);
            if (chatRows.length > 0 && String(chatRows[0].user_id) !== String(user.user_id)) {
                await sendTelegramMessage(chatId, `❌ This Telegram account is already linked to another email.`);
                return;
            }
            await db.query('UPDATE users SET telegram_chat_id = ? WHERE user_id = ?', [chatId, user.user_id]);
        } else {
            // New user — Telegram chat ID becomes their user_id
            await db.query(
                'INSERT INTO users (user_id, google_email, telegram_chat_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE google_email = VALUES(google_email), telegram_chat_id = VALUES(telegram_chat_id)',
                [chatId, email, chatId]
            );
        }
        await sendTelegramMessage(chatId, `✅ Linked! Your Telegram is now connected to *${email}*. Start logging expenses anytime.`);
        return;
    }

    // Look up user by Telegram chat ID
    const [userRows] = await db.query(
        'SELECT user_id FROM users WHERE telegram_chat_id = ?',
        [chatId]
    );
    if (userRows.length === 0) {
        await sendTelegramMessage(chatId,
            `👋 Welcome to SmartFin Bot!\n\nLink your account first:\n\`/link_google your@email.com\`\n\nUse the same email you signed in with.`
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

/**
 * Resolve which user a webhook call belongs to.
 *
 * Preferred: a per-user X-Webhook-Token, issued by the bot's /webhook_token
 * command. Each shortcut carries its owner's token, so transactions land in
 * that user's account and notifications go to that user's chat.
 *
 * Legacy: the shared X-Webhook-Secret, which carries no identity and always
 * resolves to TELEGRAM_CHAT_ID (the instance owner). Kept only so existing
 * shortcuts keep working until they are migrated — remove once they are.
 */
async function resolveWebhookUser(req) {
    const token = req.headers['x-webhook-token'];
    if (token) {
        const [rows] = await db.query(
            'SELECT user_id, telegram_chat_id FROM users WHERE webhook_token = ?',
            [String(token)]
        );
        if (rows.length === 0) return { error: 'unauthorized' };
        return { userId: rows[0].user_id, chatId: rows[0].telegram_chat_id };
    }

    const secret = req.headers['x-webhook-secret'];
    if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) return { error: 'unauthorized' };

    console.warn('Apple Pay webhook used the legacy shared secret — attributing to the instance owner. Update this shortcut to send X-Webhook-Token.');
    const [rows] = await db.query(
        'SELECT user_id, telegram_chat_id FROM users WHERE telegram_chat_id = ?',
        [String(TELEGRAM_USER_ID)]
    );
    if (rows.length === 0) return { error: 'unlinked' };
    return { userId: rows[0].user_id, chatId: rows[0].telegram_chat_id };
}

exports.handleApplePay = async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const { userId, chatId, error } = await resolveWebhookUser(req);
    if (error === 'unauthorized') return res.status(401).json({ error: 'Unauthorized' });
    if (error === 'unlinked') {
        return res.status(403).json({ error: 'Account not linked. Send /link_google to the bot first.' });
    }

    try {
        const saved = await processAndSave(userId, text, chatId);
        res.json({ success: true, count: saved.length, parsed: saved });
    } catch (err) {
        if (err.unavailable) {
            await db.query(
                "INSERT INTO webhook_queue (user_id, text, status) VALUES (?, ?, 'pending')",
                [userId, text]
            );
            try {
                await sendTelegramMessage(
                    chatId,
                    `⏳ AI is temporarily unavailable. Your transaction has been queued and will be logged automatically when it recovers.`
                );
            } catch (notifyErr) {
                console.error('Failed to send queued notification:', notifyErr.message);
            }
            return res.json({ success: false, queued: true });
        }
        await sendErrorToTelegram('Apple Pay webhook', err, { input: text });
        res.status(500).json({ error: 'Failed to process transaction' });
    }
};
