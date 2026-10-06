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
    if (rest === '/git/trees') {
      const files = { ...r.trees[body.base_tree] };
      for (const e of body.tree) files[e.path] = e.content;
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
    expect(Object.keys(files).sort()).toEqual(['README.md', 'game.json', 'source/Scripts/Intro.gpc']);
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

    await expect(publishGame(await game(), 'tok', { site: 'http://site.test/', version: '1.0' })).rejects.toThrow(/уже существует/);
  });

  it('refuses to create a repo under another owner', async () => {
    const g = await game();
    await expect(publishGame({ ...g, repo: 'someone-else/x' }, 'tok', { site: 'http://site.test/' })).rejects.toThrow(/someone-else/);
  });
});
