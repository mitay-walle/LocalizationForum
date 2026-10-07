// Ревизии перевода: архив утверждений, варианты из текстов модераторов, отмена, права, этап. Нужен TEST_DATABASE_URL.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('translation revisions', async () => {
  process.env.DATABASE_URL = url;
  Object.assign(process.env, { JWT_SECRET: 'test-secret-test-secret-test-secret', SYNC_TOKEN: 'sync', ADMIN_LOGINS: 'boss', DEV_AUTH: '1', SITE_ORIGINS: 'http://site.test' });
  const { root } = await import('../src/server.js');
  const { db, closeDb } = await import('../src/db.js');
  const tok: Record<string, string> = {};
  const call = async (who: string | null, method: string, path: string, body?: unknown) => {
    const res = await root.request(`http://api.test/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tok[who]}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const strings = async (lang = 'ru', who: string | null = 'owner') =>
    Object.fromEntries((await call(who, 'GET', `/games/rv/strings?lang=${lang}`)).json.strings.map((s: any) => [s.key, s]));
  const rev = (who: string, body: object) => call(who, 'POST', '/games/rv/revision', body);
  const undo = (who: string, body: object) => call(who, 'POST', '/games/rv/revision/undo', body);

  beforeAll(async () => {
    const sql = db();
    await sql.unsafe('drop schema public cascade; create schema public;');
    const dir = join(import.meta.dirname, '..', 'db', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await sql.unsafe(readFileSync(join(dir, f), 'utf8'));
    for (const n of ['owner', 'mod', 'alice', 'stranger', 'badmod']) {
      const r = await root.request(`http://api.test/api/auth/dev?login=${n}&return=http://site.test/`);
      tok[n] = decodeURIComponent(r.headers.get('location')!.split('#token=')[1]);
    }
    expect((await call('owner', 'POST', '/games', { slug: 'rv', title: 'RV', format: 'json', languages: ['ru', 'uk'] })).status).toBe(201);
    await call('owner', 'POST', '/games/rv/source', { files: [{ path: 'en.json', content: JSON.stringify({ a: 'A', b: 'B', c: 'C' }) }] });
    for (const m of ['mod', 'badmod']) await call('owner', 'POST', '/games/rv/moderators', { login: m, lang: 'ru' });
    await call('owner', 'POST', '/games/rv/bans', { login: 'badmod', reason: 'тест' });
    const s = await strings();
    const v = await call('alice', 'POST', `/strings/${s.a.id}/variants`, { lang: 'ru', text: 'А' });
    expect((await call('owner', 'POST', `/strings/${s.a.id}/approve`, { lang: 'ru', variantId: v.json.id })).status).toBe(200);
    expect((await call('owner', 'POST', `/strings/${s.b.id}/approve`, { lang: 'ru', text: 'Бэ' })).status).toBe(200); // текст модератора, без варианта
    expect((await call('owner', 'POST', `/strings/${s.a.id}/approve`, { lang: 'uk', text: 'А-uk' })).status).toBe(200);
  });
  afterAll(() => closeDb());

  it('permissions and validation', async () => {
    expect((await rev('stranger', { lang: 'ru' })).status).toBe(403);
    expect((await rev('alice', { lang: 'ru' })).status).toBe(403);
    expect((await rev('badmod', { lang: 'ru' })).status).toBe(403); // забанен в игре
    expect((await rev('mod', { lang: 'uk' })).status).toBe(403); // модератор только ru
    expect((await rev('mod', { lang: 'xx' })).status).toBe(400);
    expect((await rev('mod', { lang: 'ru', stage: 'done' })).status).toBe(400);
    expect((await call(null, 'POST', '/games/rv/revision', { lang: 'ru' })).status).toBe(401);
    expect((await undo('mod', { lang: 'ru' })).status).toBe(409); // первая ревизия — отменять нечего
  });

  it('new revision archives approvals, keeps texts as variants, clears approvals of that language only', async () => {
    const r = await rev('mod', { lang: 'ru' });
    expect(r.json).toEqual({ revision: 2, archived: 2, stage: 'open', previousStage: 'open' });
    const s = await strings();
    expect(Object.values(s).every((x: any) => x.approved_text === null)).toBe(true);
    // текст модератора стал вариантом от его имени, не ИИ; у обоих бейдж «было утверждено в ревизии 1»
    expect(s.b.variants).toEqual([expect.objectContaining({ text: 'Бэ', author: 'owner', ai: false, was_approved_rev: 1 })]);
    expect(s.a.variants).toEqual([expect.objectContaining({ text: 'А', author: 'alice', was_approved_rev: 1 })]);
    expect(s.c.variants).toEqual([]);
    const g = (await call(null, 'GET', '/games/rv')).json;
    expect(g.status.ru).toMatchObject({ status: 'open', revision: 2 });
    expect(g.status.uk).toMatchObject({ revision: 1 });
    expect(g.stats.find((x: any) => x.lang === 'ru').approved).toBe(0);
    expect(g.stats.find((x: any) => x.lang === 'uk').approved).toBe(1); // другой язык не тронут
    expect((await call(null, 'GET', '/games/rv/strings?lang=ru')).json.revision).toBe(2);
    const [{ n }] = await db()`select count(*)::int as n from approved_history where lang = 'ru' and revision = 1`;
    expect(n).toBe(2);
    // экспорт: без утверждений — текст оригинала
    const exp = (await call(null, 'GET', '/games/rv/export?lang=ru')).json;
    expect(JSON.parse(exp.files[0].content)).toEqual({ a: 'A', b: 'B', c: 'C' });
  });

  it('undo restores the previous approvals and stage; refused (409) once something is approved', async () => {
    const u = await undo('mod', { lang: 'ru' });
    expect(u.json).toEqual({ revision: 1, restored: 2, stage: 'open' });
    let s = await strings();
    expect([s.a.approved_text, s.b.approved_text]).toEqual(['А', 'Бэ']);
    expect(s.b.approved_variant).toBe(s.b.variants[0].id); // привязан к созданному варианту
    const [{ n }] = await db()`select count(*)::int as n from approved_history where lang = 'ru'`;
    expect(n).toBe(0);

    // снова новая ревизия — сразу на «Апрув»; модератор переутверждает одну строку → отменить уже нельзя
    expect((await rev('owner', { lang: 'ru', stage: 'review' })).json).toMatchObject({ revision: 2, archived: 2, stage: 'review', previousStage: 'open' });
    s = await strings();
    expect((await call('mod', 'POST', `/strings/${s.a.id}/approve`, { lang: 'ru', variantId: s.a.variants[0].id })).status).toBe(200);
    const refused = await undo('mod', { lang: 'ru' });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toContain('уже утверждено строк: 1');
  });

  it('stage «Готово» needs an explicit stage for a new revision', async () => {
    await call('mod', 'POST', '/games/rv/status', { lang: 'ru', status: 'done' });
    expect((await rev('mod', { lang: 'ru' })).status).toBe(422);
    const r = await rev('mod', { lang: 'ru', stage: 'open' });
    expect(r.json).toMatchObject({ revision: 3, archived: 1, stage: 'open', previousStage: 'done' });
    // undo со stage возвращает и этап
    expect((await undo('mod', { lang: 'ru', stage: 'done' })).json).toEqual({ revision: 2, restored: 1, stage: 'done' });
    // бейдж показывает последнюю ревизию, в которой текст был утверждён (archive ревизии 1 удалён undo, ревизия 2 вернулась)
    const s = await strings();
    expect(s.a.approved_text).toBe('А');
  });
});
