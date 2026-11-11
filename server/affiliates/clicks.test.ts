import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createTestApp, type TestApp } from '../test/app';
import { click, refCookieOf, seedAffiliate, setCookieOf } from '../test/affiliation';
import { cleanLandingPath, isBotAgent, referrerHost } from './clicks';
import { hashIp, refCookieValue, refSetCookie, signRef, verifyRef } from './ref';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(() => app.close());

const clicks = () => app.db.all<{ id: string; affiliate_user_id: string; ip_hash: string; at: number; referrer_host: string | null; landing_path: string; order_id: string | null }>('SELECT * FROM affiliate_clicks ORDER BY at, id');

describe('POST /api/affiliate/click', () => {
  it('records a click and answers 204 with a signed cookie', async () => {
    const aya = await seedAffiliate(app);
    const res = await click(app, aya.code, { ip: '203.0.113.7', landingPath: '/' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const [row] = clicks();
    expect(row).toMatchObject({ affiliate_user_id: aya.id, landing_path: '/', order_id: null, at: app.clock.now() });
    const cookie = refCookieOf(res)!;
    const value = decodeURIComponent(cookie.slice('dl_ref='.length));
    expect(value).toBe(signRef(app.config, row!.id));
    expect(verifyRef(app.config, value)).toBe(row!.id);
  });

  it('sets the cookie with HttpOnly, SameSite=Lax, Path=/ and a Max-Age of the window (Secure only when configured)', async () => {
    const aya = await seedAffiliate(app);
    const line = setCookieOf(await click(app, aya.code))!;
    expect(line).toMatch(/; HttpOnly/);
    expect(line).toMatch(/; SameSite=Lax/);
    expect(line).toMatch(/; Path=\//);
    expect(line).toMatch(/; Max-Age=2592000(;|$)/);
    expect(line).not.toMatch(/Secure/);
    expect(line).not.toMatch(/Domain/);

    app.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('attribution.window_days', '7', 1)");
    expect(setCookieOf(await click(app, aya.code))).toMatch(/Max-Age=604800/);

    const secure = createTestApp({ config: { cookieSecure: true, appOrigin: 'https://shop.example' } });
    try {
      const a2 = await seedAffiliate(secure);
      expect(setCookieOf(await click(secure, a2.code))).toMatch(/; Secure/);
    } finally {
      secure.close();
    }
  });

  it('answers an unknown, malformed or inactive code with the SAME 204, no cookie and no click', async () => {
    const live = await seedAffiliate(app, { fullName: 'Live One' });
    const invited = await seedAffiliate(app, { fullName: 'Inv One', status: 'invited' });
    const suspended = await seedAffiliate(app, { fullName: 'Sus One', status: 'suspended' });
    const deactivated = await seedAffiliate(app, { fullName: 'Dea One', status: 'deactivated' });
    const demoted = await seedAffiliate(app, { fullName: 'Dem One' });
    app.db.run("UPDATE users SET role = 'sub_manager' WHERE id = ?", demoted.id);
    const real = await click(app, live.code);
    const answers = [];
    for (const code of ['ZZZ999', 'aya001', 'AYA', "AYA001'; DROP TABLE users;--", '', 'A'.repeat(39), invited.code, suspended.code, deactivated.code, demoted.code]) {
      const res = await click(app, code);
      answers.push([res.status, res.headers.getSetCookie().length, await res.text(), res.headers.get('content-type')]);
    }
    for (const a of answers) expect(a).toEqual([204, 0, '', null]);
    expect(real.status).toBe(204);
    expect(clicks()).toHaveLength(1); // only the live code
    expect(app.db.get('SELECT count(*) AS n FROM affiliate_profiles')).toEqual({ n: 5 });
  });

  it('needs the CSRF headers like every other write (403 csrf, nothing recorded)', async () => {
    const aya = await seedAffiliate(app);
    const noHeader = await app.call('/api/affiliate/click', { body: { code: aya.code }, headers: { 'X-Requested-With': null } });
    expect(noHeader.status).toBe(403);
    const badOrigin = await app.call('/api/affiliate/click', { body: { code: aya.code }, headers: { Origin: 'https://evil.example' } });
    expect(badOrigin.status).toBe(403);
    expect(clicks()).toHaveLength(0);
  });

  it('rejects malformed bodies with 400 and records nothing', async () => {
    expect((await app.call('/api/affiliate/click', { rawBody: '{nope' })).status).toBe(400);
    expect((await app.call('/api/affiliate/click', { body: {} })).status).toBe(400);
    expect((await app.call('/api/affiliate/click', { body: { code: 12 } })).status).toBe(400);
    expect((await app.call('/api/affiliate/click', { rawBody: JSON.stringify({ code: 'x'.repeat(70_000) }) })).status).toBe(413);
    expect(clicks()).toHaveLength(0);
  });

  it('dedupes the same visitor on the same influenceuse for 30 minutes, still refreshing the cookie', async () => {
    const aya = await seedAffiliate(app);
    const first = await click(app, aya.code, { ip: '203.0.113.7' });
    app.clock.advance(29 * 60_000);
    const second = await click(app, aya.code, { ip: '203.0.113.7' });
    expect(clicks()).toHaveLength(1);
    expect(refCookieOf(second)).toBe(refCookieOf(first));
    expect(setCookieOf(second)).toMatch(/Max-Age=2592000/);
    app.clock.advance(2 * 60_000); // 31 minutes after the FIRST click: a new visit
    await click(app, aya.code, { ip: '203.0.113.7' });
    expect(clicks()).toHaveLength(2);
  });

  it('counts a different visitor, or the same visitor on another influenceuse, separately', async () => {
    const aya = await seedAffiliate(app);
    const bea = await seedAffiliate(app, { fullName: 'Bea Dupont' });
    await click(app, aya.code, { ip: '203.0.113.7' });
    await click(app, aya.code, { ip: '203.0.113.8' });
    await click(app, bea.code, { ip: '203.0.113.7' });
    expect(clicks()).toHaveLength(3);
  });

  it('last click wins: a new valid click for another influenceuse replaces the cookie', async () => {
    const aya = await seedAffiliate(app);
    const bea = await seedAffiliate(app, { fullName: 'Bea Dupont' });
    const a = refCookieOf(await click(app, aya.code, { ip: '203.0.113.7' }));
    const b = refCookieOf(await click(app, bea.code, { ip: '203.0.113.7' }));
    expect(a).not.toBe(b);
    const rows = clicks();
    expect(verifyRef(app.config, decodeURIComponent(b!.slice(7)))).toBe(rows.find((r) => r.affiliate_user_id === bea.id)!.id);
  });

  it('never stores the raw address: only an HMAC of it, derived from the encryption key', async () => {
    const aya = await seedAffiliate(app);
    await click(app, aya.code, { ip: '203.0.113.77', headers: { Referer: 'https://www.instagram.com/some/path?x=1' } });
    const dump = JSON.stringify(app.db.all('SELECT * FROM affiliate_clicks')) + JSON.stringify(app.db.all('SELECT * FROM audit_log'));
    expect(dump).not.toContain('203.0.113.77');
    const [row] = clicks();
    expect(row!.ip_hash).toBe(hashIp(app.config, '203.0.113.77'));
    expect(row!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    // keyed: another key gives another hash; and it is not the plain sha256/HMAC with the raw key either
    expect(hashIp({ encryptionKey: Buffer.alloc(32, 2) }, '203.0.113.77')).not.toBe(row!.ip_hash);
    expect(createHmac('sha256', app.config.encryptionKey).update('203.0.113.77').digest('hex')).not.toBe(row!.ip_hash);
    expect(row!.referrer_host).toBe('www.instagram.com');
  });

  it('stores only the host of the Referer (never its path or query), and only a clean landing path', async () => {
    const aya = await seedAffiliate(app);
    await click(app, aya.code, { ip: '1.1.1.1', headers: { Referer: 'https://l.facebook.com/l.php?u=secret&token=abc' }, landingPath: '/produit/wet-kiss?ref=AYA001#x' });
    await click(app, aya.code, { ip: '1.1.1.2', headers: { Referer: 'garbage' }, landingPath: '//evil.example/x' });
    await click(app, aya.code, { ip: '1.1.1.3', landingPath: '/a\nb' });
    await click(app, aya.code, { ip: '1.1.1.4' });
    expect(clicks().map((c) => [c.referrer_host, c.landing_path])).toEqual([
      ['l.facebook.com', '/produit/wet-kiss'],
      [null, '/'],
      [null, '/'],
      [null, '/'],
    ]);
    expect(JSON.stringify(app.db.all('SELECT * FROM affiliate_clicks'))).not.toMatch(/secret|token=abc/);
  });

  it('is rate limited to 60 an hour per client address, then 429 with Retry-After and no more clicks', async () => {
    const aya = await seedAffiliate(app);
    for (let i = 0; i < 60; i += 1) expect((await click(app, aya.code, { ip: '198.51.100.9' })).status).toBe(204);
    const limited = await click(app, aya.code, { ip: '198.51.100.9' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect((await click(app, aya.code, { ip: '198.51.100.10' })).status).toBe(204); // another address has its own budget
    app.clock.advance(3_600_001);
    expect((await click(app, aya.code, { ip: '198.51.100.9' })).status).toBe(204);
  });

  it('gives the unidentifiable-client bucket four times the budget and never merges those visitors', async () => {
    const aya = await seedAffiliate(app);
    const headers = { 'X-Forwarded-For': null };
    let ok = 0;
    for (let i = 0; i < 241; i += 1) {
      const res = await app.call('/api/affiliate/click', { body: { code: aya.code }, headers });
      if (res.status === 204) ok += 1;
    }
    expect(ok).toBe(240);
    expect(clicks()).toHaveLength(240);
  });

  it('ignores crawlers and link previews: 204, nothing stored', async () => {
    const aya = await seedAffiliate(app);
    for (const ua of ['Googlebot/2.1', 'facebookexternalhit/1.1', 'WhatsApp/2.23', 'Slackbot-LinkExpanding', 'curl/8.0']) {
      const res = await click(app, aya.code, { headers: { 'User-Agent': ua } });
      expect(res.status).toBe(204);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(clicks()).toHaveLength(0);
    expect(isBotAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1')).toBe(false);
    expect(isBotAgent('Mozilla/5.0 HeadlessChrome/120')).toBe(false);
    expect(isBotAgent(null)).toBe(false);
  });
});

describe('signed cookie', () => {
  const id = '018f0000-0000-7000-8000-000000000001';
  const config = { encryptionKey: Buffer.alloc(32, 1) };

  it('verifies what it signed and nothing else', () => {
    const good = signRef(config, id);
    expect(verifyRef(config, good)).toBe(id);
    const [clickId, mac] = good.split('.') as [string, string];
    expect(verifyRef(config, `${clickId}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`)).toBeNull(); // one character off
    expect(verifyRef(config, `${id.replace(/1$/, '2')}.${mac}`)).toBeNull(); // another click id with the old mac
    expect(verifyRef({ encryptionKey: Buffer.alloc(32, 9) }, good)).toBeNull(); // another secret
    for (const bad of [undefined, null, '', '.', id, `${id}.`, `.${mac}`, `${id}.${mac}.${mac}`, `${id}.short`, `${clickId.toUpperCase()}.${mac}`, 'x'.repeat(500), `${id}.${mac} `, `${id}.${'A'.repeat(43)}`]) {
      expect(verifyRef(config, bad as string | null | undefined), String(bad)).toBeNull();
    }
  });

  it('uses a key of its own (the ip-hash key cannot forge cookies)', () => {
    const forged = `${id}.${createHmac('sha256', app.config.encryptionKey).update(id).digest('base64url')}`;
    expect(verifyRef(app.config, forged)).toBeNull();
  });

  it('reads the dl_ref value from a Cookie header among others, taking the first', () => {
    expect(refCookieValue('a=1; dl_ref=X.Y; b=2')).toBe('X.Y');
    expect(refCookieValue('dl_ref=first; dl_ref=second')).toBe('first');
    expect(refCookieValue('xdl_ref=1; dl_refx=2')).toBeUndefined();
    expect(refCookieValue(null)).toBeUndefined();
    expect(refCookieValue('')).toBeUndefined();
  });

  it('builds the Set-Cookie line', () => {
    expect(refSetCookie({ ...config, cookieSecure: true }, id, 30)).toBe(`dl_ref=${signRef(config, id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000; Secure`);
  });
});

describe('helpers', () => {
  it('referrerHost keeps only a lower-case host', () => {
    expect(referrerHost('https://WWW.Instagram.com/p/abc?x=1')).toBe('www.instagram.com');
    expect(referrerHost('http://localhost:3000/?ref=AYA001')).toBe('localhost');
    expect(referrerHost('not a url')).toBeNull();
    expect(referrerHost('')).toBeNull();
    expect(referrerHost(null)).toBeNull();
    expect(referrerHost('https://' + 'a'.repeat(300) + '.com')).toHaveLength(100);
  });
  it('cleanLandingPath drops query and fragment and refuses odd paths', () => {
    expect(cleanLandingPath('/')).toBe('/');
    expect(cleanLandingPath('/merci?n=1')).toBe('/merci');
    expect(cleanLandingPath('relative')).toBe('/');
    expect(cleanLandingPath('//x')).toBe('/');
    expect(cleanLandingPath('/a\\b')).toBe('/');
    expect(cleanLandingPath('/' + 'a'.repeat(300))).toBe('/');
    expect(cleanLandingPath(5)).toBe('/');
  });
});
