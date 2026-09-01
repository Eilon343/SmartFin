/**
 * The app's month keys ("YYYY-MM") describe the user's own calendar, not UTC.
 *
 * `new Date().toISOString().slice(0, 7)` was used for this and is wrong east of
 * Greenwich: in Israel (UTC+3) the first three hours of every month still read as
 * the previous month in UTC. That put the dashboard's default month one behind the
 * month its own selector highlighted — getRecentMonths() has always built its list
 * from local getFullYear()/getMonth().
 */
export function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
