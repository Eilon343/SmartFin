const db = require('../config/db');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TELEGRAM_USER_ID = process.env.TELEGRAM_CHAT_ID;

function buildPrompt(text) {
    return (
        `Parse this Apple Pay transaction message and return ONLY valid JSON.\n` +
        `Message: "${text}"\n\n` +
        `Return this exact shape:\n` +
        `{"amount": 55.0, "currency": "ILS", "merchant": "Cafe", "category": "Food", "source": "apple_pay"}\n\n` +
        `Rules:\n` +
        `- amount: numeric value only\n` +
        `- currency: default "ILS" unless message says otherwise\n` +
        `- merchant: the store/place name\n` +
        `- category: best match from [Food, Transport, Housing, Entertainment, Shopping, Utilities, Health, Other]\n` +
        `- source: always "apple_pay"\n` +
        `Use null for fields that cannot be determined.`
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
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON found in Gemini response');
            return JSON.parse(jsonMatch[0]);
        } catch (err) {
            if (attempt < 3 && (err.unavailable || err.name === 'TypeError' || err.name === 'SyntaxError')) {
                await new Promise(r => setTimeout(r, 2000 * attempt));
                continue;
            }
            if (err.name === 'TypeError' || err.name === 'SyntaxError') err.unavailable = true;
            throw err;
        }
    }
}

async function sendTelegramMessage(chatId, text) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
}

async function insertExpense(userId, parsed) {
    let categoryId = null;
    if (parsed.category) {
        const [rows] = await db.query(
            'SELECT category_id FROM categories WHERE (user_id IS NULL OR user_id = ?) AND name = ? LIMIT 1',
            [userId, parsed.category]
        );
        if (rows.length > 0) {
            categoryId = rows[0].category_id;
        } else {
            const [ins] = await db.query(
                'INSERT INTO categories (user_id, name, is_base) VALUES (?, ?, FALSE) ON DUPLICATE KEY UPDATE category_id=LAST_INSERT_ID(category_id)',
                [userId, parsed.category]
            );
            categoryId = ins.insertId;
        }
    }
    await db.query(
        'INSERT INTO expenses (user_id, amount, currency, description, category_id, source) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, parsed.amount, parsed.currency || 'ILS', parsed.merchant, categoryId, 'apple_pay']
    );
}

async function processAndSave(userId, text) {
    const parsed = await callGemini(text);
    if (!parsed.amount) throw new Error('Could not parse amount');
    await insertExpense(userId, parsed);
    const amt = Number(parsed.amount).toFixed(2);
    const merchant = parsed.merchant || 'Unknown merchant';
    await sendTelegramMessage(
        userId,
        `✅ Apple Pay transaction confirmed: Logged *${parsed.currency || 'ILS'} ${amt}* at *${merchant}*`
    );
    return parsed;
}

// Background queue processor — runs every 5 minutes
async function processQueue() {
    try {
        const [rows] = await db.query(
            "SELECT * FROM webhook_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 10"
        );
        for (const row of rows) {
            try {
                await processAndSave(row.user_id, row.text);
                await db.query("UPDATE webhook_queue SET status = 'processed' WHERE id = ?", [row.id]);
                console.log(`Queue item ${row.id} processed`);
            } catch (err) {
                if (err.unavailable) break; // still down, stop trying
                await db.query("UPDATE webhook_queue SET status = 'failed' WHERE id = ?", [row.id]);
                console.error(`Queue item ${row.id} failed:`, err.message);
            }
        }
    } catch (err) {
        console.error('Queue processor error:', err.message);
    }
}

exports.startQueueProcessor = () => {
    const run = async () => {
        try { await processQueue(); } finally { setTimeout(run, 5 * 60 * 1000); }
    };
    run();
};

exports.handleApplePay = async (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    try {
        const parsed = await processAndSave(TELEGRAM_USER_ID, text);
        res.json({ success: true, parsed });
    } catch (err) {
        if (err.unavailable) {
            // Queue for later
            await db.query(
                "INSERT INTO webhook_queue (user_id, text, status) VALUES (?, ?, 'pending')",
                [TELEGRAM_USER_ID, text]
            );
            await sendTelegramMessage(
                TELEGRAM_USER_ID,
                `⏳ AI is temporarily unavailable. Your transaction has been queued and will be logged automatically when it recovers.`
            );
            return res.json({ success: false, queued: true });
        }
        console.error('Apple Pay webhook error:', err);
        res.status(500).json({ error: 'Failed to process transaction' });
    }
};
