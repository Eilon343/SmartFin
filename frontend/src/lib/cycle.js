/**
 * The client-side twin of `backend/src/services/cycle.js`.
 *
 * A financial cycle runs from the user's card-settlement day to the day before the next
 * one — for someone charged on the 10th, "September" means 10 Sep – 9 Oct. Only the month
 * PICKERS need this here; every figure on a page comes from the server, which sends
 * `cycle_start`, `cycle_end`, `days_in_cycle` and `cycle_day` with each response precisely
 * so no screen has to agree with the backend about where a boundary falls.
 *
 * Keep the derivations below in step with the backend module. The two are pinned to the
 * same behaviour by tests/backend/cycle.test.js on that side.
 *
 * `month.js` still owns the plain local calendar month, which is a different thing and
 * still needed: `income.month` records which salary a row is, not which cycle spends it.
 */

const pad2 = (n) => String(n).padStart(2, '0');

/** Defaults reproduce a calendar month exactly, so a page can render before settings load. */
export const DEFAULT_SETTINGS = { cycle_anchor_day: 1, salary_day: 1 };

export function anchorOf(settings) {
  const n = Math.floor(Number(settings?.cycle_anchor_day));
  return Number.isFinite(n) && n >= 1 && n <= 28 ? n : 1;
}

export function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
}

/** Resolve a 'YYYY-MM' cycle key into the dates it covers. */
export function resolveCycle(key, settings) {
  const anchor = anchorOf(settings);
  const [y, m] = key.split('-').map(Number);
  const start = new Date(y, m - 1, anchor);
  const end = new Date(y, m, anchor);         // exclusive
  const lastDay = new Date(end.getTime() - 86400000);
  return {
    key,
    anchor,
    start,
    end,
    lastDay,
    days: Math.round((end - start) / 86400000),
  };
}

/**
 * Which `income.month` a cycle is funded by — the mirror of cycle.incomeMonthOf on the
 * server. Used only to pre-fill the "add income" form with the salary the viewed cycle
 * spends; the backend owns this mapping for every figure.
 */
export function incomeMonthOf(key, settings) {
  const anchor = anchorOf(settings);
  const salaryDay = Math.floor(Number(settings?.salary_day));
  const day = Number.isFinite(salaryDay) && salaryDay >= 1 && salaryDay <= 28 ? salaryDay : 1;
  return day >= anchor ? key : addMonths(key, 1);
}

/** Which cycle contains `date`. A date before the anchor still belongs to the previous one. */
export function cycleKeyOfDate(date, settings) {
  const anchor = anchorOf(settings);
  const key = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
  return date.getDate() >= anchor ? key : addMonths(key, -1);
}

/** The cycle we are living in right now — every page's default period. */
export function currentCycle(settings, now = new Date()) {
  return cycleKeyOfDate(now, settings);
}

/** Position of `date` within a cycle, 1..days. 0 before it opens, clamped after it closes. */
export function dayIndexIn(cycleOrKey, date, settings) {
  const c = typeof cycleOrKey === 'string' ? resolveCycle(cycleOrKey, settings) : cycleOrKey;
  const at = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const idx = Math.round((at - c.start) / 86400000) + 1;
  if (idx < 1) return 0;
  return Math.min(idx, c.days);
}

/**
 * "10 Sep – 9 Oct" — shown under the month name so the label is never ambiguous about
 * which period it means. Returns null for a plain calendar month, where the month name
 * already says everything and a date range would only be noise.
 */
export function cycleRangeLabel(key, settings, lang = 'en') {
  if (anchorOf(settings) === 1) return null;
  const c = resolveCycle(key, settings);
  const locale = lang === 'he' ? 'he-IL' : 'en-US';
  const fmt = (d) => d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  return `${fmt(c.start)} – ${fmt(c.lastDay)}`;
}

/**
 * The `num` most recent cycles, newest first — the one list every month picker is built
 * from, replacing the four near-identical copies the pages each carried.
 *
 * A cycle is NAMED for the month it starts in, so the label is the ordinary month name and
 * `range` carries the dates it actually spans.
 */
/**
 * The long list behind the `<select>` pickers on Expenses and Income — five years of
 * cycles, newest first, running a year ahead so a future period can be inspected.
 *
 * The label carries the date range once the anchor is anything but the 1st: a dropdown
 * showing "September 2026" when the period is 10 Sep – 9 Oct is the exact ambiguity this
 * feature exists to remove.
 */
export function getCycleOptions(settings = DEFAULT_SETTINGS, lang = 'en', count = 60) {
  const now = new Date();
  const locale = lang === 'he' ? 'he-IL' : 'en-US';
  let key = `${now.getFullYear() + 1}-12`;
  const out = [];
  for (let i = 0; i < count; i++) {
    const [y, m] = key.split('-').map(Number);
    const name = new Date(y, m - 1, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' });
    const range = cycleRangeLabel(key, settings, lang);
    out.push({ iso: key, label: range ? `${name} (${range})` : name, range });
    key = addMonths(key, -1);
  }
  return out;
}

export function getRecentCycles(num = 3, settings = DEFAULT_SETTINGS, lang = 'en') {
  const out = [];
  let key = currentCycle(settings);
  for (let i = 0; i < num; i++) {
    const [y, m] = key.split('-').map(Number);
    const locale = lang === 'he' ? 'he-IL' : 'en-US';
    out.push({
      iso: key,
      label: new Date(y, m - 1, 1).toLocaleDateString(locale, { month: 'short' }),
      full: new Date(y, m - 1, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' }),
      range: cycleRangeLabel(key, settings, lang),
    });
    key = addMonths(key, -1);
  }
  return out;
}
