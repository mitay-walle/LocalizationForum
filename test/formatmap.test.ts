// Форматы по файлам: формат выбирается по расширению (games.format_map), «-» — копировать как есть.
// Смешанная игра .xml + .json + .gpc + .png: разбор, выгрузка байт в байт, проверки по формату файла,
// смена карты + пересчёт с сохранением утверждений, проверка настроек, миграция 010 для старых игр.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extOf, mappedFormat, isMapKey } from '../src/formats/index.js';
import { looksBinary } from '../src/encoding.js';
import * as client from '../site/encoding.js';

const url = process.env.TEST_DATABASE_URL;
const fx = (p: string) => readFileSync(join(import.meta.dirname, 'fixtures', p), 'utf8');

describe('format map helpers', () => {
  it('extension, map lookup, keys', () => {
    expect(extOf('Scripts/A.GPC')).toBe('.gpc');
    expect(extOf('dir.v2/README')).toBe('');
    expect(extOf('.gitignore')).toBe('');
    expect(mappedFormat({ '.xml': 'rimworld', '*': '-' }, 'a/b.XML')).toBe('rimworld');
    expect(mappedFormat({ '.xml': 'rimworld', '*': '-' }, 'a/b.png')).toBe('-');
    expect(mappedFormat({ '.xml': 'rimworld' }, 'a/b.png')).toBeUndefined();
    expect(['.xml', '.tar.gz', '*'].every(isMapKey)).toBe(true);
    expect(['xml', '.XML', '.', '**', '.a b'].some(isMapKey)).toBe(false);
  });

  it('binary detection: server and client agree', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0, 0x42, 0]);
    const text = new TextEncoder().encode('Привет\r\n');
    for (const [b, want] of [[png, true], [utf16, false], [text, false]] as const) {
      expect(looksBinary(b)).toBe(want);
      expect(client.looksBinary(b)).toBe(want);
    }
  });
});

