/**
 * Generates db/seed_math_demo.sql — a demo account whose data exercises every formula in
 * services/forecastMath.js.
 *
 * Not hand-written, because the point of the account is that its numbers are checkable:
 * the spending is laid down against a known day-of-week shape (DOW_SHAPE below) and known
 * monthly totals, so the forecast, the pacing curve and the seasonality weights each have
 * an answer you can derive by hand and compare against the live API. Seeding it is what
 * caught the day-of-week weights being swamped by rent — a fixed monthly charge is a
 * day-of-MONTH event, and including it buried the real Fri/Sat signal.
 *
 * Deterministic — no randomness — so re-running it produces byte-identical SQL.
 *
 *   node scripts/gen_seed_math_demo.js
 */
const fs = require('fs');
const path = require('path');

const USER_ID = 999000777;
const EMAIL = 'mathdemo@smartfin.test';
// bcrypt of 'MathDemo!2026', cost 10.
const PASSWORD_HASH = '$2b$10$7Upk39i3B.g8n6/ku8hXSeFVFv1CiUIGN0d/TUA39aIg6UAJw6c9e';

const TODAY = { y: 2026, m: 8, d: 17 };
const HISTORY = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

// Monthly VARIABLE spend targets. Deliberately uneven — a flat history would make the
// forecast range null and there would be nothing to see.
const VARIABLE_TARGETS = {
    '2026-02': 2600, '2026-03': 3400, '2026-04': 2900,
    '2026-05': 3800, '2026-06': 3100, '2026-07': 3300,
};

// Variable income by month. Weak so far in August, which is the case the old
// max(actual, avg) floor used to hide.
const VARIABLE_INCOME = {
    '2026-02': 900, '2026-03': 1500, '2026-04': 1100,
    '2026-05': 2100, '2026-06': 1300, '2026-07': 1700, '2026-08': 300,
};

const FIXED_SALARY = 12000;
const RENT = 4200;
const UTILITIES = 600;
const SAVINGS_TRANSFER = 800;

// Day-of-week spending shape, 0 = Sunday. Fri/Sat carry ~2.5× a weekday — the Israeli
// weekend. This is the signal dow_weights has to recover.
const DOW_SHAPE = [1.0, 0.9, 1.0, 0.9, 1.1, 2.6, 2.4];

// Which variable category a purchase lands in, cycled deterministically. `null` is
// uncategorized on purpose: Insights used to drop those rows from its totals entirely.
const VAR_CATEGORIES = ['Food', 'Transport', 'Food', 'Entertainment', 'Food', 'Shopping', null];

const DESCRIPTIONS = {
    Food: ['Supermarket', 'Cafe', 'Bakery', 'Restaurant', 'Falafel'],
    Transport: ['Fuel', 'Bus card', 'Taxi'],
    Entertainment: ['Cinema', 'Bar', 'Concert'],
    Shopping: ['Clothes', 'Homeware', 'Electronics'],
    null: ['Uncategorized purchase', 'Misc'],
};

const daysIn = (y, m) => new Date(y, m, 0).getDate();
const dow = (y, m, d) => new Date(y, m - 1, d).getDay();
const cat = (name) => (name === null
    ? 'NULL'
    : `(SELECT category_id FROM categories WHERE user_id IS NULL AND name = '${name}')`);

const lines = [];
const say = (s = '') => lines.push(s);

/** Lay a month's variable target down across its days, weighted by day-of-week. */
function spreadMonth(month, target, throughDay = null) {
    const [y, m] = month.split('-').map(Number);
    const D = daysIn(y, m);
    const last = throughDay || D;

    // Weight every day of the FULL month, so a partial month is a genuine fraction of the
    // shape rather than a rescaled one.
    let wholeWeight = 0;
    for (let d = 1; d <= D; d++) wholeWeight += DOW_SHAPE[dow(y, m, d)];

    const rows = [];
    let pick = 0;
    for (let d = 1; d <= last; d++) {
        const w = DOW_SHAPE[dow(y, m, d)];
        const amount = (target * w) / wholeWeight;
        // Two purchases on the heavier days, one otherwise — a realistic row count, and it
        // gives the day-of-week query something to aggregate.
        const splits = w >= 2 ? [0.6, 0.4] : [1];
        for (const frac of splits) {
            const c = VAR_CATEGORIES[pick % VAR_CATEGORIES.length];
            const descs = DESCRIPTIONS[c === null ? null : c];
            rows.push({
                d,
                amount: Math.round(amount * frac * 100) / 100,
                category: c,
                description: descs[pick % descs.length],
            });
            pick++;
        }
    }
    return { rows, y, m };
}

