export type QueryValue = string | number | undefined | null;

/** `path?k=v&…` with empty values dropped and `page=1` omitted (it is the default). */
export function buildHref(path: string, params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'page' && Number(value) === 1) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

/** A page number from a search param: digits only, 1 to 10 000, otherwise 1. */
export function parsePage(value: string | string[] | undefined): number {
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) return 1;
  const n = Number(value);
  return n >= 1 && n <= 10_000 ? n : 1;
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** The first non-empty string of a search param (they may arrive as arrays). */
export function firstParam(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v === '' ? undefined : v;
}
