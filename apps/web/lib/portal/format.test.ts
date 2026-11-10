import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDay, formatLastLogin } from './format';

describe('formatDateTime', () => {
  it('renders in Africa/Algiers time (UTC+1)', () => {
    expect(formatDateTime('2026-11-10T13:30:00.000Z')).toMatch(/^10\/11\/2026.*14[:h]30$/);
  });

  it('rolls over to the next day after 23:00 UTC', () => {
    expect(formatDateTime('2026-11-10T23:30:00.000Z')).toMatch(/^11\/11\/2026.*00[:h]30$/);
  });

  it('returns an em dash for missing or invalid values', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not a date')).toBe('—');
  });
});

describe('formatDay', () => {
  it('renders the Algiers calendar day only', () => {
    expect(formatDay('2026-12-31T23:30:00.000Z')).toBe('01/01/2027');
  });
});

describe('formatLastLogin', () => {
  it('says "Jamais" when the user never signed in', () => {
    expect(formatLastLogin(null)).toBe('Jamais');
  });
  it('formats a date otherwise', () => {
    expect(formatLastLogin('2026-11-10T13:30:00.000Z')).toMatch(/^10\/11\/2026/);
  });
});