function expenseRow(y, m, { d, amount, category, description }, isVirtual = false) {
    const ts = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} 12:00:00`;
    return `(${USER_ID}, ${amount.toFixed(2)}, ${cat(category)}, '${description.replace(/'/g, "''")}', `
        + `'${isVirtual ? 'web' : 'bot'}', ${isVirtual ? 'TRUE' : 'FALSE'}, '${ts}')`;
}

// ── Header ───────────────────────────────────────────────────────────────────────

say('-- SmartFin — math demo account.');
say('--');
say('-- GENERATED FILE. Edit scripts/gen_seed_math_demo.js and re-run it:');
say('--     node scripts/gen_seed_math_demo.js');
say('--');
say(`-- Sign in as ${EMAIL} / MathDemo!2026`);
say('--');
say('-- The data is shaped to exercise every formula in services/forecastMath.js:');
say('--   • six months of UNEVEN history, so the forecast range is non-null');
say('--   • Fri/Sat spending at ~2.5x a weekday, so dow_weights has a signal to recover');
say('--   • an overspending current month, so the credibility blend projects above habit');
say('--   • weak variable income so far this month, which the old max() floor used to hide');
say('--   • is_virtual savings transfers, which Insights used to count as spending');
say('--   • uncategorized rows, which Insights used to drop from its totals');
say('--   • subscriptions both behind and ahead of today, so only the forward ones count');
say('--');
say('-- Idempotent: re-running replaces every row it owns.');
say('');
say('SET @uid = 999000777;');
say('');
say('-- Clean out any previous run first, children before parents.');
say('DELETE FROM expenses      WHERE user_id = @uid;');
say('DELETE FROM income        WHERE user_id = @uid;');
say('DELETE FROM subscriptions WHERE user_id = @uid;');
say('DELETE FROM budgets       WHERE user_id = @uid;');
say('DELETE FROM savings_goals WHERE user_id = @uid;');
say('DELETE FROM users         WHERE user_id = @uid;');
say('');

// ── User ─────────────────────────────────────────────────────────────────────────

say('-- Password sign-in only; no Telegram link, no bank connection.');
say('-- onboarded_at is set so the welcome tour does not cover the dashboard on first load.');
say('INSERT INTO users (user_id, username, email, password_hash, onboarded_at, created_at)');
say(`VALUES (@uid, 'Math Demo', '${EMAIL}', '${PASSWORD_HASH}', '2026-02-01 09:00:00', '2026-02-01 09:00:00');`);
say('');

// ── Income ───────────────────────────────────────────────────────────────────────

say('-- Fixed salary every month, plus lumpy freelance income. August is deliberately weak:');
say('-- 300 against a ~1,400 habit. The old max(variable_actual, variable_avg) floor would');
say('-- have reported the full average here and never warned anyone.');
say('INSERT INTO income (user_id, source, amount, type, month, description) VALUES');
{
    const rows = [];
    for (const month of [...HISTORY, '2026-08']) {
        rows.push(`(@uid, 'Salary', ${FIXED_SALARY}.00, 'fixed', '${month}', 'Monthly salary')`);
        const v = VARIABLE_INCOME[month];
        if (v) rows.push(`(@uid, 'Freelance', ${v}.00, 'variable', '${month}', 'Side projects')`);
    }
    say(rows.join(',\n') + ';');
}
say('');

// ── Savings goal ─────────────────────────────────────────────────────────────────

say('-- 7 transfers x 800. These are is_virtual expenses: money moved, but NOT spending.');
say('INSERT INTO savings_goals (goal_id, user_id, name, target_amount, saved_amount, monthly_allocation, created_at)');
say(`VALUES (999777, @uid, 'Emergency Fund', 30000.00, ${SAVINGS_TRANSFER * 7}.00, ${SAVINGS_TRANSFER}.00, '2026-02-01 09:00:00');`);
say('');

