const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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

/**
 * Best-effort notification — a failed notification must never abort the caller's
 * work (a bank sync that imported rows is still a success if Telegram is down).
 */
async function notifyUser(chatId, text) {
    if (!chatId) return;
    try {
        await sendTelegramMessage(chatId, text);
    } catch (err) {
        console.error('Failed to notify user via Telegram:', err.message);
    }
}

module.exports = { sendTelegramMessage, notifyUser };
