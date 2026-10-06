// Антиспам: лимиты на варианты и баны. Настоящий Postgres (TEST_DATABASE_URL, база очищается).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('limits and bans', async () => {
  process.env.DATABASE_URL = url;
  Object.assign(process.env, { JWT_SECRET: 'test-secret-test-secret-test-secret', SYNC_TOKEN: 'sync', ADMIN_LOGINS: 'boss', DEV_AUTH: '1', SITE_ORIGINS: 'http://site.test' });
  const { root } = await import('../src/server.js');
  const { db, closeDb } = await import('../src/db.js');

  const call = async (method: string, path: string, token?: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await root.request(`http://api.test/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const login = async (name: string) => {
    const r = await root.request(`http://api.test/api/auth/dev?login=${name}&return=http://site.test/`);
    return decodeURIComponent(r.headers.get('location')!.split('#token=')[1]);
  };
  const tok: Record<string, string> = {};
  const ids: Record<string, number> = {};
  const propose = (who: string, key: string, text: string) => call('POST', `/strings/${ids[key]}/variants`, tok[who], { lang: 'ru', text });
  const setLimits = (l: { perUser?: number; perString?: number; perHour?: number }) => {
    for (const [k, v] of [['VARIANTS_PER_USER_STRING', l.perUser], ['VARIANTS_PER_STRING', l.perString], ['VARIANTS_PER_HOUR', l.perHour]] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = String(v);
  };

  beforeAll(async () => {
    const sql = db();
    await sql.unsafe('drop schema public cascade; create schema public;');
    const dir = join(import.meta.dirname, '..', 'db', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await sql.unsafe(readFileSync(join(dir, f), 'utf8'));
    for (const n of ['boss', 'owner', 'mod', 'spammer', 'eve', 'other']) tok[n] = await login(n);
    expect((await call('POST', '/games', tok.owner, { slug: 'm', title: 'M', format: 'json', languages: ['ru'] })).status).toBe(201);
    const src = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, `Text ${i}`]));
    await call('POST', '/games/m/source', tok.owner, { files: [{ path: 'en.json', content: JSON.stringify(src) }] });
    expect((await call('POST', '/games/m/moderators', tok.owner, { login: 'mod', lang: 'ru' })).status).toBe(200);
    for (const s of (await call('GET', '/games/m/strings?lang=ru')).json.strings) ids[s.key] = s.id;
  });
  afterAll(async () => {
    setLimits({});
    await closeDb();
  });

  it('limits: per user per string (422), per string total (422), per hour (429); moderators exempt', async () => {
    setLimits({});
    expect((await call('GET', '/games/m/strings?lang=ru')).json.limits).toEqual({ perUserString: 3, perString: 30, perHour: 500 });

    for (const i of [1, 2, 3]) expect((await propose('spammer', 'k0', `spam ${i}`)).status).toBe(201);
    const fourth = await propose('spammer', 'k0', 'spam 4');
    expect(fourth.status).toBe(422);
    expect(fourth.json.error).toContain('максимум вариантов для этой строки (3)');
    // модератор языка — без лимитов
    for (const i of [1, 2, 3, 4]) expect((await propose('mod', 'k0', `mod ${i}`)).status).toBe(201);

    setLimits({ perString: 8 }); // у k0 уже 7
    expect((await propose('eve', 'k0', 'eve 1')).status).toBe(201);
    const full = await propose('other', 'k0', 'other 1');
    expect(full.status).toBe(422);
    expect(full.json.error).toContain('У этой строки уже максимум вариантов (8)');
    expect((await propose('mod', 'k0', 'mod 5')).status).toBe(201);
    expect((await propose('owner', 'k0', 'owner 1')).status).toBe(201); // управляющий игрой — тоже модератор

    setLimits({ perHour: 5 }); // у spammer уже 3 за час
    expect((await propose('spammer', 'k1', 'spam k1 a')).status).toBe(201);
    expect((await propose('spammer', 'k1', 'spam k1 b')).status).toBe(201);
    const rate = await propose('spammer', 'k2', 'spam k2');
    expect(rate.status).toBe(429);
    expect(rate.json.error).toContain('лимит 5');
    for (const i of [6, 7]) expect((await propose('mod', 'k2', `mod k2 ${i}`)).status).toBe(201);

    setLimits({ perUser: 0, perString: 0, perHour: 0 }); // 0 — без лимита
    expect((await propose('spammer', 'k0', 'spam 4')).status).toBe(201);
    await db()`delete from variants where text = 'spam 4'`;
    setLimits({});
  });

  it('bans: who can ban, effect on actions, purge keeps approved texts', async () => {
    // spammer: k0 ×3, k1 ×2; один вариант утверждаем — он должен пережить purge
    const k1 = (await call('GET', `/games/m/strings?lang=ru&q=k1`, tok.owner)).json.strings.find((s: any) => s.key === 'k1');
    const keep = k1.variants.find((v: any) => v.text === 'spam k1 a');
    expect((await call('POST', `/strings/${ids.k1}/approve`, tok.owner, { lang: 'ru', variantId: keep.id })).status).toBe(200);
    // голос spammer за чужой вариант
    const k0 = (await call('GET', `/games/m/strings?lang=ru&q=k0`, tok.spammer)).json.strings.find((s: any) => s.key === 'k0');
    const modVariant = k0.variants.find((v: any) => v.text === 'mod 1');
    expect((await call('POST', `/variants/${modVariant.id}/vote`, tok.spammer)).status).toBe(200);

    const ban = { login: 'spammer', reason: 'спам вариантами', days: 7, purge: true };
    expect((await call('POST', '/games/m/bans', tok.eve, ban)).status).toBe(403); // не управляющий
    expect((await call('POST', '/games/m/bans', tok.mod, ban)).status).toBe(403); // модератор языка — не управляющий
    expect((await call('POST', '/games/m/bans', tok.owner, { ...ban, login: 'boss' })).status).toBe(403); // админа — только админ
    expect((await call('POST', '/games/m/bans', tok.owner, { ...ban, login: 'owner' })).status).toBe(422);
    expect((await call('POST', '/games/m/bans', tok.owner, { ...ban, reason: '' })).status).toBe(400);
    expect((await call('POST', '/games/m/bans', tok.owner, { ...ban, days: -1 })).status).toBe(400);
    const r = await call('POST', '/games/m/bans', tok.owner, ban);
    expect(r.status).toBe(201);
    expect(r.json.purged).toEqual({ variants: 4, votes: 1 });
    expect(new Date(r.json.until).getTime()).toBeGreaterThan(Date.now() + 6.9 * 864e5);

    const after = (await call('GET', `/games/m/strings?lang=ru&q=k1`)).json.strings.find((s: any) => s.key === 'k1');
    expect(after.approved_text).toBe('spam k1 a');
    expect(after.variants.map((v: any) => v.text)).toEqual(['spam k1 a']);

    const list = (await call('GET', '/games/m/bans', tok.owner)).json.bans;
    expect(list).toMatchObject([{ login: 'spammer', reason: 'спам вариантами', by: 'owner', game: 'm' }]);
    expect((await call('GET', '/games/m/bans', tok.mod)).status).toBe(403);

    // эффект: читать можно, менять — нет
    const p = await propose('spammer', 'k3', 'снова спам');
    expect(p.status).toBe(403);
    expect(p.json.error).toContain('спам вариантами');
    expect(p.json.error).toMatch(/до \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    expect((await call('POST', `/variants/${modVariant.id}/vote`, tok.spammer)).status).toBe(403);
    expect((await call('DELETE', `/variants/${keep.id}`, tok.spammer)).status).toBe(403);
    expect((await call('GET', '/games/m/strings?lang=ru', tok.spammer)).status).toBe(200);
    expect((await call('GET', '/games/m', tok.spammer)).json.ban).toMatchObject({ game: 'm', reason: 'спам вариантами' });
    expect((await call('GET', '/me', tok.spammer)).json.bans).toMatchObject([{ game: 'm', reason: 'спам вариантами' }]);
    // бан в игре не мешает в других местах
    expect((await call('POST', '/games', tok.spammer, { slug: 'sp', title: 'SP', format: 'json', languages: ['ru'] })).status).toBe(201);
    expect((await call('GET', '/games/m', tok.eve)).json.ban).toBeNull();
  });

  it('bans: expiry and unban', async () => {
    await db()`update bans set until = now() - interval '1 minute' where user_id = (select id from users where login = 'spammer')`;
    expect((await call('GET', '/me', tok.spammer)).json.bans).toEqual([]);
    expect((await propose('spammer', 'k3', 'после бана')).status).toBe(201);
    expect((await call('GET', '/games/m/bans', tok.owner)).json.bans).toEqual([]);

    expect((await call('POST', '/games/m/bans', tok.owner, { login: 'other', reason: 'тест' })).status).toBe(201); // бессрочно
    expect((await call('GET', '/games/m/bans', tok.owner)).json.bans[0].until).toBeNull();
    expect((await propose('other', 'k4', 'x')).status).toBe(403);
    expect((await call('DELETE', '/games/m/bans?login=other', tok.mod)).status).toBe(403);
    expect((await call('DELETE', '/games/m/bans?login=other', tok.owner)).json).toEqual({ ok: true, removed: 1 });
    expect((await call('DELETE', '/games/m/bans?login=other', tok.owner)).status).toBe(404);
    expect((await propose('other', 'k4', 'x')).status).toBe(201);
  });

  it('global bans: admin only, block everything incl. creating games and MCP writes; purge everywhere', async () => {
    const g = { login: 'eve', reason: 'вандализм', purge: true };
    expect((await call('POST', '/admin/bans', tok.owner, g)).status).toBe(403);
    expect((await call('GET', '/admin/bans', tok.owner)).status).toBe(403);
    // токен для MCP выдаём до бана
    const apiToken = (await call('POST', '/tokens', tok.eve, { name: 'mcp' })).json.token;

    const r = await call('POST', '/admin/bans', tok.boss, g);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ until: null, purged: { variants: 1 } }); // eve 1 на k0
    expect((await call('GET', '/admin/bans', tok.boss)).json.bans).toMatchObject([{ login: 'eve', game: null, by: 'boss' }]);
    expect((await call('GET', '/me', tok.eve)).json.bans).toMatchObject([{ game: null, reason: 'вандализм' }]);

    const created = await call('POST', '/games', tok.eve, { slug: 'eve-game', title: 'E', format: 'json', languages: ['ru'] });
    expect(created.status).toBe(403);
    expect(created.json.error).toContain('на форуме');
    expect((await propose('eve', 'k5', 'x')).status).toBe(403);
    expect((await call('POST', '/formats', tok.eve, { slug: 'eve-fmt', title: 'x', config: { extensions: ['.x'], mode: 'lines' } })).status).toBe(403);
    expect((await call('GET', '/games/m', tok.eve)).json.ban).toMatchObject({ game: null });

    // MCP-инструменты записи идут через тот же API — тоже запрещены
    const mcp = await root.request('http://api.test/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose_translations', arguments: { lang: 'ru', items: [{ string_id: ids.k5, text: 'x' }] } } }),
    });
    const res = JSON.parse((await mcp.json()).result.content[0].text);
    expect(res).toMatchObject({ proposed: 0, failed: 1 });
    expect(res.results[0].error).toContain('вандализм');

    // админ банит в игре тоже, а управляющий не может снять глобальный бан
    expect((await call('DELETE', '/games/m/bans?login=eve', tok.owner)).status).toBe(404);
    expect((await call('DELETE', '/admin/bans?login=eve', tok.boss)).json).toEqual({ ok: true, removed: 1 });
    expect((await call('POST', '/games', tok.eve, { slug: 'eve-game', title: 'E', format: 'json', languages: ['ru'] })).status).toBe(201);
  });
});
