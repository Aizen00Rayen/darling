import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '@/server/test/app';
import { GET, access } from './route';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(() => {
  vi.restoreAllMocks();
  app.close();
});

const call = () => GET(new Request('http://localhost:3000/api/health'), { params: Promise.resolve({}) });

describe('GET /api/health', () => {
  it('is public and reports the database as up', async () => {
    expect(access).toEqual({ kind: 'public' });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, db: 'up' });
  });

  it('answers 503 with no detail when the database fails', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    vi.spyOn(app.db, 'get').mockImplementation(() => {
      throw new Error('unable to open database file /secret/path');
    });
    const res = await call();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, db: 'down' });
    expect(text).not.toContain('secret');
  });
});
