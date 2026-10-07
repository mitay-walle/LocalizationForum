#!/usr/bin/env node
// Связь репо игры с форумом. Без зависимостей, Node 20+.
//
//   node scripts/forum.mjs import                          — отправить source/ на форум
//   node scripts/forum.mjs import-translation ru [--overwrite] — загрузить готовый перевод из ru/
//   node scripts/forum.mjs export                          — забрать утверждённые переводы во все папки языков
//   node scripts/forum.mjs credits ru                      — титры для заметок к релизу (Markdown)
//
// Переменные окружения: FORUM_API_URL (например https://xxx.vercel.app), FORUM_SYNC_TOKEN,
// FORUM_SOURCE_ENCODING — кодировка оригиналов, если это не UTF-8 и без BOM (по умолчанию windows-1252).
//
// Формат каждого файла форум выбирает по расширению: game.json → format_map ({".xml": "rimworld", ".png": "-"});
// расширений, которых нет в карте, форум подбирает сам. «-» — файл не переводится и копируется в перевод как есть
// (картинки и прочие двоичные файлы уходят на форум байтами). Поле format — формат по умолчанию для старых game.json.

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

// Кодировка файла: BOM UTF-8/UTF-16, корректный UTF-8 — иначе FORUM_SOURCE_ENCODING или windows-1252 (как на сайте)
function detectEncoding(b) {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8-bom';
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le-bom';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be-bom';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return 'utf-8';
  } catch {
    return process.env.FORUM_SOURCE_ENCODING || 'windows-1252';
  }
}
const DECODER = { 'utf-8-bom': 'utf-8', 'utf-16le-bom': 'utf-16le', 'utf-16be-bom': 'utf-16be' };
const RAW_MAX_BYTES = 3_000_000; // файл «как есть» уходит одним запросом в base64

// Двоичный файл (картинка, звук…): нулевой байт в первых 8 КБ, кроме UTF-16 с BOM — как на сайте
function looksBinary(b) {
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return false;
  for (let i = 0; i < Math.min(b.length, 8192); i++) if (b[i] === 0) return true;
  return false;
}

async function readTree(dir) {
  const files = [];
  for (const p of await walk(dir)) {
    const bytes = await readFile(p);
    const path = relative(dir, p).replace(/\\/g, '/');
    if (looksBinary(bytes)) {
      if (bytes.length > RAW_MAX_BYTES) { console.warn(`⚠ ${path}: больше ${RAW_MAX_BYTES / 1e6} МБ — пропущен`); continue; }
      files.push({ path, content: '', data: bytes.toString('base64') });
      continue;
    }
    const encoding = detectEncoding(bytes);
    const content = new TextDecoder(DECODER[encoding] || encoding).decode(bytes); // переводы строк — как в файле
    files.push({ path, content, encoding });
  }
  return files;
}

function batches(files) {
  const out = [[]];
  let size = 0;
  for (const f of files) {
    const s = (f.data ? f.data.length : Buffer.byteLength(f.content)) + f.path.length + 32;
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
  const total = { added: 0, changed: 0, removed: 0, unchanged: 0, raw: 0 };
  const formats = {};
  for (const batch of batches(files)) {
    const r = await call('POST', '/admin/import', { game, rules, files: batch });
    for (const k of Object.keys(total)) total[k] += r[k] || 0;
    for (const e of r.errors) console.warn('⚠', e);
    Object.assign(formats, r.formats || {});
  }
  for (const [ext, f] of Object.entries(formats))
    console.log(`Новое расширение ${ext} → ${f === '-' ? 'не переводится, копируется как есть' : f} (поменять — format_map в game.json или настройки игры на форуме)`);
  const fin = await call('POST', '/admin/import/finish', { slug: game.slug, paths: files.map((f) => f.path) });
  total.removed += fin.removed;
  console.log(`Исходники: новых ${total.added}, изменено ${total.changed}, удалено ${total.removed}, без изменений ${total.unchanged}, файлов как есть ${total.raw}`);
} else if (cmd === 'import-translation') {
  if (!game.languages.includes(arg)) fail(`Язык ${arg} не указан в game.json`);
  const files = (await readTree(join(root, arg))).filter((f) => !f.data); // картинки и т. п. — не перевод
  let imported = 0, skipped = 0, unknown = 0;
  for (const batch of batches(files)) {
    const r = await call('POST', '/admin/import', { game, rules: await loadRules(), files: batch, lang: arg, overwrite: flag === '--overwrite' });
    imported += r.imported; skipped += r.skipped; unknown += r.unknown;
  }
  console.log(`Перевод ${arg}: загружено ${imported}, уже были утверждены ${skipped}, нет в исходниках ${unknown}`);
} else if (cmd === 'export') {
  for (const lang of game.languages) {
    // binary=1: форум отдаёт готовые байты в нужной кодировке (с BOM, если он есть)
    const r = await call('GET', `/games/${game.slug}/export?lang=${lang}&binary=1`);
    for (const f of r.files) {
      const p = join(root, lang, f.path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, Buffer.from(f.data, 'base64'));
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
