/** Africa/Algiers is UTC+1 all year (no daylight saving), so a calendar day maps to a fixed UTC window. */
const ALGIERS_OFFSET_MS = 3_600_000;
const DAY_MS = 86_400_000;

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The UTC window of one Algiers calendar day given as `YYYY-MM-DD`: `start` is 00:00 Algiers
 * (inclusive), `endExclusive` the next day's 00:00 Algiers. Null when the text is not a real date
 * (wrong format, `2026-02-30`, month 13...). Computed on UTC fields only, never through local time.
 */
export function algiersDayBounds(text: string): { start: Date; endExclusive: Date } | null {
  const match = CALENDAR_DATE.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const midnightUtc = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls overflowing fields over (Feb 30 becomes Mar 2) and maps years 0-99 to 19xx.
  if (
    midnightUtc.getUTCFullYear() !== year ||
    midnightUtc.getUTCMonth() !== month - 1 ||
    midnightUtc.getUTCDate() !== day
  ) {
    return null;
  }
  const start = new Date(midnightUtc.getTime() - ALGIERS_OFFSET_MS);
  return { start, endExclusive: new Date(start.getTime() + DAY_MS) };
}
