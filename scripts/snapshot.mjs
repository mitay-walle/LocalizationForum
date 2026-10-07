#!/usr/bin/env node
// Снимок форума только для чтения — для зеркала на GitHub Pages, когда API (Vercel/Neon) недоступен.
// Node 20+, без зависимостей. Запросы анонимные (их кэширует CDN Vercel), последовательные, с паузой и повторами.
//
//   FORUM_API=https://localization-forum.vercel.app/api node scripts/snapshot.mjs [выходная папка = site/data]
//   (или FORUM_API_URL=https://localization-forum.vercel.app — без /api)
//
// Структура (минифицированный JSON, те же ответы, что отдаёт API анониму):
//   meta.json                                  {generatedAt, api, games}
//   games.json                                 GET /games
//   formats.json                               GET /formats
//   games/<slug>.json                          GET /games/:slug
//   games/<slug>/files/<lang>.json             GET /games/:slug/files?lang=
//   games/<slug>/credits/<lang>.json           GET /games/:slug/credits?lang=
//   games/<slug>/strings/<lang>/<page>.json    GET /games/:slug/strings?lang=&filter=all&page=  (с total и pageSize)
//
// Снимок пишется во временную папку и подменяет старый только целиком. При ошибке — код выхода 1:
// шаг workflow падает, и на Pages остаётся прошлая (рабочая) публикация.
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// FORUM_API — адрес с /api; FORUM_API_URL — адрес сайта API без /api (как в переменной репозитория для config.js)
const API = (
  process.env.FORUM_API ||
  (process.env.FORUM_API_URL ? process.env.FORUM_API_URL.replace(/\/$/, '') + '/api' : 'https://localization-forum.vercel.app/api')
).replace(/\/$/, '');
const OUT = resolve(process.argv[2] || process.env.SNAPSHOT_DIR || 'site/data');
const TMP = `${OUT}.tmp-${process.pid}`;
const DELAY_MS = Number(process.env.SNAPSHOT_DELAY_MS ?? 120);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;

async function get(path) {
  for (let attempt = 1; ; attempt++) {
    await sleep(DELAY_MS);
    requests++;
    try {
      const res = await fetch(API + path, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return await res.json();
      // 4xx (кроме 429) повторять бессмысленно
      if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`${path}: HTTP ${res.status}`), { fatal: true });
      throw new Error(`${path}: HTTP ${res.status}`);
    } catch (e) {
      if (e.fatal || attempt >= 4) throw e;
      console.warn(`повтор ${attempt}: ${e.message}`);
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function save(rel, data) {
  const file = join(TMP, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data));
}

const seg = (s) => encodeURIComponent(s);

try {
  await rm(TMP, { recursive: true, force: true });
  const { games } = await get('/games');
  await save('games.json', { games });
  await save('formats.json', await get('/formats'));
  let strings = 0;
  for (const g of games) {
    const slug = seg(g.slug);
    const detail = await get(`/games/${slug}`);
    await save(`games/${slug}.json`, detail);
    for (const lang of detail.game.languages) {
      const l = seg(lang);
      await save(`games/${slug}/files/${l}.json`, await get(`/games/${slug}/files?lang=${l}`));
      await save(`games/${slug}/credits/${l}.json`, await get(`/games/${slug}/credits?lang=${l}`));
      for (let page = 1, pages = 1; page <= pages; page++) {
        const d = await get(`/games/${slug}/strings?lang=${l}&filter=all&page=${page}`);
        pages = Math.max(1, Math.ceil(d.total / d.pageSize));
        strings += d.strings.length;
        await save(`games/${slug}/strings/${l}/${page}.json`, d);
      }
    }
    console.log(`${g.slug}: ${detail.game.languages.join(', ')}`);
  }
  await save('meta.json', { generatedAt: new Date().toISOString(), api: API, games: games.length });
  await rm(OUT, { recursive: true, force: true });
  await mkdir(dirname(OUT), { recursive: true });
  await rename(TMP, OUT);
  console.log(`Снимок готов: ${OUT} — игр ${games.length}, строк ${strings}, запросов ${requests}`);
} catch (e) {
  await rm(TMP, { recursive: true, force: true });
  console.error(`✖ Снимок не получен: ${e.message}`);
  process.exit(1);
}
