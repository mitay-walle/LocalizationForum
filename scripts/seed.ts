// Демо-данные для локальной разработки: две игры из test/fixtures.  npm run seed
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { closeDb, db } from '../src/db.js';
import { importSource, type Game, type InFile } from '../src/sync.js';

try {
  process.loadEnvFile('.env');
} catch {}

async function walk(dir: string, root = dir): Promise<InFile[]> {
  const out: InFile[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, root)));
    else out.push({ path: relative(root, p).replace(/\\/g, '/'), content: await readFile(p, 'utf8') });
  }
  return out;
}

const ruRules = [
  { pattern: '\\s-\\s', message: 'Вместо дефиса между словами нужно длинное тире —', level: 'warn' },
  { pattern: '"', message: 'Используйте кавычки-ёлочки «»', level: 'warn' },
];

const fixtures = join(import.meta.dirname, '..', 'test', 'fixtures');
const games = [
  { slug: 'demo-rimworld', title: 'Demo (формат RimWorld)', format: 'rimworld', languages: ['ru', 'uk'], dir: 'rimworld' },
  { slug: 'demo-json', title: 'Demo (JSON)', format: 'json-nested', languages: ['ru'], dir: 'json' },
];

for (const g of games) {
  const [row] = await db()<Game[]>`
    insert into games (slug, title, format, languages, rules)
    values (${g.slug}, ${g.title}, ${g.format}, ${g.languages}, ${db().json({ ru: ruRules } as never)})
    on conflict (slug) do update set title = excluded.title, rules = excluded.rules
    returning id, slug, title, repo, format, source_lang, languages, rules`;
  console.log(g.slug, await importSource(row, await walk(join(fixtures, g.dir))));
}
await closeDb();
