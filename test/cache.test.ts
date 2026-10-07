// Заголовки кэша CDN: анонимное чтение — public s-maxage, с входом или cookie — private, no-store. Нужен TEST_DATABASE_URL.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('CDN cache headers', async () => {
  process.env.DATABASE_URL = url;
  Object.assign(process.env, { JWT_SECRET: 'test-secret-test-secret-test-secret', SYNC_TOKEN: 'sync', ADMIN_LOGINS: 'boss', DEV_AUTH: '1', SITE_ORIGINS: 'http://site.test' });
  const { root } = await import('../src/server.js');
  const { db, closeDb } = await import('../src/db.js');
  const get = (path: string, headers: Record<string, string> = {}) => root.request(`http://api.test/api${path}`, { headers });
  let token = '';
  const PUB = 'public, s-maxage=60, stale-while-revalidate=600';

  beforeAll(async () => {
    const sql = db();
    await sql.unsafe('drop schema public cascade; create schema public;');
    const dir = join(import.meta.dirname, '..', 'db', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await sql.unsafe(readFileSync(join(dir, f), 'utf8'));
    const r = await root.request('http://api.test/api/auth/dev?login=owner&return=http://site.test/');
    token = decodeURIComponent(r.headers.get('location')!.split('#token=')[1]);
    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await root.request('http://api.test/api/games', { method: 'POST', headers: h, body: JSON.stringify({ slug: 'c', title: 'C', format: 'json', languages: ['ru'] }) });
    await root.request('http://api.test/api/games/c/source', { method: 'POST', headers: h, body: JSON.stringify({ files: [{ path: 'en.json', content: '{"a":"A"}' }] }) });
  });
  afterAll(() => closeDb());

  it('anonymous reads are publicly cacheable on the CDN, with Vary: Origin', async () => {
    for (const p of ['/games', '/games/c', '/games/c/files?lang=ru', '/games/c/strings?lang=ru&filter=all', '/games/c/credits?lang=ru', '/formats']) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get('cache-control'), p).toBe(PUB);
      expect(r.headers.get('vary'), p).toMatch(/origin/i);
    }
    expect((await get('/games/c/export?lang=ru')).headers.get('cache-control')).toBe('public, s-maxage=300, stale-while-revalidate=3600');
    // CORS: ответ для разрешённого сайта несёт его origin и Vary: Origin (кэш раздельный по сайтам)
    const cors = await get('/games', { Origin: 'http://site.test' });
    expect(cors.headers.get('access-control-allow-origin')).toBe('http://site.test');
    expect(cors.headers.get('cache-control')).toBe(PUB);
    expect(cors.headers.get('vary')!.toLowerCase().split(',').filter((v) => v.trim() === 'origin')).toHaveLength(1);
  });

  it('authenticated, cookie-carrying and error responses are private', async () => {
    for (const p of ['/games', '/games/c', '/games/c/strings?lang=ru']) {
      expect((await get(p, { Authorization: `Bearer ${token}` })).headers.get('cache-control'), p).toBe('private, no-store');
      expect((await get(p, { Cookie: 'x=1' })).headers.get('cache-control'), p).toBe('private, no-store');
    }
    expect((await get('/games/nope')).headers.get('cache-control')).toBe('private, no-store');
    expect((await get('/games/c/strings?lang=xx')).headers.get('cache-control')).toBe('private, no-store');
    // не публичные чтения и прочие пути — без публичного кэша
    expect((await get('/games/c/manage', { Authorization: `Bearer ${token}` })).headers.get('cache-control')).toBeNull();
    expect((await get('/me')).headers.get('cache-control')).toBeNull();
    expect((await get('/health')).headers.get('cache-control')).toBeNull();
  });
});
