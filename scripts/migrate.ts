// Применяет db/migrations/*.sql по порядку. Запускается при каждом деплое на Vercel (vercel-build).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeDb, db } from '../src/db.js';

if (!process.env.DATABASE_URL) {
  console.log('DATABASE_URL не задан — миграции пропущены');
  process.exit(0);
}

const dir = join(import.meta.dirname, '..', 'db', 'migrations');
const sql = db();
await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  if (done.has(f)) continue;
  const text = await readFile(join(dir, f), 'utf8');
  await sql.begin(async (tx) => {
    await tx.unsafe(text);
    await tx`insert into schema_migrations (name) values (${f})`;
  });
  console.log('applied', f);
}
console.log('migrations up to date');
await closeDb();
