import { describe, expect, it } from 'vitest';
import { buildHref, firstParam, pageCount, parsePage } from './query';

describe('buildHref', () => {
  it('keeps non-empty params, drops empty/undefined ones and encodes values', () => {
    expect(buildHref('/admin/utilisateurs', { q: 'a b&c', role: '', status: undefined, page: 2 })).toBe(
      '/admin/utilisateurs?q=a+b%26c&page=2',
    );
  });
  it('returns the bare path when nothing remains', () => {
    expect(buildHref('/admin/journal', { tab: undefined })).toBe('/admin/journal');
  });
  it('omits page=1', () => {
    expect(buildHref('/x', { q: 'z', page: 1 })).toBe('/x?q=z');
  });
});

describe('parsePage', () => {
  it('accepts positive integers', () => {
    expect(parsePage('3')).toBe(3);
  });
  it.each([undefined, '', '0', '-1', '1.5', 'abc', '1e3', ['2', '3']])('falls back to 1 for %j', (v) => {
    expect(parsePage(v as string | string[] | undefined)).toBe(1);
  });
  it('caps absurd values', () => {
    expect(parsePage('99999999')).toBe(1);
  });
});

describe('pageCount', () => {
  it('rounds up and is at least 1', () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(120, 50)).toBe(3);
  });
});

describe('firstParam', () => {
  it('returns the first string value or undefined', () => {
    expect(firstParam('a')).toBe('a');
    expect(firstParam(['a', 'b'])).toBe('a');
    expect(firstParam(undefined)).toBeUndefined();
    expect(firstParam('')).toBeUndefined();
  });
});
