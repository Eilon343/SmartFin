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
 *
 * @returns {Promise<boolean>} whether the message is off the caller's hands: true when
 *          Telegram accepted it, and also true when there is no chat id to send to (an
 *          unlinked user is owed nothing). False ONLY when the send itself failed, so a
 *          caller holding a tally can tell "delivered" from "lost" and retry the latter.
 */
async function notifyUser(chatId, text) {
    if (!chatId) return true;
    try {
        await sendTelegramMessage(chatId, text);
        return true;
    } catch (err) {
        console.error('Failed to notify user via Telegram:', err.message);
        return false;
    }
}

module.exports = { sendTelegramMessage, notifyUser };