// ── Expenses ─────────────────────────────────────────────────────────────────────

say('INSERT INTO expenses (user_id, amount, category_id, description, source, is_virtual, created_at) VALUES');
{
    const rows = [];
    const months = [...HISTORY, '2026-08'];
    for (const month of months) {
        const [y, m] = month.split('-').map(Number);
        const isCurrent = month === '2026-08';
        // August is an overspending month on purpose: 2,900 by day 17, where the ~3,200
        // habit would put a user near 1,750. The forecast must react to that.
        const target = isCurrent ? 2900 : VARIABLE_TARGETS[month];
        const { rows: varRows } = isCurrent
            ? spreadMonth(month, target * (daysIn(y, m) / TODAY.d), TODAY.d)
            : spreadMonth(month, target);

        rows.push(`  -- ${month}: fixed`);
        rows.push(expenseRow(y, m, { d: 1, amount: RENT, category: 'Housing', description: 'Rent' }));
        rows.push(expenseRow(y, m, { d: 5, amount: UTILITIES, category: 'Utilities', description: 'Electricity + water' }));
        rows.push(`  -- ${month}: savings transfer (is_virtual — never counted as spending)`);
        rows.push(expenseRow(y, m, { d: 10, amount: SAVINGS_TRANSFER, category: 'Savings', description: 'Emergency Fund deposit' }, true));
        rows.push(`  -- ${month}: variable`);
        for (const r of varRows) rows.push(expenseRow(y, m, r));
    }
    // Comment lines must not be joined with commas.
    const out = [];
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].startsWith('  --')) { out.push(rows[i]); continue; }
        const isLastValue = !rows.slice(i + 1).some(r => !r.startsWith('  --'));
        out.push(rows[i] + (isLastValue ? ';' : ','));
    }
    say(out.join('\n'));
}
say('');
say('-- Point the savings transfers at the goal, so the Savings card adds up.');
say('UPDATE expenses SET goal_id = 999777 WHERE user_id = @uid AND is_virtual = TRUE;');
say('');

// ── Subscriptions ────────────────────────────────────────────────────────────────

say('-- Today is the 17th. Only Netflix (22nd) and Gym (26th) are still ahead, so');
say('-- subscription_total = 54.90 + 149.00 = 203.90. Spotify already billed on the 3rd and');
say('-- its real charge is in expenses; counting it again would subtract the same money');
say('-- twice. iCloud is paused and never counts.');
say('INSERT INTO subscriptions (user_id, name, amount, category_id, day_of_month, paused, active, created_at) VALUES');
say([
    `(@uid, 'Spotify', 21.90, ${cat('Entertainment')}, 3, FALSE, TRUE, '2026-02-01 09:00:00')`,
    `(@uid, 'iCloud', 19.90, ${cat('Utilities')}, 8, TRUE, TRUE, '2026-02-01 09:00:00')`,
    `(@uid, 'Netflix', 54.90, ${cat('Entertainment')}, 22, FALSE, TRUE, '2026-02-01 09:00:00')`,
    `(@uid, 'Gym', 149.00, NULL, 26, FALSE, TRUE, '2026-02-01 09:00:00')`,
].join(',\n') + ';');
say('');

// ── Budgets ──────────────────────────────────────────────────────────────────────

say('-- budget_total = 3,400, which becomes the momentum chart target.');
say('INSERT INTO budgets (user_id, category_id, monthly_limit, carry_over, created_at) VALUES');
say([
    `(@uid, ${cat('Food')}, 1600.00, FALSE, '2026-08-01 00:00:00')`,
    `(@uid, ${cat('Transport')}, 600.00, FALSE, '2026-08-01 00:00:00')`,
    `(@uid, ${cat('Entertainment')}, 500.00, FALSE, '2026-08-01 00:00:00')`,
    `(@uid, ${cat('Shopping')}, 700.00, FALSE, '2026-08-01 00:00:00')`,
].join(',\n') + ';');
say('');
say('SELECT CONCAT(\'Seeded math demo user \', @uid) AS result;');

const out = path.join(__dirname, '..', 'db', 'seed_math_demo.sql');
fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log(`Wrote ${out} (${lines.length} lines)`);