describe.skipIf(!url)('per-file formats', async () => {
  process.env.DATABASE_URL = url;
  Object.assign(process.env, { JWT_SECRET: 'test-secret-test-secret-test-secret', SYNC_TOKEN: 'sync', ADMIN_LOGINS: 'boss', DEV_AUTH: '1' });
  const { app } = await import('../src/app.js');
  const { db, closeDb } = await import('../src/db.js');
  const dir = join(import.meta.dirname, '..', 'db', 'migrations');
  const migrations = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort();

  let owner = '';
  const call = async (method: string, path: string, body?: unknown, token = owner) => {
    const res = await app.request(`http://api.test/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const login = async (name: string) => {
    const r = await app.request(`http://api.test/api/auth/dev?login=${name}&return=http://site.test/`);
    return decodeURIComponent(r.headers.get('location')!.split('#token=')[1]);
  };

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0x00, 0x81]);
  const gpc = fx('gunpoint/Intro.gpc');
  const xml = fx('rimworld/Core/Keyed/Alerts.xml');
  const nested = JSON.stringify({ menu: { start: 'Start', exit: 'Exit {0}' } }, null, 2);
  const DAT = 'opaque\u0001config v1\n'; // неизвестное расширение — как есть

  beforeAll(async () => {
    const sql = db();
    await sql.unsafe('drop schema public cascade; create schema public;');
    // Старая игра до миграции 010: формат на всю игру
    for (const f of migrations.filter((m) => m < '010')) await sql.unsafe(readFileSync(join(dir, f), 'utf8'));
    const [g] = await sql<{ id: number }[]>`insert into games (slug, title, format, languages) values ('legacy', 'Legacy', 'gunpoint', '{ru}') returning id`;
    await sql`insert into source_files (game_id, path, content) values (${g.id}, 'Scripts/Intro.gpc', ${gpc}), (${g.id}, 'Scripts/Outro.GPC', ${gpc})`;
    await sql`insert into strings (game_id, file, key, source, source_hash) values (${g.id}, 'Scripts/Intro.gpc', 'L2', 'Who are you?', 'x'), (${g.id}, 'Old/NoExt', 'L1', 'x', 'x')`;
    await sql`insert into games (slug, title, format, languages) values ('empty', 'Empty', 'json', '{ru}')`;
    for (const f of migrations.filter((m) => m >= '010')) await sql.unsafe(readFileSync(join(dir, f), 'utf8'));
    owner = await login('owner');
  });
  afterAll(() => closeDb());

  it('migration 010 backfills the map and source_files.format from games.format', async () => {
    const rows = await db()<{ slug: string; format_map: Record<string, string> }[]>`select slug, format_map from games order by slug`;
    expect(Object.fromEntries(rows.map((r) => [r.slug, r.format_map]))).toEqual({ empty: {}, legacy: { '.gpc': 'gunpoint' } });
    const sf = await db()<{ format: string }[]>`select distinct format from source_files`;
    expect(sf).toEqual([{ format: 'gunpoint' }]);
    await db()`delete from games`;
  });

  let ids: Record<string, number> = {};
  const mixedFiles = () => [
    { path: 'Keyed/Alerts.xml', content: xml },
    { path: 'Lang/en.json', content: nested },
    { path: 'Scripts/Intro.gpc', content: gpc },
    { path: 'Textures/logo.png', content: '', data: PNG.toString('base64') },
    { path: 'Data/blob.dat', content: '', data: Buffer.from(DAT).toString('base64') },
  ];
  const exportFiles = async (lang = 'ru') => {
    const r = (await call('GET', `/games/mixed/export?lang=${lang}&binary=1`)).json;
    return Object.fromEntries(r.files.map((f: any) => [f.path, Buffer.from(f.data, 'base64')])) as Record<string, Buffer>;
  };
  const loadIds = async () => {
    const all = [];
    for (let page = 1; ; page++) {
      const r = (await call('GET', `/games/mixed/strings?lang=ru&filter=all&page=${page}`)).json;
      all.push(...r.strings);
      if (all.length >= r.total) break;
    }
    ids = Object.fromEntries(all.map((s: any) => [`${s.file}#${s.key}`, s.id]));
  };

  it('upload of a mixed folder: format per extension, unknown → copy as-is', async () => {
    expect((await call('POST', '/games', { slug: 'mixed', title: 'Mixed', languages: ['ru'] })).status).toBe(201);
    const up = await call('POST', '/games/mixed/source', { files: mixedFiles() });
    expect(up.status).toBe(200);
    expect(up.json.formats).toEqual({ '.xml': 'rimworld', '.json': 'json-nested', '.gpc': 'gunpoint', '.png': '-', '.dat': '-' });
    expect(up.json.raw).toBe(2);
    expect(up.json.errors).toEqual([]);

    const g = (await call('GET', '/games/mixed')).json;
    expect(g.game.format_map).toEqual(up.json.formats);
    const byExt = Object.fromEntries(g.formats.map((f: any) => [f.ext, f]));
    expect(byExt['.gpc']).toMatchObject({ format: 'gunpoint', files: 1, strings: 4, parsed: ['gunpoint'] });
    expect(byExt['.json']).toMatchObject({ format: 'json-nested', files: 1, strings: 2 });
    expect(byExt['.png']).toMatchObject({ format: '-', files: 1, strings: 0 });
    expect(byExt['.xml'].strings).toBeGreaterThan(0);
    await loadIds();
    expect(Object.keys(ids).every((k) => !k.startsWith('Textures/') && !k.startsWith('Data/'))).toBe(true);
  });

  it('export: each file in its own format, skeleton and raw files byte-for-byte', async () => {
    const files = await exportFiles();
    expect(Object.keys(files).sort()).toEqual(['Data/blob.dat', 'Keyed/Alerts.xml', 'Lang/en.json', 'Scripts/Intro.gpc', 'Textures/logo.png']);
    expect(files['Scripts/Intro.gpc'].toString('utf8')).toBe(gpc);
    expect(Buffer.compare(files['Textures/logo.png'], PNG)).toBe(0);
    expect(files['Data/blob.dat'].toString('utf8')).toBe(DAT);
    expect(JSON.parse(files['Lang/en.json'].toString('utf8'))).toEqual({ menu: { start: 'Start', exit: 'Exit {0}' } });
    expect(files['Keyed/Alerts.xml'].toString('utf8')).toContain('<BreakRiskMinor>Minor break risk</BreakRiskMinor>');
    // без binary: файлы «как есть» — байтами в data
    const plain = (await call('GET', '/games/mixed/export?lang=ru')).json.files.find((f: any) => f.path === 'Textures/logo.png');
    expect(Buffer.compare(Buffer.from(plain.data, 'base64'), PNG)).toBe(0);
  });

  it('validation uses the format of the string’s own file', async () => {
    const check = (key: string, text: string) => call('POST', `/strings/${ids[key]}/variants`, { lang: 'ru', text, check: true });
    const gp = await check('Scripts/Intro.gpc#L2', 'Кто\nты?');
    expect(gp.json.issues.map((i: any) => i.message)).toContain('В этом формате перевод должен быть в одну строку');
    const js = await check('Lang/en.json#menu.start', 'Начать\nигру');
    expect(js.json.issues.filter((i: any) => i.level === 'error')).toEqual([]);
  });

  it('settings: format_map validation and reparse hint', async () => {
    const set = (format_map: unknown) => call('POST', '/games/mixed/settings', { format_map });
    expect((await set({ xml: 'rimworld' })).status).toBe(400);
    expect((await set({ '.xml': 'nope' })).status).toBe(400);
    expect((await set(['.xml'])).status).toBe(400);
    expect((await call('POST', '/games/mixed/settings', { format_map: { '.xml': 'rimworld' } }, await login('stranger'))).status).toBe(403);
    const map = (await call('GET', '/games/mixed')).json.game.format_map;
    // .GPC → «-» (ключ приводится к нижнему регистру), .dat → построчный текст
    const r = await set({ ...map, '.gpc': undefined, '.GPC': '-', '.dat': 'plain-lines' });
    expect(r.status).toBe(200);
    expect(r.json.format_map).toMatchObject({ '.gpc': '-', '.dat': 'plain-lines' });
    expect(r.json.reparse).toBe(2);
  });

  it('map change + reparse re-extracts strings and keeps approvals where key and source match', async () => {
    const gpKey = 'Scripts/Intro.gpc#L2';
    const jsKey = 'Lang/en.json#menu.start';
    expect((await call('POST', `/strings/${ids[gpKey]}/approve`, { lang: 'ru', text: 'Кто ты?' })).status).toBe(200);
    expect((await call('POST', `/strings/${ids[jsKey]}/approve`, { lang: 'ru', text: 'Начать' })).status).toBe(200);
    // до пересчёта .gpc ещё выгружается с переводом — файл разобран прежним форматом
    expect((await exportFiles())['Scripts/Intro.gpc'].toString('utf8')).toContain('Кто ты?');

    const rp = await call('POST', '/games/mixed/reparse');
    expect(rp.status).toBe(200);
    expect(rp.json).toMatchObject({ removed: 4, added: 1 }); // 4 строки .gpc скрыты, у .dat появилась 1
    let files = await exportFiles();
    expect(files['Scripts/Intro.gpc'].toString('utf8')).toBe(gpc); // как есть
    expect(files['Data/blob.dat'].toString('utf8')).toBe(DAT);
    expect(JSON.parse(files['Lang/en.json'].toString('utf8')).menu.start).toBe('Начать');
    let g = (await call('GET', '/games/mixed')).json;
    expect(g.formats.find((f: any) => f.ext === '.gpc')).toMatchObject({ format: '-', strings: 0, parsed: ['-'] });

    // вернуть .gpc → gunpoint и .json → плоский json: ключи совпадают, утверждения на месте
    const map = g.game.format_map;
    expect((await call('POST', '/games/mixed/settings', { format_map: { ...map, '.gpc': 'gunpoint', '.json': 'json' } })).json.reparse).toBe(2);
    expect((await call('POST', '/games/mixed/reparse')).json).toMatchObject({ removed: 0 });
    files = await exportFiles();
    expect(files['Scripts/Intro.gpc'].toString('utf8')).toBe(gpc.replace('Who are you?', 'Кто ты?'));
    expect(JSON.parse(files['Lang/en.json'].toString('utf8'))).toEqual({ 'menu.start': 'Начать', 'menu.exit': 'Exit {0}' });
    g = (await call('GET', '/games/mixed')).json;
    expect(g.stats[0]).toMatchObject({ approved: 2, stale: 0 });
  });

  it('binary file mapped to a text format stays as-is with a notice; repo import keeps game.json map', async () => {
    const map = (await call('GET', '/games/mixed')).json.game.format_map;
    await call('POST', '/games/mixed/settings', { format_map: { ...map, '.png': 'plain-lines' } });
    const rp = await call('POST', '/games/mixed/reparse');
    expect(rp.json.errors.join('\n')).toContain('Textures/logo.png: двоичный файл');
    expect(Buffer.compare((await exportFiles())['Textures/logo.png'], PNG)).toBe(0);

    // синхронизация из репо игры: game.json со старым полем format и с format_map
    const sync = async (body: unknown) =>
      (await app.request('http://api.test/api/admin/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Token': 'sync' }, body: JSON.stringify(body) })).json() as Promise<any>;
    const r1 = await sync({ game: { slug: 'repo-game', title: 'R', format: 'gunpoint', languages: ['ru'] }, files: [{ path: 'Intro.gpc', content: gpc }, { path: 'a.txt', content: 'Hello' }] });
    expect(r1.formats).toEqual({ '.gpc': 'gunpoint', '.txt': 'plain-lines' });
    const r2 = await sync({ game: { slug: 'repo-game', title: 'R', format_map: { '.txt': '-' }, languages: ['ru'] }, files: [{ path: 'a.txt', content: 'Hello' }] });
    expect(r2).toMatchObject({ removed: 1, raw: 1 });
    const [g] = await db()<{ format: string; format_map: Record<string, string> }[]>`select format, format_map from games where slug = 'repo-game'`;
    expect(g).toEqual({ format: 'gunpoint', format_map: { '.gpc': 'gunpoint', '.txt': '-' } });
  });
  it('originals: list, raw download, delete (one / prefix) to trash, restore with approvals, permissions', async () => {
    const list = (await call('GET', '/games/mixed/source/files')).json;
    expect(list.files.map((f: any) => f.path)).toEqual(['Data/blob.dat', 'Keyed/Alerts.xml', 'Lang/en.json', 'Scripts/Intro.gpc', 'Textures/logo.png']);
    expect(list.files.find((f: any) => f.path === 'Textures/logo.png')).toMatchObject({ format: '-', size: PNG.length, strings: 0 });
    const raw = async (path: string) => {
      const r = await app.request(`http://api.test/api/games/mixed/source/raw?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${owner}` } });
      return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()), cd: r.headers.get('content-disposition') };
    };
    const png = await raw('Textures/logo.png');
    expect(Buffer.compare(png.bytes, PNG)).toBe(0);
    expect(png.cd).toContain('logo.png');
    expect((await raw('Scripts/Intro.gpc')).bytes.toString('utf8')).toBe(gpc);
    expect((await raw('nope')).status).toBe(404);
    // ?file= — основной параметр; на Vercel ?path= занят переписыванием /api/:path* (приходит ещё и path=games/…)
    const viaFile = await app.request(`http://api.test/api/games/mixed/source/raw?file=${encodeURIComponent('Scripts/Intro.gpc')}`, { headers: { Authorization: `Bearer ${owner}` } });
    expect(Buffer.from(await viaFile.arrayBuffer()).toString('utf8')).toBe(gpc);
    const rewritten = await app.request(`http://api.test/api/games/mixed/source/raw?path=games/mixed/source/raw&path=${encodeURIComponent('Scripts/Intro.gpc')}`, { headers: { Authorization: `Bearer ${owner}` } });
    expect(rewritten.status).toBe(200);

    const stranger = await login('stranger2');
    expect((await call('GET', '/games/mixed/source/files', undefined, stranger)).status).toBe(403);
    expect((await call('DELETE', '/games/mixed/source?path=Scripts/Intro.gpc', undefined, stranger)).status).toBe(403);
    expect((await call('POST', '/games/mixed/source/delete', { paths: [] })).status).toBe(400);

    const before = (await call('GET', '/games/mixed')).json.stats[0];
    const del = await call('DELETE', '/games/mixed/source?path=Scripts/Intro.gpc');
    expect(del.json).toEqual({ deleted: ['Scripts/Intro.gpc'], files: 1, strings: 4 });
    expect((await exportFiles())['Scripts/Intro.gpc']).toBeUndefined();
    expect((await call('GET', '/games/mixed')).json.stats[0]).toMatchObject({ total: before.total - 4, approved: before.approved - 1 });
    const pre = await call('POST', '/games/mixed/source/delete', { prefix: 'Textures/' });
    expect(pre.json).toMatchObject({ deleted: ['Textures/logo.png'], files: 1, strings: 0 });
    const files = (await call('GET', '/games/mixed/source/files')).json;
    expect(files.trash.map((t: any) => t.path).sort()).toEqual(['Scripts/Intro.gpc', 'Textures/logo.png']);
    expect(files.trash[0].deleted_by).toBe('owner');

    const back = await call('POST', '/games/mixed/source/restore', { paths: ['Scripts/Intro.gpc', 'Textures/logo.png', 'never/was.txt'] });
    expect(back.json).toMatchObject({ restored: ['Scripts/Intro.gpc', 'Textures/logo.png'], files: 2, strings: 4, skipped: ['never/was.txt'] });
    expect((await call('GET', '/games/mixed')).json.stats[0]).toMatchObject({ total: before.total, approved: before.approved });
    const out = await exportFiles();
    expect(out['Scripts/Intro.gpc'].toString('utf8')).toBe(gpc.replace('Who are you?', 'Кто ты?'));
    expect(Buffer.compare(out['Textures/logo.png'], PNG)).toBe(0);
    expect((await call('GET', '/games/mixed/source/files')).json.trash).toEqual([]);
    // путь, который уже загружен заново, не перезаписывается из корзины
    await call('DELETE', '/games/mixed/source?path=Data/blob.dat');
    await call('POST', '/games/mixed/source', { files: [{ path: 'Data/blob.dat', content: 'new' }] });
    expect((await call('POST', '/games/mixed/source/restore', { paths: ['Data/blob.dat'] })).json).toMatchObject({ files: 0, skipped: ['Data/blob.dat'] });
  });
});
