const db = require('../config/db');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TELEGRAM_USER_ID = process.env.TELEGRAM_CHAT_ID; // doubles as user_id in DB

async function callGemini(text) {
    const prompt =
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
        `Use null for fields that cannot be determined.`;

    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: 'application/json' },
            }),
        }
    );

    const data = await res.json();
    console.log('Gemini raw response:', JSON.stringify(data).slice(0, 500));
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('Empty Gemini response');
    return JSON.parse(raw);
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
                'INSERT INTO categories (user_id, name, is_base) VALUES (?, ?, FALSE)',
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

exports.handleApplePay = async (req, res) => {
    // Validate secret
    const secret = req.headers['x-webhook-secret'];
    if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    try {
        // Parse with Gemini
        const parsed = await callGemini(text);

        if (!parsed.amount) {
            return res.status(422).json({ error: 'Could not parse amount from message' });
        }

        // Insert expense
        await insertExpense(TELEGRAM_USER_ID, parsed);

        // Notify via Telegram
        const amt = Number(parsed.amount).toFixed(2);
        const merchant = parsed.merchant || 'Unknown merchant';
        await sendTelegramMessage(
            TELEGRAM_USER_ID,
            `✅ Apple Pay transaction confirmed: Logged *${parsed.currency || 'ILS'} ${amt}* at *${merchant}*`
        );

        res.json({ success: true, parsed });
    } catch (err) {
        console.error('Apple Pay webhook error:', err);
        res.status(500).json({ error: 'Failed to process transaction' });
    }
};
