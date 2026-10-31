/**
 * The weekly summary's text. Pure: no DB, no clock.
 *
 * Written for Telegram's legacy `Markdown` parse mode, which is what utils/telegram.js
 * sends. Only _ * ` [ are special there, so -.() need no escaping, unlike MarkdownV2. An
 * unbalanced entity is a 400 and the user gets nothing, so anything the user named goes
 * through `escapeMarkdown` and stays outside every entity: a backslash escape does not work
 * inside a code span.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STATE_LINES = {
    well_under: { emoji: '🟢', text: (word) => `Well under your ${word}` },
    under: { emoji: '🔵', text: (word) => `Under your ${word}` },
    on_pace: { emoji: '🔵', text: (word) => `Right on your ${word} pace` },
    over: { emoji: '🟡', text: (word) => `Above your ${word}` },
    well_over: { emoji: '🔴', text: (word) => `Well above your ${word}` },
};

function escapeMarkdown(text) {
    return String(text).replace(/[_*`[]/g, '\\$&');
}

const shekels = (n) => `₪${Math.abs(Math.round(n)).toLocaleString('en-US')}`;

/** '25–31 Oct', or '29 Oct–4 Nov' when the week crosses a month. */
function weekLabel(weekStart, weekEnd) {
    const [, startMonth, startDay] = weekStart.split('-').map(Number);
    const [, endMonth, endDay] = weekEnd.split('-').map(Number);
    if (startMonth === endMonth) return `${startDay}–${endDay} ${MONTHS[endMonth - 1]}`;
    return `${startDay} ${MONTHS[startMonth - 1]}–${endDay} ${MONTHS[endMonth - 1]}`;
}

function resultLine(score, word) {
    if (score.state === 'refund') return `💸 *Net refund week* — ${shekels(score.weekTotal)} came back`;
    const { emoji, text } = STATE_LINES[score.state];
    if (score.state === 'on_pace') return `${emoji} *${text(word)}*`;
    // From the two rounded figures printed above it, so the line always adds up.
    const gap = Math.abs(Math.round(score.expected) - Math.round(score.weekTotal));
    const direction = score.delta > 0 ? 'more' : 'less';
    return `${emoji} *${text(word)}* — ₪${gap.toLocaleString('en-US')} ${direction} (${Math.abs(score.pct).toFixed(0)}%)`;
}

/**
 * `weekStart` and `weekEnd` are 'YYYY-MM-DD', both inclusive. `basis` is 'target' when budgets
 * shaped the expectation and 'usual' when it is purely the user's own habit: "over budget"
 * was printed for years by a job that never read a budget.
 */
function formatWeeklyMessage({ score, weekStart, weekEnd, basis, topCategories = [], pendingTotal = 0 }) {
    const lines = [`📊 *Your week: ${weekLabel(weekStart, weekEnd)}*`, '━━━━━━━━━━━━━━'];

    if (score.state !== 'refund') lines.push(`Everyday spending: \`${shekels(score.weekTotal)}\``);
    lines.push(`${basis === 'target' ? 'Your weekly target' : 'Your usual week'}: \`${shekels(score.expected)}\``);
    lines.push(resultLine(score, basis === 'target' ? 'target' : 'usual'));

    if (topCategories.length > 0) {
        const parts = topCategories.map((c) => `${escapeMarkdown(c.name)} ${shekels(c.total)}`);
        lines.push(`Biggest: ${parts.join(' · ')}`);
    }
    lines.push("_Rent and other fixed costs aren't counted here._");
    if (Math.round(pendingTotal) > 0) {
        lines.push(`⏳ About ${shekels(pendingTotal)} in card charges is still pending.`);
    }
    return lines.join('\n');
}

function formatNoHistoryMessage() {
    return '📊 *Your week*\nNot enough history yet. Your weekly summary starts after your first full month here.';
}

module.exports = { escapeMarkdown, formatWeeklyMessage, formatNoHistoryMessage };
