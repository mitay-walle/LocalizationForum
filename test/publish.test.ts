// Публикация в GitHub на поддельном GitHub API (fetch подменён), настоящая БД (TEST_DATABASE_URL).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('publish to github', async () => {
  process.env.DATABASE_URL = url;
  Object.assign(process.env, { JWT_SECRET: 'test-secret-test-secret-test-secret', DEV_AUTH: '1', ADMIN_LOGINS: '', SITE_ORIGINS: 'http://site.test' });
  const { root } = await import('../src/server.js');
  const { db, closeDb } = await import('../src/db.js');
  const { publishGame } = await import('../src/publish.js');

  const req = (path: string, token: string, method = 'GET', body?: unknown) =>
    root.request(`http://api.test${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

  // --- поддельный GitHub ---
  const repos = new Map<string, any>();
  const log: string[] = [];
  let counter = 0;
  const realFetch = globalThis.fetch;
  const fake = vi.fn(async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const res = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    log.push(`${method} ${u.pathname}`);
    if (u.pathname === '/user') return res(200, { login: 'Mitay-Walle' });
    if (method === 'POST' && u.pathname === '/user/repos') {
      repos.set(`mitay-walle/${body.name}`, { branch: 'main', commit: 'c0', trees: { t0: {} }, commits: { c0: { tree: 't0' } }, releases: [] });
      return res(201, { default_branch: 'main', permissions: { push: true } });
    }
    const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)(.*)$/);
    if (!m) return res(404, { message: 'nope' });
    const r = repos.get(m[1].toLowerCase());
    const rest = m[2];
    if (!r) return res(404, { message: 'Not Found' });
    if (rest === '') return res(200, { default_branch: r.branch, permissions: { push: true } });
    if (rest.startsWith('/git/ref/heads/')) return res(200, { object: { sha: r.commit } });
    if (rest.startsWith('/git/commits/') && method === 'GET') return res(200, { tree: { sha: r.commits[rest.split('/').pop()!].tree } });
    if (rest === '/git/blobs' && method === 'POST') {
      // blob из base64: в «дереве» храним как 'base64:<данные>' — так и сравнивать проще, и видно, что ушли байты
      r.blobs ??= {};
      const sha = 'b' + Buffer.from(body.content).toString('hex').slice(0, 16) + body.content.length;
      r.blobs[sha] = `${body.encoding}:${body.content}`;
      return res(201, { sha });
    }
    if (rest === '/git/trees') {
      const files = { ...r.trees[body.base_tree] };
      for (const e of body.tree) files[e.path] = e.sha ? r.blobs[e.sha] : e.content;
      const same = Object.keys(files).length === Object.keys(r.trees[body.base_tree]).length && Object.entries(files).every(([k, v]) => r.trees[body.base_tree][k] === v);
      if (same) return res(201, { sha: body.base_tree });
      const sha = 't' + ++counter;
      r.trees[sha] = files;
      return res(201, { sha });
    }
    if (rest === '/git/commits' && method === 'POST') {
      const sha = 'c' + ++counter;
      r.commits[sha] = { tree: body.tree, message: body.message };
      return res(201, { sha });
    }
    if (rest.startsWith('/git/refs/heads/')) {
      r.commit = body.sha;
      return res(200, {});
    }
    if (rest === '/releases' && method === 'POST') {
      if (r.releases.some((x: any) => x.tag === body.tag_name)) return res(422, { message: 'exists' });
      r.releases.push({ tag: body.tag_name, body: body.body, assets: [] });
      return res(201, { id: r.releases.length });
    }
    const asset = rest.match(/^\/releases\/(\d+)\/assets$/);
    if (asset) {
      const bytes = new Uint8Array(await (init.body as Blob).arrayBuffer());
      r.releases[Number(asset[1]) - 1].assets.push({ name: u.searchParams.get('name'), size: bytes.length, head: String.fromCharCode(bytes[0], bytes[1]) });
      return res(201, {});
    }
    return res(404, { message: 'unhandled ' + rest });
  });

  let owner = '';
  beforeAll(async () => {
    const sql = db();
    await sql.unsafe('drop schema public cascade; create schema public;');
    const dir = join(import.meta.dirname, '..', 'db', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await sql.unsafe(readFileSync(join(dir, f), 'utf8'));
    const r = await root.request('http://api.test/api/auth/dev?login=owner&return=http://site.test/');
    owner = decodeURIComponent(r.headers.get('location')!.split('#token=')[1]);
    await req('/api/games', owner, 'POST', { slug: 'gp', title: 'Gunpoint', format: 'gunpoint', languages: ['ru'], repo: 'mitay-walle/localization_gunpoint_ru' });
    const gpc = readFileSync(join(import.meta.dirname, 'fixtures', 'gunpoint', 'Intro.gpc'), 'utf8');
    await req('/api/games/gp/source', owner, 'POST', { files: [{ path: 'Scripts/Intro.gpc', content: gpc }] });
    globalThis.fetch = fake as any;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await closeDb();
  });

  const game = async () => (await db()`select id, slug, title, repo, format, source_lang, languages, rules from games where slug = 'gp'`)[0] as any;

  it('creates the repo and commits source + game.json + README even with nothing translated', async () => {
    const r = await publishGame(await game(), 'tok', { site: 'http://site.test/' });
    expect(r).toMatchObject({ created: true, releases: [], repo: 'mitay-walle/localization_gunpoint_ru' });
    const repo = repos.get('mitay-walle/localization_gunpoint_ru');
    const files = repo.trees[repo.commits[repo.commit].tree];
    expect(Object.keys(files).sort()).toEqual(['README.md', 'game.json', 'ru/Scripts/Intro.gpc', 'source/Scripts/Intro.gpc']);
    expect(JSON.parse(files['game.json'])).toMatchObject({ slug: 'gp', format: 'gunpoint', languages: ['ru'] });
    // README для игроков: качать Release, а не исходники; раздел на языке перевода + английский
    const md: string = files['README.md'];
    expect(md).toContain('## Русский');
    expect(md).toContain('## English');
    expect(md).toContain('/releases?q=ru-');
    expect(md).toContain('`gp-ru-<version>.zip`');
    expect(md).toContain('http://site.test/#/g/gp/ru');
    expect(md).toContain('`source/`');
  });

  it('README is regenerated on every publish (overwrites an outdated one)', async () => {
    const repo = repos.get('mitay-walle/localization_gunpoint_ru');
    const head = repo.commits[repo.commit].tree;
    repo.trees[head] = { ...repo.trees[head], 'README.md': 'old hand-made readme' };
    const r = await publishGame(await game(), 'tok', { site: 'http://site.test/' });
    expect(r.commit).not.toBeNull();
    expect(repo.trees[repo.commits[repo.commit].tree]['README.md']).toContain('## Русский');
  });

  it('second publish with no changes makes no commit; with translation + version makes commit and release with zip', async () => {
    const again = await publishGame(await game(), 'tok', { site: 'http://site.test/' });
    expect(again.commit).toBeNull();

    globalThis.fetch = realFetch; // API форума — без подделки
    const strs = await (await req('/api/games/gp/strings?lang=ru', owner)).json();
    const who = strs.strings.find((s: any) => s.key === 'L2');
    expect((await req(`/api/strings/${who.id}/approve`, owner, 'POST', { lang: 'ru', text: 'Ты кто?' })).status).toBe(200);
    globalThis.fetch = fake as any;

    const r = await publishGame(await game(), 'tok', { site: 'http://site.test/', version: '1.0' });
    expect(r.releases).toEqual(['ru-1.0']);
    const repo = repos.get('mitay-walle/localization_gunpoint_ru');
    const files = repo.trees[repo.commits[repo.commit].tree];
    expect(files['ru/Scripts/Intro.gpc']).toContain('Ты кто?');
    expect(files['README.md']).toContain('https://github.com/mitay-walle/localization_gunpoint_ru/releases/latest');
    expect(repo.releases[0].assets[0]).toMatchObject({ name: 'gp-ru-1.0.zip', head: 'PK' });
    expect(repo.releases[0].body).toContain('версия 1.0, ревизия 1'); // номер ревизии в заметках к релизу

    // тег уже есть — публикация не падает, итог по языку: exists
    const dup = await publishGame(await game(), 'tok', { site: 'http://site.test/', version: '1.0' });
    expect(dup.releases).toEqual([]);
    expect(dup.langs).toEqual([{ lang: 'ru', status: 'exists', tag: 'ru-1.0', error: expect.stringMatching(/уже существует/) }]);
  });

  it('publishes only selected languages: other language folders stay untouched; per-language release results', async () => {
    globalThis.fetch = realFetch;
    expect((await req('/api/games/gp/settings', owner, 'POST', { languages: ['ru', 'uk'] })).status).toBe(200);
    const strs = await (await req('/api/games/gp/strings?lang=uk', owner)).json();
    const who = strs.strings.find((s: any) => s.key === 'L2');
    expect((await req(`/api/strings/${who.id}/approve`, owner, 'POST', { lang: 'uk', text: 'Хто ти?' })).status).toBe(200);
    globalThis.fetch = fake as any;

    // в репо папку ru правили вручную — публикация uk не должна её тронуть
    const repo = repos.get('mitay-walle/localization_gunpoint_ru');
    const head = repo.commits[repo.commit].tree;
    repo.trees[head] = { ...repo.trees[head], 'ru/Scripts/Intro.gpc': 'HAND-EDITED', 'ru/extra.txt': 'keep me' };

    const r = await publishGame(await game(), 'tok', { site: 'http://site.test/', version: '2.0', langs: ['uk'] });
    expect(r.releases).toEqual(['uk-2.0']);
    expect(r.langs).toEqual([{ lang: 'uk', status: 'released', tag: 'uk-2.0' }]);
    const files = repo.trees[repo.commits[repo.commit].tree];
    expect(files['uk/Scripts/Intro.gpc']).toContain('Хто ти?');
    expect(files['ru/Scripts/Intro.gpc']).toBe('HAND-EDITED');
    expect(files['ru/extra.txt']).toBe('keep me');
    expect(JSON.parse(files['game.json']).languages).toEqual(['ru', 'uk']);
    expect(repo.commits[repo.commit].message).toContain('uk');
    expect(repo.releases.map((x: any) => x.tag)).toEqual(['ru-1.0', 'uk-2.0']);

    // оба языка, у uk тег 2.0 уже есть: ru выпускается, uk — exists, публикация не падает
    const both = await publishGame(await game(), 'tok', { site: 'http://site.test/', version: '2.0', langs: ['ru', 'uk'] });
    expect(both.releases).toEqual(['ru-2.0']);
    expect(both.langs).toEqual([
      { lang: 'ru', status: 'released', tag: 'ru-2.0' },
      { lang: 'uk', status: 'exists', tag: 'uk-2.0', error: expect.stringMatching(/уже существует/) },
    ]);
    expect(repo.trees[repo.commits[repo.commit].tree]['ru/Scripts/Intro.gpc']).toContain('Ты кто?');

    // без версии — только коммит, по языкам committed; неизвестный/пустой список — ошибка
    expect((await publishGame(await game(), 'tok', { site: 'http://site.test/', langs: ['uk'] })).langs).toEqual([{ lang: 'uk', status: 'committed' }]);
    await expect(publishGame(await game(), 'tok', { site: 'http://site.test/', langs: [] })).rejects.toThrow(/хотя бы один/);
    await expect(publishGame(await game(), 'tok', { site: 'http://site.test/', langs: ['de'] })).rejects.toThrow(/de/);
  });

  it('non-UTF-8 output goes as base64 blobs with exact bytes (target encoding per language)', async () => {
    const { encodeText } = await import('../src/encoding.js');
    globalThis.fetch = realFetch;
    expect((await req('/api/games/gp/settings', owner, 'POST', { encodings: { ru: 'windows-1251', uk: 'utf-16le-bom' } })).status).toBe(200);
    globalThis.fetch = fake as any;
    log.length = 0;
    await publishGame(await game(), 'tok', { site: 'http://site.test/', langs: ['ru', 'uk'] });
    expect(log.filter((x) => x.endsWith('/git/blobs'))).toHaveLength(2);
    const repo = repos.get('mitay-walle/localization_gunpoint_ru');
    const files = repo.trees[repo.commits[repo.commit].tree];
    const ru = String(files['ru/Scripts/Intro.gpc']);
    expect(ru.startsWith('base64:')).toBe(true);
    const ruBytes = Buffer.from(ru.slice(7), 'base64');
    expect(ruBytes.includes(Buffer.from([0xd2, 0xfb]))).toBe(true); // «Ты» в windows-1251
    const uk = Buffer.from(String(files['uk/Scripts/Intro.gpc']).slice(7), 'base64');
    expect([...uk.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(uk.equals(Buffer.from(encodeText(uk.subarray(2).toString('utf16le'), 'utf-16le-bom')))).toBe(true);
    expect(typeof files['source/Scripts/Intro.gpc']).toBe('string'); // оригинал в UTF-8 — обычным текстом
    expect(String(files['source/Scripts/Intro.gpc']).startsWith('base64:')).toBe(false);
    // повторная публикация без изменений — без коммита (блобы детерминированы)
    expect((await publishGame(await game(), 'tok', { site: 'http://site.test/', langs: ['ru', 'uk'] })).commit).toBeNull();
  });

  it('publish/start validates langs and carries them in the OAuth state', async () => {
    globalThis.fetch = realFetch;
    process.env.GITHUB_CLIENT_ID = 'cid';
    const start = (b: object) => req('/api/games/gp/publish/start', owner, 'POST', { return: 'http://site.test/', ...b });
    expect((await start({})).status).toBe(400);
    expect((await start({ langs: [] })).status).toBe(400);
    expect((await start({ langs: ['xx'] })).status).toBe(400);
    const ok = await start({ langs: ['uk'], version: '3.0' });
    expect(ok.status).toBe(200);
    const state = new URL((await ok.json()).url).searchParams.get('state')!;
    expect(JSON.parse(Buffer.from(state.split('.')[1], 'base64url').toString())).toMatchObject({ typ: 'publish', langs: ['uk'], ver: '3.0' });
    globalThis.fetch = fake as any;
  });

  it('refuses to create a repo under another owner', async () => {
    const g = await game();
    await expect(publishGame({ ...g, repo: 'someone-else/x' }, 'tok', { site: 'http://site.test/' })).rejects.toThrow(/someone-else/);
  });
  it('raw files (images) go to source/ and language folders byte-for-byte; game.json carries format_map', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0xff, 0x00]);
    const up = await (await req('/api/games/gp/source', owner, 'POST', { files: [{ path: 'Textures/logo.png', content: '', data: png.toString('base64') }] })).json();
    expect(up).toMatchObject({ raw: 1, formats: { '.png': '-' } });
    const g = (await db()`select id, slug, title, repo, format, format_map, source_lang, languages, rules from games where slug = 'gp'`)[0] as any;
    await publishGame(g, 'tok', { site: 'http://site.test/', langs: ['ru'] });
    const repo = repos.get('mitay-walle/localization_gunpoint_ru');
    const files = repo.trees[repo.commits[repo.commit].tree];
    expect(files['source/Textures/logo.png']).toBe(`base64:${png.toString('base64')}`);
    expect(files['ru/Textures/logo.png']).toBe(`base64:${png.toString('base64')}`);
    expect(JSON.parse(files['game.json']).format_map).toEqual({ '.gpc': 'gunpoint', '.png': '-' });
  });
});
