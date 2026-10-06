// Об игре (описание, ссылки, обложка) и добавление/удаление языков. Настоящий Postgres (TEST_DATABASE_URL, база очищается).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('game info and languages', async () => {
  process.env.DATABASE_URL = url;
  Object.assign(process.env, { JWT_SECRET: 'test-secret-test-secret-test-secret', SYNC_TOKEN: 'sync', ADMIN_LOGINS: 'boss', DEV_AUTH: '1', SITE_ORIGINS: 'http://site.test' });
  const { root } = await import('../src/server.js');
  const { db, closeDb } = await import('../src/db.js');

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await root.request(`http://api.test/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const login = async (name: string) => {
    const r = await root.request(`http://api.test/api/auth/dev?login=${name}&return=http://site.test/`);
    return decodeURIComponent(r.headers.get('location')!.split('#token=')[1]);
  };
  let owner = '', stranger = '';
  const base = { slug: 'info', title: 'Info', format: 'json', languages: ['ru'] };
  const steam = { kind: 'steam', url: 'https://store.steampowered.com/app/294860/' };

  beforeAll(async () => {
    const sql = db();
    await sql.unsafe('drop schema public cascade; create schema public;');
    const dir = join(import.meta.dirname, '..', 'db', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await sql.unsafe(readFileSync(join(dir, f), 'utf8'));
    owner = await login('owner');
    stranger = await login('stranger');
  });
  afterAll(() => closeDb());

  it('validates description, links and cover on create', async () => {
    const bad = async (extra: object) => (await call('POST', '/games', owner, { ...base, ...extra })).status;
    expect(await bad({ links: [{ kind: 'bogus', url: 'https://x.test' }] })).toBe(400);
    expect(await bad({ links: [{ kind: 'site', url: 'javascript:alert(1)' }] })).toBe(400);
    expect(await bad({ links: [{ kind: 'site', url: 'ftp://x.test/file' }] })).toBe(400);
    expect(await bad({ links: [{ kind: 'site', url: 'https://x.test/' + 'a'.repeat(600) }] })).toBe(400);
    expect(await bad({ links: Array.from({ length: 11 }, () => ({ kind: 'other', url: 'https://x.test' })) })).toBe(400);
    expect(await bad({ links: 'https://x.test' })).toBe(400);
    expect(await bad({ cover_url: 'data:image/png;base64,AAAA' })).toBe(400);
    expect(await bad({ description: 'x'.repeat(5001) })).toBe(400);
    expect((await call('GET', '/games')).json.games).toEqual([]); // ничего не создалось

    const desc = 'Стелс-головоломка.\n<b>не HTML</b> ' + 'д'.repeat(400);
    const r = await call('POST', '/games', owner, { ...base, description: desc, links: [steam, { kind: 'site', url: 'http://gunpointgame.com', title: 'Официальный сайт' }] });
    expect(r.status).toBe(201);
    const g = (await call('GET', '/games/info')).json.game;
    expect(g).toMatchObject({ description: desc, cover_url: null, links: [steam, { kind: 'site', url: 'http://gunpointgame.com', title: 'Официальный сайт' }] });
    const list = (await call('GET', '/games')).json.games[0];
    expect(list.description).toHaveLength(300); // на главной — коротко
    expect(list).toMatchObject({ cover_url: null, links: [steam, expect.anything()] });
  });

  it('settings: managers edit info; partial updates keep other fields; empty clears', async () => {
    expect((await call('POST', '/games/info/settings', stranger, { description: 'x' })).status).toBe(403);
    expect((await call('POST', '/games/info/settings', owner, { cover_url: 'https://cdn.test/c.jpg' })).status).toBe(200);
    let g = (await call('GET', '/games/info')).json.game;
    expect(g.cover_url).toBe('https://cdn.test/c.jpg');
    expect(g.links).toHaveLength(2); // не трогали
    expect(g.description).toContain('Стелс');
    expect((await call('POST', '/games/info/settings', owner, { links: [{ kind: 'gog', url: 'https://gog.com/x' }] })).status).toBe(200);
    expect((await call('POST', '/games/info/settings', owner, { links: [{ kind: 'gog', url: 'not a url' }] })).status).toBe(400);
    expect((await call('POST', '/games/info/settings', owner, { description: '  ', cover_url: '' })).status).toBe(200);
    g = (await call('GET', '/games/info')).json.game;
    expect(g).toMatchObject({ description: null, cover_url: null, links: [{ kind: 'gog', url: 'https://gog.com/x' }] });
  });

  it('languages: add, remove, refuse removing a language with approved strings unless force', async () => {
    await call('POST', '/games/info/source', owner, { files: [{ path: 'en.json', content: JSON.stringify({ a: 'Hello', b: 'Bye' }) }] });
    expect((await call('POST', '/games/info/settings', owner, { languages: ['ru', 'en'] })).status).toBe(400); // язык оригинала
    expect((await call('POST', '/games/info/settings', owner, { languages: ['ru', 'bad code'] })).status).toBe(400);
    expect((await call('POST', '/games/info/settings', owner, { languages: ['ru', 'uk', 'pt-BR'] })).status).toBe(200);
    expect((await call('GET', '/games/info')).json.game.languages).toEqual(['ru', 'uk', 'pt-BR']);
    // язык без утверждённых строк убирается сразу
    expect((await call('POST', '/games/info/settings', owner, { languages: ['ru', 'uk'] })).status).toBe(200);

    const s = (await call('GET', '/games/info/strings?lang=uk')).json.strings[0];
    expect((await call('POST', `/strings/${s.id}/approve`, owner, { lang: 'uk', text: 'Привіт' })).status).toBe(200);
    const refused = await call('POST', '/games/info/settings', owner, { languages: ['ru'] });
    expect(refused.status).toBe(422);
    expect(refused.json.error).toContain('uk (1)');
    expect((await call('GET', '/games/info')).json.game.languages).toEqual(['ru', 'uk']);
    expect((await call('POST', '/games/info/settings', owner, { languages: ['ru'], force: true })).status).toBe(200);
    expect((await call('GET', '/games/info')).json.game.languages).toEqual(['ru']);
    // вернули язык — перевод на месте
    expect((await call('POST', '/games/info/settings', owner, { languages: ['ru', 'uk'] })).status).toBe(200);
    expect((await call('GET', '/games/info')).json.stats.find((x: any) => x.lang === 'uk').approved).toBe(1);
  });
});
