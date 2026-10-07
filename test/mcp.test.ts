// MCP + OAuth + токены на настоящем Postgres (TEST_DATABASE_URL, база очищается).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('mcp + oauth', async () => {
  process.env.DATABASE_URL = url;
  Object.assign(process.env, { JWT_SECRET: 'test-secret-test-secret-test-secret', SYNC_TOKEN: 'sync', ADMIN_LOGINS: 'boss', DEV_AUTH: '1', SITE_ORIGINS: 'http://site.test' });
  const { root } = await import('../src/server.js');
  const { db, closeDb } = await import('../src/db.js');

  const req = (path: string, init: RequestInit = {}) => root.request(`http://api.test${path}`, init);
  const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers });
  const login = async (name: string) => {
    const r = await req(`/api/auth/dev?login=${name}&return=http://site.test/`);
    return decodeURIComponent(r.headers.get('location')!.split('#token=')[1]);
  };
  const rpc = async (token: string | null, method: string, params: unknown = {}, id = 1) =>
    json(
      await req('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }),
    );
  const callTool = async (token: string, name: string, args: unknown) => {
    const r = await rpc(token, 'tools/call', { name, arguments: args });
    const c = r.body.result;
    return { isError: !!c.isError, data: (() => { try { return JSON.parse(c.content[0].text); } catch { return c.content[0].text; } })() };
  };

  let boss = '', ann = '';
  let apiToken = '';

  beforeAll(async () => {
    const sql = db();
    await sql.unsafe('drop schema public cascade; create schema public;');
    const dir = join(import.meta.dirname, '..', 'db', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await sql.unsafe(readFileSync(join(dir, f), 'utf8'));
    boss = await login('boss');
    ann = await login('ann');
    await req('/api/games', { method: 'POST', headers: { Authorization: `Bearer ${boss}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'g', title: 'G', format: 'json', languages: ['ru'] }) });
    await req('/api/games/g/source', {
      method: 'POST',
      headers: { Authorization: `Bearer ${boss}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ path: 'en.json', content: JSON.stringify({ hello: 'Hello {0}', bye: 'Bye' }) }] }),
    });
  });
  afterAll(() => closeDb());

  it('well-known metadata and 401 with resource_metadata', async () => {
    const pr = await json(await req('/.well-known/oauth-protected-resource'));
    expect(pr.body).toMatchObject({ resource: 'http://api.test/api/mcp', authorization_servers: ['http://api.test'] });
    const as = await json(await req('/.well-known/oauth-authorization-server'));
    expect(as.body).toMatchObject({ token_endpoint: 'http://api.test/api/oauth/token', code_challenge_methods_supported: ['S256'] });
    const r = await rpc(null, 'initialize');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata="http://api.test/.well-known/oauth-protected-resource"');
  });

  it('personal tokens: create from session only, list, use, revoke', async () => {
    const created = await json(await req('/api/tokens', { method: 'POST', headers: { Authorization: `Bearer ${ann}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'cursor' }) }));
    expect(created.status).toBe(201);
    apiToken = created.body.token;
    expect(apiToken).toMatch(/^lf_/);
    expect((await req('/api/tokens', { method: 'POST', headers: { Authorization: `Bearer ${apiToken}` } })).status).toBe(403);
    const me = await json(await req('/api/me', { headers: { Authorization: `Bearer ${apiToken}` } }));
    expect(me.body.user.login).toBe('ann');
    const list = await json(await req('/api/tokens', { headers: { Authorization: `Bearer ${ann}` } }));
    expect(list.body.tokens.map((t: any) => t.name)).toEqual(['cursor']);
  });

  it('mcp: initialize, tools/list, read and propose (marked ai), vote, moderator approve', async () => {
    const init = await rpc(apiToken, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe('localization-forum');
    expect(init.body.result.instructions).toContain('ИИ');
    const tools = await rpc(apiToken, 'tools/list');
    expect(tools.body.result.tools.map((t: any) => t.name)).toEqual(
      expect.arrayContaining(['list_games', 'find_strings', 'propose_translations', 'vote', 'approve_translation', 'check_translation']),
    );

    const games = await callTool(apiToken, 'list_games', {});
    expect(games.data[0].slug).toBe('g');
    const found = await callTool(apiToken, 'find_strings', { game: 'g', lang: 'ru' });
    expect(found.data.total).toBe(2);
    const hello = found.data.strings.find((s: any) => s.key === 'hello');

    const chk = await callTool(apiToken, 'check_translation', { string_id: hello.id, lang: 'ru', text: 'Привет' });
    expect(chk.data.issues[0].message).toContain('{0}');

    const prop = await callTool(apiToken, 'propose_translations', { lang: 'ru', items: [{ string_id: hello.id, text: 'Привет, {0}' }, { string_id: hello.id, text: 'Привет' }] });
    expect(prop.data).toMatchObject({ proposed: 1, failed: 1 });
    const vid = prop.data.results[0].variant_id;

    const site = await json(await req('/api/games/g/strings?lang=ru&filter=voting', { headers: { Authorization: `Bearer ${boss}` } }));
    expect(site.body.strings[0].variants[0]).toMatchObject({ text: 'Привет, {0}', author: 'ann', ai: true });

    expect((await callTool(apiToken, 'vote', { variant_id: vid })).data).toEqual({ votes: 1, mine: true, cleared: [] });
    const denied = await callTool(apiToken, 'approve_translation', { string_id: hello.id, lang: 'ru', variant_id: vid });
    expect(denied.isError).toBe(true);
    expect(denied.data).toContain('модератор');
  });

  it('oauth: register → authorize → consent → token (PKCE) → mcp works; bad verifier rejected', async () => {
    const reg = await json(await req('/api/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) }));
    expect(reg.status).toBe(201);
    expect((await req('/api/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.com/cb'] }) })).status).toBe(400);
    const cid = reg.body.client_id;
    const verifier = 'v'.repeat(50);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });
    const auth = await req(`/api/oauth/authorize?${q}&dev_login=boss`);
    expect(auth.status).toBe(302);
    // → dev-вход → редирект на страницу согласия с #token=
    const toLogin = auth.headers.get('location')!;
    const afterLogin = (await req(toLogin.replace('http://api.test', ''))).headers.get('location')!;
    expect(afterLogin).toContain('/api/oauth/consent?req=');
    const [consentUrl, frag] = afterLogin.split('#token=');
    expect((await req(consentUrl.replace('http://api.test', ''))).status).toBe(200);
    const session = decodeURIComponent(frag);
    const reqParam = new URL(consentUrl).searchParams.get('req');
    const approve = await json(await req('/api/oauth/approve', { method: 'POST', headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ req: reqParam, allow: true }) }));
    const back = new URL(approve.body.redirect);
    expect(back.origin + back.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
    expect(back.searchParams.get('state')).toBe('xyz');
    const code = back.searchParams.get('code')!;

    const form = (v: string) => new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: v, client_id: cid, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' });
    const bad = await json(await req('/api/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form('wrong') }));
    expect(bad.body.error).toBe('invalid_grant');
    // код одноразовый: после неудачной попытки он сгорел — проходим поток заново
    const approve2 = await json(await req('/api/oauth/approve', { method: 'POST', headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ req: reqParam, allow: true }) }));
    const code2 = new URL(approve2.body.redirect).searchParams.get('code')!;
    const tok = await json(await req('/api/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: cid }) }));
    expect(tok.body).toMatchObject({ token_type: 'Bearer' });
    const who = await callTool(tok.body.access_token, 'whoami', {});
    expect(who.data.login).toBe('boss');

    // модератор через MCP утверждает ИИ-вариант
    const found = await callTool(tok.body.access_token, 'find_strings', { game: 'g', lang: 'ru', filter: 'voting' });
    const s = found.data.strings[0];
    expect((await callTool(tok.body.access_token, 'approve_translation', { string_id: s.id, lang: 'ru', variant_id: s.variants[0].id })).isError).toBe(false);

    const denied = await json(await req('/api/oauth/approve', { method: 'POST', headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ req: reqParam, allow: false }) }));
    expect(new URL(denied.body.redirect).searchParams.get('error')).toBe('access_denied');
  });

  it('mcp: manage games — create, update info, languages, formats, upload/list/delete/restore files; non-managers denied', async () => {
    const mk = async (session: string) => (await json(await req('/api/tokens', { method: 'POST', headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'mcp' }) }))).body.token;
    const carl = await mk(await login('carl'));
    const dora = await mk(await login('dora'));
    const tools = (await rpc(carl, 'tools/list')).body.result.tools;
    for (const n of ['create_game', 'update_game_info', 'set_format_map', 'reparse_game', 'upload_source_files', 'delete_source_files', 'restore_source_files', 'list_source_files', 'add_language', 'remove_language', 'set_stage'])
      expect(tools.find((t: any) => t.name === n), n).toBeTruthy();
    expect(tools.find((t: any) => t.name === 'delete_source_files').annotations.readOnlyHint).toBe(false);
    expect(tools.find((t: any) => t.name === 'list_source_files').annotations.readOnlyHint).toBe(true);

    const created = await callTool(carl, 'create_game', { slug: 'mcp-game', title: 'MCP Game', source_lang: 'en', languages: ['ru'], description: 'Про игру', links: [{ kind: 'steam', url: 'https://store.steampowered.com/app/1/' }] });
    expect(created).toMatchObject({ isError: false, data: { slug: 'mcp-game' } });
    const upd = await callTool(carl, 'update_game_info', { game: 'mcp-game', title: 'MCP Game 2', cover_url: 'https://example.com/c.jpg' });
    expect(upd.data).toMatchObject({ title: 'MCP Game 2', description: 'Про игру', cover_url: 'https://example.com/c.jpg' });
    expect((await callTool(carl, 'add_language', { game: 'mcp-game', lang: 'uk' })).data).toEqual({ languages: ['ru', 'uk'] });

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]).toString('base64');
    const up = await callTool(carl, 'upload_source_files', {
      game: 'mcp-game',
      files: [{ path: 'Lang/en.json', content: JSON.stringify({ a: 'Hello', b: 'Bye' }) }, { path: 'Scripts/notes.txt', content: 'One\nTwo\n' }, { path: 'logo.png', base64: png }],
    });
    expect(up.data).toMatchObject({ added: 4, raw: 1, formats: { '.json': 'json', '.txt': 'plain-lines', '.png': '-' } });
    const big = await callTool(carl, 'upload_source_files', { game: 'mcp-game', files: [{ path: 'x.txt', content: 'x'.repeat(3_100_000) }] });
    expect(big.isError).toBe(true);
    expect(big.data).toContain('разделите');

    const list = await callTool(carl, 'list_source_files', { game: 'mcp-game' });
    expect(list.data.files.map((f: any) => [f.path, f.format, f.strings])).toEqual([['Lang/en.json', 'json', 2], ['Scripts/notes.txt', 'plain-lines', 2], ['logo.png', '-', 0]]);
    expect(list.data.files.find((f: any) => f.path === 'logo.png').size).toBe(8);

    // утвердить строку, удалить файл, вернуть — утверждение на месте
    const s = (await callTool(carl, 'find_strings', { game: 'mcp-game', lang: 'ru', filter: 'all', file: 'Scripts/notes.txt' })).data.strings[0];
    expect((await callTool(carl, 'approve_translation', { string_id: s.id, lang: 'ru', text: 'Один' })).isError).toBe(false);
    const del = await callTool(carl, 'delete_source_files', { game: 'mcp-game', paths: ['Scripts/notes.txt'] });
    expect(del.data).toMatchObject({ deleted: ['Scripts/notes.txt'], files: 1, strings: 2 });
    expect((await callTool(carl, 'list_source_files', { game: 'mcp-game' })).data.trash.map((t: any) => t.path)).toEqual(['Scripts/notes.txt']);
    expect((await callTool(carl, 'get_game', { game: 'mcp-game' })).data.stats.find((x: any) => x.lang === 'ru')).toMatchObject({ total: 2, approved: 0 });
    const res = await callTool(carl, 'restore_source_files', { game: 'mcp-game', paths: ['Scripts/notes.txt'] });
    expect(res.data).toMatchObject({ restored: ['Scripts/notes.txt'], strings: 2, skipped: [] });
    expect((await callTool(carl, 'get_game', { game: 'mcp-game' })).data.stats.find((x: any) => x.lang === 'ru')).toMatchObject({ total: 4, approved: 1 });

    expect((await callTool(carl, 'set_format_map', { game: 'mcp-game', format_map: { '.json': 'json', '.txt': '-', '.png': '-' } })).data).toMatchObject({ reparse: 1 });
    expect((await callTool(carl, 'reparse_game', { game: 'mcp-game' })).data).toMatchObject({ removed: 2 });
    expect((await callTool(carl, 'set_format_map', { game: 'mcp-game', format_map: { txt: 'x' } })).isError).toBe(true);

    // чужой игрой управлять нельзя
    for (const [name, args] of [
      ['update_game_info', { game: 'mcp-game', title: 'hack' }],
      ['upload_source_files', { game: 'mcp-game', files: [{ path: 'a.txt', content: 'A' }] }],
      ['delete_source_files', { game: 'mcp-game', paths: ['Lang/en.json'] }],
      ['restore_source_files', { game: 'mcp-game', paths: ['Lang/en.json'] }],
      ['list_source_files', { game: 'mcp-game' }],
      ['add_language', { game: 'mcp-game', lang: 'de' }],
      ['set_format_map', { game: 'mcp-game', format_map: {} }],
      ['reparse_game', { game: 'mcp-game' }],
    ] as const) {
      const r = await callTool(dora, name, args);
      expect(r.isError, name).toBe(true);
      expect(String(r.data), name).toContain('Управлять игрой');
    }
    expect((await callTool(carl, 'remove_language', { game: 'mcp-game', lang: 'ru' })).isError).toBe(true); // есть утверждённый перевод
    expect((await callTool(carl, 'remove_language', { game: 'mcp-game', lang: 'uk' })).data).toEqual({ languages: ['ru'] });
  });

  it('mcp: upload_translation_files — propose (ai variants, unchanged skipped, base64) and approve (managers only)', async () => {
    const mk = async (session: string) => (await json(await req('/api/tokens', { method: 'POST', headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'mcp' }) }))).body.token;
    const owner = await mk(await login('tina'));
    const guest = await mk(await login('gus'));
    expect((await callTool(owner, 'create_game', { slug: 'tr-game', title: 'TR', source_lang: 'en', languages: ['ru'] })).isError).toBe(false);
    await callTool(owner, 'upload_source_files', { game: 'tr-game', files: [{ path: 'en.json', content: JSON.stringify({ a: 'Hello', b: 'Bye', c: 'Name' }) }] });
    const tools = (await rpc(owner, 'tools/list')).body.result.tools;
    expect(tools.find((t: any) => t.name === 'upload_translation_files')).toBeTruthy();

    // гость: как варианты ИИ; c совпадает с оригиналом — пропущена; файл байтами
    const ru = Buffer.from(JSON.stringify({ a: 'Привет', b: 'Пока', c: 'Name' }), 'utf8').toString('base64');
    const p = await callTool(guest, 'upload_translation_files', { game: 'tr-game', lang: 'ru', files: [{ path: 'en.json', base64: ru }] });
    expect(p.data).toMatchObject({ proposed: 2, unchanged: 1, rejected: 0, limited: 0 });
    const strs = (await callTool(guest, 'find_strings', { game: 'tr-game', lang: 'ru', filter: 'voting' })).data.strings;
    expect(strs.length).toBe(2);
    expect(strs.every((s: any) => s.variants[0].ai === true)).toBe(true);
    // повтор — дубликаты не плодятся
    expect((await callTool(guest, 'upload_translation_files', { game: 'tr-game', lang: 'ru', files: [{ path: 'en.json', base64: ru }] })).data).toMatchObject({ proposed: 0, duplicates: 2 });

    // утвердить сразу может только управляющий
    const denied = await callTool(guest, 'upload_translation_files', { game: 'tr-game', lang: 'ru', mode: 'approve', files: [{ path: 'en.json', content: '{"a":"Х"}' }] });
    expect(denied.isError).toBe(true);
    const ap = await callTool(owner, 'upload_translation_files', { game: 'tr-game', lang: 'ru', mode: 'approve', files: [{ path: 'en.json', content: JSON.stringify({ a: 'Привет', b: 'Bye' }) }] });
    expect(ap.data).toMatchObject({ imported: 1, unchanged: 1 });
    expect((await callTool(owner, 'get_game', { game: 'tr-game' })).data.stats.find((x: any) => x.lang === 'ru')).toMatchObject({ approved: 1, total: 3 });
  });

  it('token via ?token= query and revocation', async () => {
    const r = await req(`/api/mcp?token=${apiToken}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    expect(r.status).toBe(200);
    const list = await json(await req('/api/tokens', { headers: { Authorization: `Bearer ${ann}` } }));
    await req(`/api/tokens/${list.body.tokens[0].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ann}` } });
    expect((await rpc(apiToken, 'tools/list')).status).toBe(401);
  });
});
