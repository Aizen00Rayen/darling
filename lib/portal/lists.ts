/** `{ items: [...] }` as the list APIs answer: a cheap shape check before the page reads it. */
export function isList<T>(data: unknown): data is { items: T[]; total: number } {
  return typeof data === 'object' && data !== null && Array.isArray((data as { items?: unknown }).items) && typeof (data as { total?: unknown }).total === 'number';
}

/** The first field message of an API failure, else the French message of its code. */
export function firstError(result: { errors?: Record<string, string> | undefined }, fallback: string): string {
  return (result.errors ? Object.values(result.errors)[0] : undefined) ?? fallback;
}
