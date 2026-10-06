// Интеграционный тест API на настоящем Postgres. Нужен TEST_DATABASE_URL (база будет очищена!).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const fixtures = join(import.meta.dirname, 'fixtures', 'rimworld');

function walk(dir: string): { path: string; content: string }[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [{ path: relative(fixtures, p).replace(/\\/g, '/'), content: readFileSync(p, 'utf8') }];
  });
}

describe.skipIf(!url)('api', async () => {
  process.env.DATABASE_URL = url;
  Object.assign(process.env, {
    JWT_SECRET: 'test-secret-test-secret-test-secret',
    SYNC_TOKEN: 'sync',
    ADMIN_LOGINS: 'boss',
    DEV_AUTH: '1',
    SITE_ORIGINS: 'http://site.test',
  });
  const { app } = await import('../src/app.js');
  const { db, closeDb } = await import('../src/db.js');

  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; sync?: boolean } = {}) => {
    const res = await app.request(`http://api.test/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.sync ? { 'X-Sync-Token': 'sync' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };
  const login = async (name: string) => {
    const r = await app.request(`http://api.test/api/auth/dev?login=${name}&return=http://site.test/`);
    return decodeURIComponent(r.headers.get('location')!.split('#token=')[1]);
  };

  const game = { slug: 'rw', title: 'RW', format: 'rimworld', languages: ['ru'], repo: null };
  let boss = '', alice = '', bob = '';

  beforeAll(async () => {
    const sql = db();
    await sql.unsafe('drop schema public cascade; create schema public;');
    const dir = join(import.meta.dirname, '..', 'db', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await sql.unsafe(readFileSync(join(dir, f), 'utf8'));
    [boss, alice, bob] = [await login('boss'), await login('alice'), await login('bob')];
  });
  afterAll(() => closeDb());

  let strings: any[] = [];
  let carol = '';
  const carolToken = () => carol;

  it('imports source via sync token', async () => {
    expect((await call('POST', '/admin/import', { body: { game, files: [] } })).status).toBe(401);
    const r = await call('POST', '/admin/import', {
      sync: true,
      body: { game, files: walk(fixtures), rules: { ru: [{ pattern: '"', message: 'ёлочки', level: 'warn' }] } },
    });
    expect(r.json).toEqual({ added: 9, changed: 0, removed: 0, unchanged: 0, errors: [] });
    const list = await call('GET', '/games/rw/strings?lang=ru');
    expect(list.json.total).toBe(9);
    strings = list.json.strings;
  });

  it('CORS allows configured site', async () => {
    const r = await app.request('http://api.test/api/games', { headers: { Origin: 'http://site.test' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('http://site.test');
    const bad = await app.request('http://api.test/api/games', { headers: { Origin: 'http://evil.test' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('propose, validate, vote', async () => {
    const starving = strings.find((s) => s.key === 'Starving');
    expect((await call('POST', `/strings/${starving.id}/variants`, { body: { lang: 'ru', text: 'x' } })).status).toBe(401);

    const bad = await call('POST', `/strings/${starving.id}/variants`, { token: alice, body: { lang: 'ru', text: 'Голодает' } });
    expect(bad.status).toBe(422);
    expect(bad.json.issues[0].message).toContain('{PAWN_nameDef}');

    const ok = await call('POST', `/strings/${starving.id}/variants`, { token: alice, body: { lang: 'ru', text: '{PAWN_nameDef} голодает и "нуждается" в еде' } });
    expect(ok.status).toBe(201);
    expect(ok.json.issues).toEqual([{ level: 'warn', message: 'ёлочки' }]);
    const ok2 = await call('POST', `/strings/${starving.id}/variants`, { token: bob, body: { lang: 'ru', text: '{PAWN_nameDef} умирает от голода' } });
    expect((await call('POST', `/strings/${starving.id}/variants`, { token: bob, body: { lang: 'ru', text: '{PAWN_nameDef} умирает от голода' } })).status).toBe(422);

    expect((await call('POST', `/variants/${ok2.json.id}/vote`, { token: alice })).json).toEqual({ votes: 1, mine: true, cleared: [] });
    expect((await call('POST', `/variants/${ok2.json.id}/vote`, { token: alice })).json).toEqual({ votes: 1, mine: true, cleared: [] });
    expect((await call('POST', `/variants/${ok2.json.id}/vote`, { token: bob })).json.votes).toBe(2);
    expect((await call('DELETE', `/variants/${ok2.json.id}/vote`, { token: bob })).json).toEqual({ votes: 1, mine: false });

    const view = await call('GET', `/games/rw/strings?lang=ru&filter=voting`, { token: alice });
    expect(view.json.total).toBe(1);
    expect(view.json.canModerate).toBe(false);
    expect(view.json.strings[0].variants.map((v: any) => [v.author, v.votes, v.mine])).toEqual([
      ['bob', 1, true],
      ['alice', 0, false],
    ]);
    expect((await call('DELETE', `/variants/${ok.json.id}`, { token: bob })).status).toBe(403);
  });

  it('one vote per string+lang: voting for another variant moves the vote', async () => {
    const s = strings.find((x) => x.key === 'BreakRiskMinor') ?? strings.find((x) => x.key !== 'Starving');
    const text = s.source; // оригинал проходит проверку плейсхолдеров
    const a = await call('POST', `/strings/${s.id}/variants`, { token: alice, body: { lang: 'ru', text } });
    const b = await call('POST', `/strings/${s.id}/variants`, { token: alice, body: { lang: 'ru', text: text + ' (B)' } });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((await call('POST', `/variants/${a.json.id}/vote`, { token: bob })).json).toEqual({ votes: 1, mine: true, cleared: [] });
    expect((await call('POST', `/variants/${a.json.id}/vote`, { token: alice })).json).toEqual({ votes: 2, mine: true, cleared: [] });
    // bob переголосовывает за B — голос с A снимается, голос alice за A остаётся
    expect((await call('POST', `/variants/${b.json.id}/vote`, { token: bob })).json).toEqual({ votes: 1, mine: true, cleared: [a.json.id] });
    const votesOf = async (token: string) =>
      Object.fromEntries((await call('GET', `/games/rw/strings?lang=ru&q=${encodeURIComponent(s.key)}`, { token })).json.strings.find((x: any) => x.id === s.id).variants.map((v: any) => [v.id, [v.votes, v.mine]]));
    expect(await votesOf(bob)).toEqual({ [a.json.id]: [1, false], [b.json.id]: [1, true] });
    // голос за вариант другой строки не трогает голоса этой строки
    const starving = strings.find((x) => x.key === 'Starving');
    const other = (await call('GET', `/games/rw/strings?lang=ru&q=Starving`, { token: bob })).json.strings.find((x: any) => x.id === starving.id).variants[0];
    expect((await call('POST', `/variants/${other.id}/vote`, { token: bob })).json.cleared).toEqual([]);
    expect(await votesOf(bob)).toEqual({ [a.json.id]: [1, false], [b.json.id]: [1, true] });
    // отмена (как в интерфейсе): снять новый голос и вернуть прежний
    await call('DELETE', `/variants/${b.json.id}/vote`, { token: bob });
    expect((await call('POST', `/variants/${a.json.id}/vote`, { token: bob })).json).toEqual({ votes: 2, mine: true, cleared: [] });
    expect(await votesOf(bob)).toEqual({ [a.json.id]: [2, true], [b.json.id]: [0, false] });
    // убрать за собой, чтобы не влиять на следующие тесты (статистика voting)
    await call('DELETE', `/variants/${other.id}/vote`, { token: bob });
    await call('DELETE', `/variants/${a.json.id}`, { token: alice });
    await call('DELETE', `/variants/${b.json.id}`, { token: alice });
  });

  it('moderation, export, credits', async () => {
    const starving = (await call('GET', `/games/rw/strings?lang=ru&q=starving`)).json.strings[0];
    const best = starving.variants[0];
    expect((await call('POST', `/strings/${starving.id}/approve`, { token: alice, body: { lang: 'ru', variantId: best.id } })).status).toBe(403);
    expect((await call('POST', '/admin/moderators', { token: boss, body: { game: 'rw', lang: 'ru', login: 'alice' } })).status).toBe(200);
    expect((await call('POST', `/strings/${starving.id}/approve`, { token: alice, body: { lang: 'ru', variantId: best.id } })).status).toBe(200);

    // модератор пишет перевод сам, с проверкой
    const label = strings.find((s) => s.key.endsWith('strange_feeling.label'));
    expect((await call('POST', `/strings/${label.id}/approve`, { token: alice, body: { lang: 'ru', text: 'странное ощущение' } })).status).toBe(200);
    const list0 = strings.find((s) => s.key.endsWith('rulesStrings[1]'));
    expect((await call('POST', `/strings/${list0.id}/approve`, { token: boss, body: { lang: 'ru', text: 'adj->Храбрый' } })).status).toBe(200);

    const stats = (await call('GET', '/games/rw')).json.stats;
    expect(stats).toEqual([{ lang: 'ru', approved: 3, stale: 0, voting: 0, total: 9 }]);

    const exp = (await call('GET', '/games/rw/export?lang=ru')).json;
    expect(exp.translated).toBe(3);
    const keyed = exp.files.find((f: any) => f.path === 'Core/Keyed/Alerts.xml').content;
    expect(keyed).toContain('<Starving>{PAWN_nameDef} умирает от голода</Starving>');
    // непереведённые строки выгружаются оригиналом
    expect(keyed).toMatch(/<BreakRiskMinor>[^<]+<\/BreakRiskMinor>/);
    const names = exp.files.find((f: any) => f.path.endsWith('Names.xml')).content;
    expect(names).toContain('<li>r_name-&gt;[adj] [noun]</li>\n    <li>adj-&gt;Храбрый</li>\n    <li>noun-&gt;Wolf</li>');

    expect((await call('GET', '/games/rw/credits?lang=ru')).json).toEqual({ translators: [{ login: 'bob', strings: 1 }], moderators: [{ login: 'alice' }] });
  });

  it('translation stages: open → review → done gate actions', async () => {
    const s = (await call('GET', '/games/rw/strings?lang=ru&filter=untranslated')).json.strings[0];
    const g0 = (await call('GET', '/games/rw', { token: alice })).json;
    expect(g0.status.ru.status).toBe('open');
    expect(g0.moderates).toEqual({ ru: true });
    expect((await call('GET', '/games/rw', { token: bob })).json.moderates).toEqual({ ru: false });

    // менять этап может только модератор языка
    expect((await call('POST', '/games/rw/status', { token: bob, body: { lang: 'ru', status: 'review' } })).status).toBe(403);
    expect((await call('POST', '/games/rw/status', { token: alice, body: { lang: 'ru', status: 'bogus' } })).status).toBe(400);
    expect((await call('POST', '/games/rw/status', { token: alice, body: { lang: 'ru', status: 'review' } })).json).toMatchObject({ ok: true, title: 'Апрув' });
    expect((await call('GET', '/games')).json.games.find((g: any) => g.slug === 'rw').status).toEqual({ ru: 'review' });
    expect((await call('GET', `/games/rw/strings?lang=ru`)).json.status).toBe('review');

    // апрув: участник не предлагает и не голосует, модератор — может
    const text = s.source; // оригинал проходит проверку плейсхолдеров
    expect((await call('POST', `/strings/${s.id}/variants`, { token: bob, body: { lang: 'ru', text } })).status).toBe(403);
    expect((await call('POST', `/strings/${s.id}/variants`, { token: bob, body: { lang: 'ru', text, check: true } })).status).toBe(200);
    const v = await call('POST', `/strings/${s.id}/variants`, { token: alice, body: { lang: 'ru', text } });
    expect(v.status).toBe(201);
    expect((await call('POST', `/variants/${v.json.id}/vote`, { token: bob })).status).toBe(403);
    expect((await call('POST', `/variants/${v.json.id}/vote`, { token: alice })).status).toBe(200);
    expect((await call('POST', `/strings/${s.id}/approve`, { token: alice, body: { lang: 'ru', variantId: v.json.id } })).status).toBe(200);
    const files = (await call('GET', '/games/rw/files?lang=ru')).json.files;
    expect(files.every((f: any) => typeof f.voting === 'number')).toBe(true);

    // готово: заморожено для всех
    await call('POST', '/games/rw/status', { token: alice, body: { lang: 'ru', status: 'done' } });
    expect((await call('DELETE', `/strings/${s.id}/approve?lang=ru`, { token: alice })).status).toBe(403);
    expect((await call('POST', `/strings/${s.id}/variants`, { token: alice, body: { lang: 'ru', text: text + ' ' } })).status).toBe(403);
    expect((await call('DELETE', `/variants/${v.json.id}`, { token: alice })).status).toBe(403);
    expect((await call('DELETE', `/variants/${v.json.id}/vote`, { token: alice })).status).toBe(403);

    // назад к групповому переводу — всё снова открыто
    await call('POST', '/games/rw/status', { token: alice, body: { lang: 'ru', status: 'open' } });
    expect((await call('DELETE', `/strings/${s.id}/approve?lang=ru`, { token: alice })).status).toBe(200);
    expect((await call('DELETE', `/variants/${v.json.id}`, { token: alice })).status).toBe(200);
  });

  it('reimport marks changed translations stale and removes missing files', async () => {
    const files = walk(fixtures).map((f) =>
      f.path.endsWith('Alerts.xml') ? { ...f, content: f.content.replace('is starving &amp; needs food', 'is hungry') } : f,
    );
    const r = await call('POST', '/admin/import', { sync: true, body: { game, files } });
    expect(r.json).toMatchObject({ added: 0, changed: 1, unchanged: 8 });
    const stale = await call('GET', '/games/rw/strings?lang=ru&filter=stale');
    expect(stale.json.strings.map((s: any) => s.key)).toEqual(['Starving']);

    const fin = await call('POST', '/admin/import/finish', { sync: true, body: { slug: 'rw', paths: files.filter((f) => !f.path.includes('RulePackDef')).map((f) => f.path) } });
    expect(fin.json).toEqual({ removed: 3 });
    expect((await call('GET', '/games/rw')).json.stats[0].total).toBe(6);
  });

  it('imports existing translation without overwriting approved', async () => {
    const ru = [{ path: 'Core/Keyed/Alerts.xml', content: '<LanguageData><BreakRiskMinor>Риск срыва</BreakRiskMinor><Starving>ЧУЖОЕ</Starving><Nope>x</Nope></LanguageData>' }];
    const r = await call('POST', '/admin/import', { sync: true, body: { game, lang: 'ru', files: ru } });
    expect(r.json).toEqual({ imported: 1, skipped: 1, unknown: 1, errors: [] });
  });

  it('auth: login redirect is restricted to allowed origins', async () => {
    process.env.GITHUB_CLIENT_ID = 'cid';
    expect((await call('GET', '/auth/login?return=http://evil.test/')).status).toBe(400);
    const r = await app.request('http://api.test/api/auth/login?return=http://site.test/');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?client_id=cid/);
    expect((await call('GET', '/me', { token: 'garbage' })).json).toEqual({ user: null });
    expect((await call('GET', '/me', { token: boss })).json.user).toMatchObject({ login: 'boss', is_admin: true });
  });

  it('site: create game, settings, upload source/translation, moderators', async () => {
    carol = await login('carol');
    const dave = await login('dave');
    const newGame = { slug: 'site-game', title: 'Site Game', format: 'json-nested', sourceLang: 'en', languages: ['ru'] };
    expect((await call('POST', '/games', { body: newGame })).status).toBe(401);
    expect((await call('POST', '/games', { token: carol, body: { ...newGame, slug: 'Bad Slug' } })).status).toBe(400);
    expect((await call('POST', '/games', { token: carol, body: { ...newGame, languages: ['en'] } })).status).toBe(400);
    expect((await call('POST', '/games', { token: carol, body: newGame })).status).toBe(201);
    expect((await call('POST', '/games', { token: dave, body: newGame })).status).toBe(422);

    expect((await call('GET', '/games/site-game', { token: carol })).json.canManage).toBe(true);
    expect((await call('GET', '/games/site-game', { token: dave })).json.canManage).toBe(false);
    expect((await call('GET', '/games/site-game/manage', { token: dave })).status).toBe(403);

    const up = await call('POST', '/games/site-game/source', {
      token: carol,
      body: { files: [{ path: 'en.json', content: JSON.stringify({ menu: { start: 'Start', exit: 'Exit {0}' } }) }, { path: 'x.txt', content: 'ignored' }] },
    });
    expect(up.json).toMatchObject({ added: 2, changed: 0, removed: 0 });

    const st = await call('POST', '/games/site-game/settings', { token: carol, body: { languages: ['ru', 'uk'], title: 'Site Game 2', rules: { uk: [{ pattern: '[', message: 'x' }] } } });
    expect(st.status).toBe(400);
    expect((await call('POST', '/games/site-game/settings', { token: carol, body: { languages: ['ru', 'uk'], title: 'Site Game 2' } })).status).toBe(200);
    const m = (await call('GET', '/games/site-game/manage', { token: carol })).json;
    expect(m.game).toMatchObject({ title: 'Site Game 2', languages: ['ru', 'uk'] });
    expect(m).toMatchObject({ files: 1, strings: 2 });
    expect(m.moderators).toEqual([{ login: 'carol', avatar_url: null, lang: '*' }]);

    const tr = await call('POST', '/games/site-game/translation', { token: carol, body: { lang: 'uk', files: [{ path: 'en.json', content: '{"menu":{"start":"Почати"}}' }] } });
    expect(tr.json).toMatchObject({ imported: 1 });
    const exp = (await call('GET', '/games/site-game/export?lang=uk')).json;
    const uk = JSON.parse(exp.files[0].content);
    expect(uk.menu.start).toBe('Почати');
    expect(Object.keys(uk.menu).length).toBe(2); // вторая строка — оригиналом

    expect((await call('POST', '/games/site-game/moderators', { token: carol, body: { lang: 'ru', login: 'dave' } })).status).toBe(200);
    expect((await call('GET', '/games/site-game/strings?lang=ru', { token: dave })).json.canModerate).toBe(true);
    expect((await call('GET', '/games/site-game/manage', { token: dave })).status).toBe(403);
    expect((await call('POST', '/games/site-game/moderators', { token: carol, body: { lang: '*', login: 'carol', remove: true } })).status).toBe(422);

    // замена всех исходников: файла, которого нет в paths, больше нет
    const rep = await call('POST', '/games/site-game/source', { token: carol, body: { files: [{ path: 'b.json', content: '{"a":"A"}' }], paths: ['b.json'] } });
    expect(rep.json).toMatchObject({ added: 1, removed: 2 });

    expect((await call('DELETE', '/games/site-game', { token: carol })).status).toBe(403);
    expect((await call('DELETE', '/games/site-game', { token: boss })).status).toBe(200);
    expect((await call('GET', '/games/site-game')).status).toBe(404);
  });

  it('formats: presets, custom formats, preview, gunpoint export over original', async () => {
    const erin = await login('erin');
    const list = (await call('GET', '/formats')).json.formats;
    expect(list.map((f: any) => f.slug)).toEqual(expect.arrayContaining(['rimworld', 'json', 'gunpoint', 'properties']));

    const gpc = readFileSync(join(import.meta.dirname, 'fixtures', 'gunpoint', 'Intro.gpc'), 'utf8');
    const prev = await call('POST', '/formats/preview', { token: erin, body: { format: 'gunpoint', path: 'Scripts/Intro.gpc', content: gpc } });
    expect(prev.json).toMatchObject({ matches: true, count: 4, roundTrip: true });
    expect((await call('POST', '/formats/preview', { token: erin, body: { config: { extensions: ['.x'], mode: 'lines', skip: ['['] }, path: 'a.x', content: '' } })).status).toBe(422);

    const cfg = { extensions: ['.dlg'], mode: 'keyValue', text: '^(?<key>\\w+)\\|(?<text>.*)$' };
    expect((await call('POST', '/formats', { token: erin, body: { slug: 'gunpoint', title: 'x', config: cfg } })).status).toBe(422);
    expect((await call('POST', '/formats', { token: erin, body: { slug: 'my-dlg', title: 'Мой .dlg', config: cfg } })).status).toBe(201);
    expect((await call('POST', '/formats/my-dlg', { token: boss, body: { title: 'Мой .dlg v2' } })).status).toBe(200);
    expect((await call('POST', '/formats/my-dlg', { token: carolToken(), body: { title: 'x' } })).status).toBe(403);

    // игра на пользовательском формате
    expect((await call('POST', '/games', { token: erin, body: { slug: 'dlg-game', title: 'DLG', format: 'my-dlg', languages: ['ru'] } })).status).toBe(201);
    const up = await call('POST', '/games/dlg-game/source', { token: erin, body: { files: [{ path: 'a.dlg', content: 'hi|Hello {0}\nbye|Bye' }] } });
    expect(up.json).toMatchObject({ added: 2 });

    // Gunpoint: перевод собирается поверх оригинала, непереведённое остаётся оригиналом
    expect((await call('POST', '/games', { token: erin, body: { slug: 'gp', title: 'Gunpoint', format: 'gunpoint', languages: ['ru'] } })).status).toBe(201);
    expect((await call('POST', '/games/gp/source', { token: erin, body: { files: [{ path: 'Scripts/Intro.gpc', content: gpc }] } })).json).toMatchObject({ added: 4 });
    const strs = (await call('GET', '/games/gp/strings?lang=ru', { token: erin })).json.strings;
    const who = strs.find((x: any) => x.key === 'L2');
    expect(who.context).toBe('Them');
    const bad = await call('POST', `/strings/${who.id}/approve`, { token: erin, body: { lang: 'ru', text: '42' } });
    expect(bad.status).toBe(422);
    expect((await call('POST', `/strings/${who.id}/approve`, { token: erin, body: { lang: 'ru', text: 'Ты кто такой?' } })).status).toBe(200);
    const exp = (await call('GET', '/games/gp/export?lang=ru')).json;
    expect(exp.translated).toBe(1);
    expect(exp.files).toEqual([{ path: 'Scripts/Intro.gpc', content: gpc.replace('Who are you?', 'Ты кто такой?') }]);

    // пересборка строк из сохранённых оригиналов
    const rp = await call('POST', '/games/gp/reparse', { token: erin });
    expect(rp.json).toMatchObject({ added: 0, changed: 0, unchanged: 4, removed: 0 });
    // полная замена исходников удаляет и сохранённые оригиналы
    await call('POST', '/games/gp/source', { token: erin, body: { files: [{ path: 'Scripts/B.gpc', content: 'Me:\r\nYes.\r\n0' }], paths: ['Scripts/B.gpc'] } });
    expect((await call('GET', '/games/gp/export?lang=ru')).json.files).toEqual([{ path: 'Scripts/B.gpc', content: 'Me:\r\nYes.\r\n0' }]);
  });
});
