#!/usr/bin/env node
// Связь репо игры с форумом. Без зависимостей, Node 20+.
//
//   node scripts/forum.mjs import                          — отправить source/ на форум
//   node scripts/forum.mjs import-translation ru [--overwrite] — загрузить готовый перевод из ru/
//   node scripts/forum.mjs export                          — забрать утверждённые переводы во все папки языков
//   node scripts/forum.mjs credits ru                      — титры для заметок к релизу (Markdown)
//
// Переменные окружения: FORUM_API_URL (например https://xxx.vercel.app), FORUM_SYNC_TOKEN.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const api = (process.env.FORUM_API_URL || '').replace(/\/$/, '') + '/api';
const token = process.env.FORUM_SYNC_TOKEN || '';
const game = JSON.parse(await readFile(join(root, 'game.json'), 'utf8'));
game.repo = process.env.GITHUB_REPOSITORY || game.repo;
const BATCH_BYTES = 3_000_000; // лимит тела запроса Vercel ~4.5 МБ

if (!process.env.FORUM_API_URL) fail('Не задан FORUM_API_URL (Settings → Secrets and variables → Actions → Variables)');

function fail(msg) {
  console.error('✖', msg);
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(api + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Sync-Token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok) fail(`${method} ${path}: ${res.status} ${data.error || ''}`);
  return data;
}

async function walk(dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

async function readTree(dir) {
  const files = [];
  for (const p of await walk(dir)) {
    files.push({ path: relative(dir, p).replace(/\\/g, '/'), content: await readFile(p, 'utf8') });
  }
  return files;
}

function batches(files) {
  const out = [[]];
  let size = 0;
  for (const f of files) {
    const s = Buffer.byteLength(f.content) + f.path.length + 32;
    if (size + s > BATCH_BYTES && out.at(-1).length) { out.push([]); size = 0; }
    out.at(-1).push(f);
    size += s;
  }
  return out;
}

async function loadRules() {
  const rules = {};
  for (const lang of game.languages) {
    try { rules[lang] = JSON.parse(await readFile(join(root, 'rules', `${lang}.json`), 'utf8')); } catch {}
  }
  return rules;
}

const [cmd, arg, flag] = process.argv.slice(2);

if (cmd === 'import') {
  const files = await readTree(join(root, 'source'));
  const rules = await loadRules();
  const total = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  for (const batch of batches(files)) {
    const r = await call('POST', '/admin/import', { game, rules, files: batch });
    for (const k of Object.keys(total)) total[k] += r[k];
    for (const e of r.errors) console.warn('⚠', e);
  }
  const fin = await call('POST', '/admin/import/finish', { slug: game.slug, paths: files.map((f) => f.path) });
  total.removed += fin.removed;
  console.log(`Исходники: новых ${total.added}, изменено ${total.changed}, удалено ${total.removed}, без изменений ${total.unchanged}`);
} else if (cmd === 'import-translation') {
  if (!game.languages.includes(arg)) fail(`Язык ${arg} не указан в game.json`);
  const files = await readTree(join(root, arg));
  let imported = 0, skipped = 0, unknown = 0;
  for (const batch of batches(files)) {
    const r = await call('POST', '/admin/import', { game, rules: await loadRules(), files: batch, lang: arg, overwrite: flag === '--overwrite' });
    imported += r.imported; skipped += r.skipped; unknown += r.unknown;
  }
  console.log(`Перевод ${arg}: загружено ${imported}, уже были утверждены ${skipped}, нет в исходниках ${unknown}`);
} else if (cmd === 'export') {
  for (const lang of game.languages) {
    const r = await call('GET', `/games/${game.slug}/export?lang=${lang}`);
    for (const f of r.files) {
      const p = join(root, lang, f.path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, f.content);
    }
    console.log(`${lang}: ${r.translated}/${r.total} строк, файлов ${r.files.length}`);
  }
} else if (cmd === 'credits') {
  const r = await call('GET', `/games/${game.slug}/credits?lang=${arg}`);
  const lines = [`## Перевод: ${arg}`, ''];
  if (r.translators.length) {
    lines.push('**Переводчики:**', '');
    for (const t of r.translators) lines.push(`- @${t.login} — ${t.strings}`);
    lines.push('');
  }
  if (r.moderators.length) lines.push(`**Модераторы:** ${r.moderators.map((m) => '@' + m.login).join(', ')}`, '');
  console.log(lines.join('\n'));
} else {
  fail('Команды: import | import-translation <lang> [--overwrite] | export | credits <lang>');
}
