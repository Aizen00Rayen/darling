const TIME_ZONE = 'Africa/Algiers';

const dateTime = new Intl.DateTimeFormat('fr-DZ', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const day = new Intl.DateTimeFormat('fr-DZ', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' });

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `10/11/2026 14:30` in Algiers time, or an em dash when there is no valid date. */
export function formatDateTime(value: string | null | undefined): string {
  const date = parse(value);
  return date ? dateTime.format(date) : '—';
}

/** The Algiers calendar day, `10/11/2026`. */
export function formatDay(value: string | null | undefined): string {
  const date = parse(value);
  return date ? day.format(date) : '—';
}

export function formatLastLogin(value: string | null | undefined): string {
  return value ? formatDateTime(value) : 'Jamais';
}
