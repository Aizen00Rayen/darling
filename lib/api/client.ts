export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; errors?: Record<string, string> };

export type ApiInit = { method?: string; body?: unknown };

/** Turns a fetch Response into an ApiResult. Shared by the browser and server helpers. */
export async function toApiResult<T>(res: Response): Promise<ApiResult<T>> {
  if (res.status === 204) return { ok: true, data: undefined as T };

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, status: res.status, code: 'bad_response' };
  }

  if (res.ok) return { ok: true, data: json as T };

  if (json && typeof json === 'object' && typeof (json as { code?: unknown }).code === 'string') {
    const { code, errors } = json as { code: string; errors?: unknown };
    const result: ApiResult<T> = { ok: false, status: res.status, code };
    if (errors && typeof errors === 'object' && !Array.isArray(errors)) {
      result.errors = errors as Record<string, string>;
    }
    return result;
  }
  return { ok: false, status: res.status, code: 'bad_response' };
}

/** Browser helper: same-origin JSON request to the API (proxied by the Next rewrite). */
export async function api<T>(path: string, init: ApiInit = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'X-Requested-With': 'fetch', Accept: 'application/json' };
  const hasBody = init.body !== undefined;
  if (hasBody) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      body: hasBody ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, code: 'network' };
  }
  return toApiResult<T>(res);
}
