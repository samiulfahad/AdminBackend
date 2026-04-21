// ─── BST (Asia/Dhaka = UTC+6) Time Utilities ─────────────────────────────────
//
// Rule: ALL timestamps stored in MongoDB are UTC epoch milliseconds.
// BST conversions happen ONLY at the boundary:
//   - when computing human-meaningful day boundaries (due dates, period bounds)
//   - when the cron schedule fires (handled by node-cron timezone option)
//
// Never store a "BST timestamp" — store UTC ms and convert for display only.

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000; // UTC+6

/**
 * Given any UTC timestamp, return 23:59:59.999 BST of that same BST calendar day,
 * expressed as a UTC epoch millisecond.
 *
 * Example: nowUtc = 2026-01-01T20:00:00Z  (= Jan 2 02:00 BST)
 *   → BST calendar day is Jan 2
 *   → Jan 2 23:59:59.999 BST = Jan 2 17:59:59.999 UTC
 *   → returns that UTC ms
 */
export function endOfDayBST(utcMs) {
  const dhakaDate = new Date(utcMs + DHAKA_OFFSET_MS);
  const y = dhakaDate.getUTCFullYear();
  const mo = dhakaDate.getUTCMonth();
  const d = dhakaDate.getUTCDate();
  // Start of next BST day = Date.UTC(y, mo, d+1) - DHAKA_OFFSET_MS
  // End of current BST day = that minus 1ms
  return Date.UTC(y, mo, d + 1) - DHAKA_OFFSET_MS - 1;
}

/**
 * Given a UTC timestamp, return the BST calendar date as "YYYY-MM-DD".
 * Use this when seeding <input type="date"> values on the frontend.
 */
export function toBSTDateString(utcMs) {
  return new Date(utcMs + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Given a "YYYY-MM-DD" string that represents a BST calendar date,
 * return 23:59:59.999 BST of that day as a UTC epoch millisecond.
 *
 * This is what you use when the admin picks a date in the UI and you need
 * to store it as a UTC dueDate.
 */
export function bstDateStringToEndOfDayUTC(dateStr) {
  // dateStr = "2026-05-08"
  // Treat it as noon UTC to avoid any DST or date-boundary ambiguity, then
  // snap to end-of-day BST.
  const noonUTC = new Date(dateStr + "T12:00:00Z").getTime();
  return endOfDayBST(noonUTC);
}

/**
 * Return the current BST year and 1-indexed month.
 * Use this in the cron / generate function to determine "which month just ended".
 */
export function currentBSTYearMonth() {
  const nowDhaka = new Date(Date.now() + DHAKA_OFFSET_MS);
  return {
    year: nowDhaka.getUTCFullYear(),
    month: nowDhaka.getUTCMonth() + 1, // 1-indexed
  };
}

/**
 * Return the billing period for the month BEFORE the current BST month.
 * e.g. if today is 2026-04-01 BST, this returns March 2026.
 * e.g. if today is 2026-01-01 BST, this returns December 2025.
 *
 * Returns { year, month (1-indexed), periodStart (Date UTC), periodEnd (Date UTC exclusive),
 *           periodEndDisplay (Date UTC = last day of month at 00:00 UTC) }
 */
export function previousBSTMonth() {
  let { year, month } = currentBSTYearMonth();
  // step back one month
  month -= 1;
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  return buildPeriod(year, month);
}

/**
 * Build period boundaries for a given year+month (1-indexed).
 */
export function buildPeriod(year, month) {
  const periodStart = new Date(Date.UTC(year, month - 1, 1)); // first ms of month UTC
  const periodEnd = new Date(Date.UTC(year, month, 1)); // first ms of NEXT month UTC (exclusive)
  const periodEndDisplay = new Date(Date.UTC(year, month, 0)); // last day of month 00:00 UTC
  return { year, month, periodStart, periodEnd, periodEndDisplay };
}
