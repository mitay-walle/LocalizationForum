// Кодировки: определение (site/encoding.js), кодирование (src/encoding.ts), выгрузка байт в байт и проверка символов.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as client from '../site/encoding.js';
import { ENCODINGS, decodeBytes, encodeText, encodingSupport, fixXmlDeclaration, unrepresentable } from '../src/encoding.js';

const bytes = (...b: number[]) => new Uint8Array(b);
const cat = (a: number[], b: Buffer) => new Uint8Array([...a, ...b]);

describe('encoding helpers', () => {
  it('client and server lists match', () => {
    expect(client.ENCODINGS).toEqual([...ENCODINGS]);
  });

  it('detects BOMs, valid UTF-8, else legacy single-byte guess', () => {
    expect(client.detectEncoding(cat([0xef, 0xbb, 0xbf], Buffer.from('Привет')))).toBe('utf-8-bom');
    expect(client.detectEncoding(cat([0xff, 0xfe], iconv.encode('Hi', 'utf16le')))).toBe('utf-16le-bom');
    expect(client.detectEncoding(cat([0xfe, 0xff], iconv.encode('Hi', 'utf16be')))).toBe('utf-16be-bom');
    expect(client.detectEncoding(Buffer.from('Привет\r\nмир', 'utf8'))).toBe('utf-8');
    expect(client.detectEncoding(Buffer.from('plain ascii'))).toBe('utf-8');
    expect(client.detectEncoding(iconv.encode('Привет', 'win1251'))).toBe('windows-1252'); // не UTF-8 → догадка, пользователь поправит
    expect(client.detectEncoding(iconv.encode('Café', 'win1252'))).toBe('windows-1252');
    expect(client.detectEncoding(bytes())).toBe('utf-8');
  });

  it('client decodes with the chosen encoding, strips BOM, keeps CRLF', () => {
    expect(client.decodeBytes(iconv.encode('Привет\r\nмир', 'win1251'), 'windows-1251')).toBe('Привет\r\nмир');
    expect(client.decodeBytes(cat([0xef, 0xbb, 0xbf], Buffer.from('Ёж')), 'utf-8-bom')).toBe('Ёж');
    expect(client.decodeBytes(cat([0xff, 0xfe], iconv.encode('Ёж\r\n', 'utf16le')), 'utf-16le-bom')).toBe('Ёж\r\n');
    expect(client.decodeBytes(cat([0xfe, 0xff], iconv.encode('Ёж', 'utf16be')), 'utf-16be-bom')).toBe('Ёж');
    expect(client.decodeBytes(iconv.encode('ｶﾀｶﾅ 日本', 'shift_jis'), 'shift_jis')).toBe('ｶﾀｶﾅ 日本');
  });

  it('server encodes every encoding and round-trips; BOMs written', () => {
    const samples: Record<string, string> = {
      'utf-8': 'Ёж ü 日本', 'utf-8-bom': 'Ёж ü 日本', 'utf-16le-bom': 'Ёж ü 日本', 'utf-16be-bom': 'Ёж ü 日本',
      'windows-1252': 'Café ß', 'windows-1251': 'Ёж ґ', 'windows-1250': 'Łódź č', 'iso-8859-1': 'Café', 'koi8-r': 'Ёжик',
      shift_jis: '日本語', gb18030: '中文 汉字', big5: '中文 漢字', 'euc-kr': '한국어',
    };
    for (const enc of ENCODINGS) {
      const text = `${samples[enc]}\r\nline 2\n`;
      const b = encodeText(text, enc);
      expect(decodeBytes(b, enc), enc).toBe(text);
      expect(client.decodeBytes(b, enc), enc + ' (client)').toBe(text);
    }
    expect([...encodeText('A', 'utf-8-bom')]).toEqual([0xef, 0xbb, 0xbf, 0x41]);
    expect([...encodeText('A', 'utf-16le-bom')]).toEqual([0xff, 0xfe, 0x41, 0]);
    expect([...encodeText('A', 'utf-16be-bom')]).toEqual([0xfe, 0xff, 0, 0x41]);
    expect([...encodeText('Ё', 'windows-1251')]).toEqual([0xa8]);
  });

  it('finds characters that do not fit a legacy encoding', () => {
    expect(unrepresentable('Привет, ёж!', 'windows-1252')).toEqual(['П', 'р', 'и', 'в', 'е', 'т', 'ё', 'ж']);
    expect(unrepresentable('Привет, ёж!', 'windows-1251')).toEqual([]);
    expect(unrepresentable('Ґанок', 'koi8-r')).toEqual(['Ґ']);
    expect(unrepresentable('anything 日本', 'utf-16le-bom')).toEqual([]);
    const sup = encodingSupport(['ru', 'de', 'xx']);
    expect(sup.ru).toEqual(expect.arrayContaining(['windows-1252', 'windows-1250', 'iso-8859-1']));
    expect(sup.ru).not.toContain('windows-1251');
    expect(sup.ru).not.toContain('utf-8');
    expect(sup.de).toContain('windows-1251');
    expect(sup.de).not.toContain('windows-1252');
    expect(sup.xx).toEqual([]);
  });

  it('XML declaration follows the target encoding', () => {
    expect(fixXmlDeclaration('<?xml version="1.0" encoding="utf-8"?>\n<a/>', 'windows-1251')).toBe('<?xml version="1.0" encoding="windows-1251"?>\n<a/>');
    expect(fixXmlDeclaration("<?xml version='1.0' encoding='windows-1252'?><a/>", 'utf-16le-bom')).toBe("<?xml version='1.0' encoding='utf-16'?><a/>");
    expect(fixXmlDeclaration('<a encoding="x"/>', 'utf-8')).toBe('<a encoding="x"/>');
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('encodings through the API', async () => {
  process.env.DATABASE_URL = url;
  Object.assign(process.env, { JWT_SECRET: 'test-secret-test-secret-test-secret', SYNC_TOKEN: 'sync', ADMIN_LOGINS: 'boss', DEV_AUTH: '1', SITE_ORIGINS: 'http://site.test' });
  const { root } = await import('../src/server.js');
  const { db, closeDb } = await import('../src/db.js');
  let owner = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await root.request(`http://api.test/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  // Оригиналы в разных кодировках (gunpoint — файл собирается поверх оригинала, CRLF сохраняются)
  const originals: Record<string, { enc: string; text: string }> = {
    'Scripts/cp1251.gpc': { enc: 'windows-1251', text: 'Bob:\r\nПривет, ёжик.\r\n0' },
    'Scripts/cp1252.gpc': { enc: 'windows-1252', text: 'Bob:\r\nCafé au lait.\r\n0' },
    'Scripts/u16.gpc': { enc: 'utf-16le-bom', text: 'Bob:\r\nHi there.\r\n0' },
    'Scripts/u8bom.gpc': { enc: 'utf-8-bom', text: 'Bob:\r\nHello.\r\n0' },
  };
  const exportBytes = async (lang = 'ru') =>
    Object.fromEntries((await call('GET', `/games/enc/export?lang=${lang}&binary=1`)).json.files.map((f: any) => [f.path, { enc: f.encoding, b: Buffer.from(f.data, 'base64') }]));

  beforeAll(async () => {
    const sql = db();
    await sql.unsafe('drop schema public cascade; create schema public;');
    const dir = join(import.meta.dirname, '..', 'db', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await sql.unsafe(readFileSync(join(dir, f), 'utf8'));
    const r = await root.request('http://api.test/api/auth/dev?login=owner&return=http://site.test/');
    owner = decodeURIComponent(r.headers.get('location')!.split('#token=')[1]);
    expect((await call('POST', '/games', { slug: 'enc', title: 'Enc', format: 'gunpoint', languages: ['ru', 'de'] })).status).toBe(201);
    const files = Object.entries(originals).map(([path, o]) => ({ path, content: o.text, encoding: o.enc }));
    expect((await call('POST', '/games/enc/source', { files })).json).toMatchObject({ added: 4 });
  });
  afterAll(() => closeDb());

  it('stores original encodings; untranslated export is byte-for-byte identical to the originals', async () => {
    const m = (await call('GET', '/games/enc/manage')).json;
    expect(m.fileEncodings).toEqual(expect.arrayContaining([{ encoding: 'windows-1251', files: 1 }, { encoding: 'utf-16le-bom', files: 1 }]));
    expect(m.game.source_encoding).toBeTruthy();
    expect(m.encodingSupport.ru).toContain('windows-1252');
    const out = await exportBytes();
    for (const [path, o] of Object.entries(originals)) {
      expect(out[path].enc, path).toBe(o.enc);
      expect(out[path].b.equals(Buffer.from(encodeText(o.text, o.enc))), path).toBe(true);
    }
    expect([...out['Scripts/u16.gpc'].b.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect([...out['Scripts/u8bom.gpc'].b.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // текстовый экспорт сообщает кодировку каждого файла
    expect((await call('GET', '/games/enc/export?lang=ru')).json.files.find((f: any) => f.path === 'Scripts/cp1251.gpc')).toMatchObject({ encoding: 'windows-1251', content: originals['Scripts/cp1251.gpc'].text });
  });

  it('rejects text with characters the target encoding cannot hold; per-language override fixes it', async () => {
    const strings = (await call('GET', '/games/enc/strings?lang=ru')).json.strings;
    const s1252 = strings.find((s: any) => s.file === 'Scripts/cp1252.gpc');
    const s1251 = strings.find((s: any) => s.file === 'Scripts/cp1251.gpc');
    const bad = await call('POST', `/strings/${s1252.id}/variants`, { lang: 'ru', text: 'Кофе с молоком.' });
    expect(bad.status).toBe(422);
    expect(bad.json.issues[0]).toMatchObject({ level: 'error' });
    expect(bad.json.issues[0].message).toContain('нельзя записать в кодировке windows-1252');
    expect((await call('POST', `/strings/${s1252.id}/approve`, { lang: 'ru', text: 'Кофе.' })).status).toBe(422);
    expect((await call('POST', `/strings/${s1251.id}/approve`, { lang: 'ru', text: 'Здравствуй, ёжик.' })).status).toBe(200); // cp1251 — можно

    expect((await call('POST', '/games/enc/settings', { encodings: { ru: 'bogus' } })).status).toBe(400);
    expect((await call('POST', '/games/enc/settings', { encodings: { xx: 'utf-8' } })).status).toBe(400);
    expect((await call('POST', '/games/enc/settings', { encodings: { ru: 'utf-8-bom', de: '' } })).status).toBe(200);
    expect((await call('GET', '/games/enc')).json.game.encodings).toEqual({ ru: 'utf-8-bom' });
    expect((await call('POST', `/strings/${s1252.id}/approve`, { lang: 'ru', text: 'Кофе.' })).status).toBe(200);

    const out = await exportBytes('ru');
    expect(Object.values(out).every((f: any) => f.enc === 'utf-8-bom')).toBe(true);
    expect(out['Scripts/cp1252.gpc'].b.equals(Buffer.from(encodeText('Bob:\r\nКофе.\r\n0', 'utf-8-bom')))).toBe(true);
    expect(out['Scripts/cp1251.gpc'].b.equals(Buffer.from(encodeText('Bob:\r\nЗдравствуй, ёжик.\r\n0', 'utf-8-bom')))).toBe(true);
    // немецкий остался «как в оригинале»
    const de = await exportBytes('de');
    expect(de['Scripts/cp1251.gpc'].enc).toBe('windows-1251');
    expect(de['Scripts/u16.gpc'].enc).toBe('utf-16le-bom');
  });

  it('RimWorld XML: declaration matches the output encoding', async () => {
    expect((await call('POST', '/games', { slug: 'rwx', title: 'RWX', format: 'rimworld', languages: ['ru'] })).status).toBe(201);
    const xml = '<?xml version="1.0" encoding="utf-8"?>\r\n<LanguageData>\r\n  <Hello>Café</Hello>\r\n</LanguageData>\r\n';
    await call('POST', '/games/rwx/source', { files: [{ path: 'Core/Keyed/A.xml', content: xml, encoding: 'windows-1252' }] });
    expect((await call('POST', '/games/rwx/settings', { encodings: { ru: 'windows-1251' } })).status).toBe(200);
    const f = (await call('GET', '/games/rwx/export?lang=ru&binary=1')).json.files[0];
    expect(f.encoding).toBe('windows-1251');
    expect(iconv.decode(Buffer.from(f.data, 'base64'), 'win1251')).toContain('encoding="windows-1251"');
  });
});
