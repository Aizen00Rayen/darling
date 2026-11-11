/** Africa/Algiers is UTC+1 all year (no daylight saving), so a calendar day maps to a fixed UTC window. */
const ALGIERS_OFFSET_MS = 3_600_000;
const DAY_MS = 86_400_000;

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The UTC window (epoch milliseconds) of one Algiers calendar day given as `YYYY-MM-DD`: `start` is 00:00 Algiers
 * (inclusive), `endExclusive` the next day's 00:00 Algiers. Null when the text is not a real date (wrong format,
 * `2026-02-30`, month 13, year below 1000...). Computed on UTC fields only, never through local time.
 */
export function algiersDayBounds(text: string): { start: number; endExclusive: number } | null {
  const match = CALENDAR_DATE.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000) return null; // Date.UTC would map 0-99 to 19xx
  const midnightUtc = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls overflowing fields over (Feb 30 becomes Mar 2).
  if (midnightUtc.getUTCFullYear() !== year || midnightUtc.getUTCMonth() !== month - 1 || midnightUtc.getUTCDate() !== day) {
    return null;
  }
  const start = midnightUtc.getTime() - ALGIERS_OFFSET_MS;
  return { start, endExclusive: start + DAY_MS };
}

/** The Algiers calendar day (`YYYY-MM-DD`) an instant falls in. Algiers has no daylight saving: a fixed UTC+1 shift. */
export function algiersDateString(ms: number): string {
  const d = new Date(ms + ALGIERS_OFFSET_MS);
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

/** The last two digits of the Algiers calendar year (what order numbers carry). */
export function algiersYear2(ms: number): string {
  return String(new Date(ms + ALGIERS_OFFSET_MS).getUTCFullYear() % 100).padStart(2, '0');
}
