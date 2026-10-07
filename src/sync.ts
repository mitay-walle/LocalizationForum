import { createHash } from 'node:crypto';
import { db } from './db.js';
import { PASSTHROUGH, extOf, fileFormat, mappedFormat, resolveFormat, suggestFormat, type Format, type OutString } from './formats/index.js';
import { decodeBytes, detectEncoding, fixXmlDeclaration, isEncoding, looksBinary } from './encoding.js';

export interface InFile {
  path: string;
  content: string;
  /** Кодировка исходного файла (определяет браузер); по умолчанию utf-8 */
  encoding?: string;
  /** Байты файла (base64 или Uint8Array) — для файлов «как есть» (картинки и т. п.); тогда content пустой */
  data?: string | Uint8Array | null;
}

/** Файл перевода к выгрузке: текст и кодировка, в которой его нужно записать, либо готовые байты (data). */
export interface OutFile {
  path: string;
  content: string;
  encoding: string;
  data?: Uint8Array;
}

/** Байты файла к выгрузке. */
export const outBytes = (f: OutFile, encode: (text: string, enc: string) => Uint8Array) => f.data ?? encode(f.content, f.encoding);

export interface Game {
  id: number;
  slug: string;
  title: string;
  repo: string | null;
  format: string;
  source_lang: string;
  languages: string[];
  rules: Record<string, unknown>;
  /** {".xml": "rimworld", ".png": "-"} — формат по расширению; "-" — копировать как есть */
  format_map?: Record<string, string>;
  description?: string | null;
  links?: GameLink[];
  cover_url?: string | null;
  /** {язык: кодировка выгрузки}; нет языка — как в оригинале */
  encodings?: Record<string, string>;
  source_encoding?: string | null;
}

export type LinkKind = 'steam' | 'site' | 'gog' | 'itch' | 'other';
export interface GameLink {
  kind: LinkKind;
  url: string;
  title?: string;
}

export const hashSource = (s: string) => createHash('sha1').update(s).digest('hex');
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.?\//, '');

const toBytes = (d: string | Uint8Array) => (typeof d === 'string' ? new Uint8Array(Buffer.from(d, 'base64')) : d);

/** Кэш форматов на время одной операции (пользовательские форматы читаются из БД). */
function formatCache() {
  const cache = new Map<string, Promise<Format | null>>();
  return (slug: string) => {
    if (!cache.has(slug)) cache.set(slug, resolveFormat(slug));
    return cache.get(slug)!;
  };
}

/** Предел файла «как есть»: тело запроса на Vercel ≤ ~4.5 МБ, а байты идут в base64 (+33%). */
export const RAW_MAX_BYTES = 3_000_000;

interface Prepared {
  path: string;
  format: string; // slug или PASSTHROUGH
  content: string;
  encoding: string;
  data: Uint8Array | null; // байты PASSTHROUGH-файлов, пришедших байтами (картинки и т. п.)
}

/**
 * Определить формат каждого файла по карте игры: расширение → формат («*» — для остальных).
 * Нового расширения в карте нет — подбираем по объявленным расширениям форматов (формат игры по умолчанию первым)
 * и дописываем в карту; никто не нашёл строк — «-»: файл хранится и копируется в выгрузку без перевода.
 * Файлы без расширения (и без «*») — формат игры по умолчанию, если он задан.
 */
async function prepareFiles(game: Game, files: InFile[]) {
  const [g] = await db()<{ format: string; format_map: Record<string, string> }[]>`select format, format_map from games where id = ${game.id}`;
  const map: Record<string, string> = { ...(g?.format_map ?? {}) };
  const added: Record<string, string> = {};
  const errors: string[] = [];
  const items = files.map((f) => {
    const path = norm(f.path);
    const bytes = f.data != null ? toBytes(f.data) : null;
    // текст файла: пришёл текстом, или байты, которые не похожи на двоичные (тогда кодировка — по байтам)
    const binary = !!bytes && looksBinary(bytes);
    const encoding = bytes ? (binary ? 'binary' : detectEncoding(bytes)) : isEncoding(f.encoding) ? f.encoding : 'utf-8';
    const text = bytes ? (binary ? null : decodeBytes(bytes, encoding)) : (f.content ?? '');
    return { path, ext: extOf(path), bytes, encoding, text };
  });

  // Новые расширения — подобрать формат по образцам из этой пачки
  if (map['*'] === undefined) {
    const fresh = new Map<string, { path: string; text: string }[]>();
    for (const it of items) {
      if (!it.ext || it.ext in map) continue;
      if (!fresh.has(it.ext)) fresh.set(it.ext, []);
      if (it.text !== null) fresh.get(it.ext)!.push({ path: it.path, text: it.text });
    }
    for (const [ext, samples] of fresh) {
      const slug = samples.length ? await suggestFormat(ext, samples, g?.format || null) : null;
      map[ext] = added[ext] = slug ?? PASSTHROUGH;
    }
  }

  const out: Prepared[] = [];
  for (const it of items) {
    let slug = mappedFormat(map, it.path) ?? (g?.format || PASSTHROUGH);
    if (slug !== PASSTHROUGH && it.text === null) {
      errors.push(`${it.path}: двоичный файл, а для «${it.ext || it.path}» выбран формат ${slug} — файл сохранён как есть`);
      slug = PASSTHROUGH;
    }
    if (slug !== PASSTHROUGH) {
      out.push({ path: it.path, format: slug, content: it.text!, encoding: it.encoding, data: null });
    } else if (it.bytes) {
      if (it.bytes.length > RAW_MAX_BYTES) {
        errors.push(`${it.path}: файл больше ${RAW_MAX_BYTES / 1_000_000} МБ — не сохранён`);
        continue;
      }
      out.push({ path: it.path, format: PASSTHROUGH, content: '', encoding: it.encoding === 'binary' ? 'binary' : it.encoding, data: it.bytes });
    } else {
      // текст «как есть»: выгружается в своей кодировке без изменений
      out.push({ path: it.path, format: PASSTHROUGH, content: it.text ?? '', encoding: it.encoding, data: null });
    }
  }
  if (Object.keys(added).length) await db()`update games set format_map = format_map || ${db().json(added as never)} where id = ${game.id}`;
  return { files: out, added, errors };
}

async function parsePrepared(files: Prepared[]) {
  const fmt = formatCache();
  const parsed: { file: string; key: string; source: string; context: string | null; position: number }[] = [];
  const errors: string[] = [];
  for (const f of files) {
    if (f.format === PASSTHROUGH) continue;
    const format = await fmt(f.format);
    if (!format) {
      errors.push(`${f.path}: неизвестный формат ${f.format}`);
      continue;
    }
    try {
      format.parse(f.path, f.content).forEach((s, i) =>
        parsed.push({ file: f.path, key: s.key, source: s.source, context: s.context ?? null, position: i }),
      );
    } catch (e) {
      errors.push(`${f.path}: ${(e as Error).message}`);
    }
  }
  return { parsed, errors };
}

/**
 * Импорт исходников игры. Формат каждого файла — по расширению (карта форматов игры).
 * Новые строки добавляются, изменённые обновляются (их переводы становятся «устаревшими» через source_hash),
 * пропавшие помечаются removed. Файлы без формата хранятся и выгружаются как есть.
 */
export async function importSource(game: Game, files: InFile[]) {
  const prep = await prepareFiles(game, files);
  const { parsed, errors } = await parsePrepared(prep.files);
  errors.unshift(...prep.errors);
  const raw = prep.files.filter((f) => f.format === PASSTHROUGH).length;

  const sql = db();
  return sql.begin(async (tx) => {
    // Храним оригиналы целиком (текст — как есть, без нормализации переводов строк; кодировка и формат — рядом):
    // построчные форматы собирают перевод поверх них, «как есть» копируются в выгрузку, «Опубликовать» кладёт их в source/.
    {
      const originals = prep.files.map((f) => ({ game_id: game.id, path: f.path, content: f.content, encoding: f.encoding, format: f.format, data: f.data ? Buffer.from(f.data) : null }));
      for (let i = 0; i < originals.length; i += 200) {
        await tx`insert into source_files ${tx(originals.slice(i, i + 200), 'game_id', 'path', 'content', 'encoding', 'format', 'data')}
          on conflict (game_id, path) do update set content = excluded.content, encoding = excluded.encoding,
            format = excluded.format, data = excluded.data, updated_at = now()`;
      }
      await tx`update games set source_encoding = (
        select encoding from source_files where game_id = ${game.id} and data is null group by encoding order by count(*) desc, encoding limit 1)
        where id = ${game.id}`;
    }
    const existing = await tx<{ id: number; file: string; key: string; source_hash: string; removed: boolean }[]>`
      select id, file, key, source_hash, removed from strings where game_id = ${game.id}`;
    const byKey = new Map(existing.map((r) => [`${r.file}\u0000${r.key}`, r]));

    let added = 0, changed = 0, unchanged = 0;
    const seen = new Set<string>();
    const rows = parsed
      .filter((p) => {
        const k = `${p.file}\u0000${p.key}`;
        if (seen.has(k)) return false; // дубликат ключа в файле — берём первый
        seen.add(k);
        return true;
      })
      .map((p) => {
        const h = hashSource(p.source);
        const old = byKey.get(`${p.file}\u0000${p.key}`);
        if (!old) added++;
        else if (old.source_hash !== h) changed++;
        else unchanged++;
        return { game_id: game.id, file: p.file, key: p.key, source: p.source, context: p.context, source_hash: h, position: p.position };
      });

    for (let i = 0; i < rows.length; i += 1000) {
      const batch = rows.slice(i, i + 1000);
      await tx`
        insert into strings ${tx(batch, 'game_id', 'file', 'key', 'source', 'context', 'source_hash', 'position')}
        on conflict (game_id, file, key) do update set
          source = excluded.source,
          context = excluded.context,
          position = excluded.position,
          removed = false,
          updated_at = case when strings.source_hash <> excluded.source_hash or strings.removed then now() else strings.updated_at end,
          source_hash = excluded.source_hash`;
    }

    // Удалёнными считаем только строки из файлов этой пачки; пропавшие файлы целиком — в finalizeSource.
    const batchFiles = new Set(prep.files.map((f) => f.path));
    const gone = existing
      .filter((r) => !r.removed && batchFiles.has(r.file) && !seen.has(`${r.file}\u0000${r.key}`))
      .map((r) => r.id);
    if (gone.length) await tx`update strings set removed = true, updated_at = now() where id = any(${gone})`;
    await tx`update games set updated_at = now() where id = ${game.id}`;

    // formats — расширения, впервые попавшие в карту (и какой формат им назначен); raw — файлов «как есть»
    return { added, changed, removed: gone.length, unchanged, errors, formats: prep.added, raw };
  });
}

/** После загрузки всех пачек: строки из файлов, которых больше нет в source/, помечаются removed. */
export async function finalizeSource(game: Game, paths: string[]) {
  const keep = paths.map(norm);
  const res = await db()`
    update strings set removed = true, updated_at = now()
    where game_id = ${game.id} and not removed and not (file = any(${keep}))`;
  // пропавшие оригиналы — в корзину (их можно вернуть 30 дней, см. restoreSource)
  await db()`
    insert into source_files_trash (game_id, path, content, encoding, format, data)
    select game_id, path, content, encoding, format, data from source_files where game_id = ${game.id} and not (path = any(${keep}))
    on conflict (game_id, path) do update set content = excluded.content, encoding = excluded.encoding, format = excluded.format,
      data = excluded.data, deleted_by = null, deleted_at = now()`;
  await db()`delete from source_files where game_id = ${game.id} and not (path = any(${keep}))`;
  return { removed: res.count };
}

/** Сколько дней удалённые оригиналы лежат в корзине. */
export const TRASH_DAYS = 30;

/**
 * Удалить оригиналы: файлы уходят в корзину (source_files_trash), их строки помечаются removed —
 * как при пропаже файла из полной загрузки; варианты и утверждения остаются и вернутся вместе с файлом.
 * prefix — все файлы, чей путь начинается с него (папка).
 */
export async function deleteSource(game: Game, sel: { paths?: string[]; prefix?: string }, userId: number | null) {
  const sql = db();
  return sql.begin(async (tx) => {
    await tx`delete from source_files_trash where deleted_at < now() - make_interval(days => ${TRASH_DAYS})`;
    const paths = sel.prefix !== undefined
      ? (await tx<{ path: string }[]>`
          select path from source_files where game_id = ${game.id} and starts_with(path, ${sel.prefix})
          union select distinct file from strings where game_id = ${game.id} and not removed and starts_with(file, ${sel.prefix})`).map((r) => r.path)
      : [...new Set((sel.paths ?? []).map(norm))];
    const moved = await tx<{ path: string }[]>`
      insert into source_files_trash (game_id, path, content, encoding, format, data, deleted_by)
      select game_id, path, content, encoding, format, data, ${userId} from source_files where game_id = ${game.id} and path = any(${paths})
      on conflict (game_id, path) do update set content = excluded.content, encoding = excluded.encoding, format = excluded.format,
        data = excluded.data, deleted_by = excluded.deleted_by, deleted_at = now()
      returning path`;
    await tx`delete from source_files where game_id = ${game.id} and path = any(${paths})`;
    const hidden = await tx<{ file: string }[]>`
      update strings set removed = true, updated_at = now() where game_id = ${game.id} and not removed and file = any(${paths}) returning file`;
    if (moved.length || hidden.length) await tx`update games set updated_at = now() where id = ${game.id}`;
    const deleted = [...new Set([...moved.map((r) => r.path), ...hidden.map((r) => r.file)])].sort();
    return { deleted, files: moved.length, strings: hidden.length };
  });
}

/**
 * Вернуть оригиналы из корзины: файл снова разбирается (формат — по текущей карте), строки с теми же ключами
 * перестают быть removed вместе со своими вариантами и утверждениями. Пути, которые уже загружены заново, пропускаются.
 */
export async function restoreSource(game: Game, paths: string[]) {
  const want = [...new Set(paths.map(norm))];
  const rows = await db()<{ path: string; content: string; encoding: string; data: Buffer | null }[]>`
    select t.path, t.content, t.encoding, t.data from source_files_trash t
    where t.game_id = ${game.id} and t.path = any(${want})
      and not exists (select 1 from source_files s where s.game_id = t.game_id and s.path = t.path)`;
  const skipped = want.filter((p) => !rows.some((r) => r.path === p));
  if (!rows.length) return { restored: [] as string[], files: 0, strings: 0, skipped, errors: [] as string[] };
  const res = await importSource(game, rows.map((r) => ({ path: r.path, content: r.content, encoding: r.encoding, data: r.data ? new Uint8Array(r.data) : null })));
  const restored = rows.map((r) => r.path).sort();
  await db()`delete from source_files_trash where game_id = ${game.id} and path = any(${restored})`;
  const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from strings where game_id = ${game.id} and not removed and file = any(${restored})`;
  return { restored, files: restored.length, strings: n, skipped, errors: res.errors };
}

/**
 * Импорт готового перевода (например, существующего RimWorld-ru): заполняет утверждённые
 * переводы там, где их ещё нет. overwrite=true — перезаписать и существующие.
 */
/** Строка перевода, сопоставленная со строкой игры по файлу и ключу. */
export interface MatchedTranslation {
  string_id: number;
  file: string;
  key: string;
  source: string;
  source_hash: string;
  text: string;
}

/**
 * Разобрать файлы перевода и сопоставить строки с оригиналом (по файлу и ключу).
 * Файл может прийти текстом (content) или байтами (data, base64) — тогда кодировка берётся из encoding или определяется.
 * Строки, совпадающие с оригиналом, по умолчанию пропускаются (это непереведённые места, а не перевод).
 */
export async function matchTranslation(game: Game, lang: string, files: InFile[], opts: { keepUnchanged?: boolean } = {}) {
  // формат каждого файла перевода — тот, которым разобран одноимённый оригинал (иначе — по карте игры)
  const src = new Map((await db()<{ path: string; format: string | null }[]>`select path, format from source_files where game_id = ${game.id}`).map((r) => [r.path, r.format]));
  const [g] = await db()<{ format: string; format_map: Record<string, string> }[]>`select format, format_map from games where id = ${game.id}`;
  const prepared: Prepared[] = files.map((f) => {
    const path = norm(f.path);
    let content = f.content ?? '';
    if (f.data != null) {
      const bytes = typeof f.data === 'string' ? new Uint8Array(Buffer.from(f.data, 'base64')) : f.data;
      content = decodeBytes(bytes, isEncoding(f.encoding) ? f.encoding : detectEncoding(bytes));
    }
    return { path, format: src.get(path) ?? (g ? fileFormat(g, path) : undefined) ?? PASSTHROUGH, content, encoding: 'utf-8', data: null };
  });
  const { parsed, errors } = await parsePrepared(prepared);
  const strings = await db()<{ id: number; file: string; key: string; source: string; source_hash: string }[]>`
    select id, file, key, source, source_hash from strings where game_id = ${game.id} and not removed`;
  const byKey = new Map(strings.map((s) => [`${s.file}\u0000${s.key}`, s]));
  const rows: MatchedTranslation[] = [];
  let unknown = 0;
  let unchanged = 0;
  for (const p of parsed) {
    const s = byKey.get(`${p.file}\u0000${p.key}`);
    if (!s) { unknown++; continue; }
    if (p.source === 'TODO' || !p.source.trim()) continue;
    if (!opts.keepUnchanged && p.source === s.source) { unchanged++; continue; }
    rows.push({ string_id: s.id, file: s.file, key: s.key, source: s.source, source_hash: s.source_hash, text: p.source });
  }
  return { rows, unknown, unchanged, errors };
}

/** Импорт готового перевода сразу утверждённым (для управляющих игрой). overwrite — заменить уже утверждённое. */
export async function importTranslation(game: Game, lang: string, files: InFile[], overwrite = false, opts: { keepUnchanged?: boolean } = {}) {
  const { rows: matched, unknown, unchanged, errors } = await matchTranslation(game, lang, files, opts);
  const sql = db();
  const rows = matched.map((r) => ({ string_id: r.string_id, lang, text: r.text, source_hash: r.source_hash }));
  let imported = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const batch = rows.slice(i, i + 1000);
    const res = overwrite
      ? await sql`insert into approved ${sql(batch, 'string_id', 'lang', 'text', 'source_hash')}
          on conflict (string_id, lang) do update set text = excluded.text, source_hash = excluded.source_hash,
            variant_id = null, moderator_id = null, approved_at = now()`
      : await sql`insert into approved ${sql(batch, 'string_id', 'lang', 'text', 'source_hash')}
          on conflict (string_id, lang) do nothing`;
    imported += res.count;
  }
  return { imported, skipped: rows.length - imported, unknown, unchanged, errors };
}

/** Кодировка выгрузки файла: заданная для языка в настройках игры, иначе — как у оригинала. */
export const targetEncoding = (game: Pick<Game, 'encodings'>, lang: string, originalEncoding: string | undefined) =>
  game.encodings?.[lang] || originalEncoding || 'utf-8';

/** Собрать файлы перевода в родном формате игры (с кодировкой, в которой их записать). Формат — у каждого файла свой. */
export async function exportLanguage(game: Game, lang: string): Promise<{ files: OutFile[]; translated: number; total: number }> {
  const fmt = formatCache();
  const src = await db()<{ path: string; content: string; encoding: string; format: string | null; data: Buffer | null }[]>`
    select path, content, encoding, format, data from source_files where game_id = ${game.id}`;
  const byPath = new Map(src.map((r) => [r.path, r]));
  // кодировки игры могли не прийти в объекте game — тогда читаем из БД
  const [gameRow] = await db()<{ encodings: Record<string, string>; format: string; format_map: Record<string, string> }[]>`
    select encodings, format, format_map from games where id = ${game.id}`;
  // формат файла — каким он разобран при загрузке; для строк без сохранённого оригинала — по карте игры
  const formatOf = (path: string) => byPath.get(path)?.format ?? fileFormat(gameRow ?? game, path);
  const encodings = game.encodings ?? gameRow?.encodings ?? {};
  const out = (path: string, content: string): OutFile => {
    const encoding = targetEncoding({ encodings }, lang, byPath.get(path)?.encoding);
    // XML: encoding="…" в декларации должен совпадать с реальной кодировкой файла
    return { path, content: path.toLowerCase().endsWith('.xml') ? fixXmlDeclaration(content, encoding) : content, encoding };
  };
  const rows = await db()<{ file: string; key: string; source: string; text: string | null }[]>`
    select s.file, s.key, s.source, a.text
    from strings s
    left join approved a on a.string_id = s.id and a.lang = ${lang}
    where s.game_id = ${game.id} and not s.removed
    order by s.file, s.position`;

  const byFile = new Map<string, (typeof rows)[number][]>();
  for (const r of rows) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file)!.push(r);
  }

  // Выгружаются ВСЕ файлы и ВСЕ строки: где перевода нет, остаётся текст оригинала.
  // Иначе игра получит неполные файлы (пропавшие строки, обрезанные списки, отсутствующие скрипты).
  const files: OutFile[] = [];
  let translated = 0;
  for (const [file, list] of byFile) {
    const orig = byPath.get(file);
    if (orig?.format === PASSTHROUGH) continue; // строки остались от прежнего формата — файл теперь копируется как есть (ниже)
    const slug = formatOf(file);
    const format = slug && slug !== PASSTHROUGH ? await fmt(slug) : null;
    if (!format) continue;
    translated += list.filter((r) => r.text !== null).length;
    const all: OutString[] = list.map((r) => ({ key: r.key, source: r.source, text: r.text ?? r.source }));
    if (format.skeleton) {
      // Файл собирается поверх оригинала байт в байт
      if (!orig) continue;
      files.push(out(file, format.serialize(file, all, orig.content)));
    } else {
      files.push(out(file, format.serialize(file, all)));
    }
  }
  for (const [path, r] of byPath) {
    if (byFile.has(path) && r.format !== PASSTHROUGH) continue;
    if (r.format === PASSTHROUGH) {
      // «как есть»: байты оригинала (или его текст в исходной кодировке), без перевода и без смены кодировки
      files.push(r.data ? { path, content: '', encoding: 'binary', data: new Uint8Array(r.data) } : { path, content: r.content, encoding: r.encoding });
      continue;
    }
    // Оригиналы, в которых нет ни одной переводимой строки, тоже кладём — чтобы набор файлов был полным
    const slug = formatOf(path);
    const format = slug && slug !== PASSTHROUGH ? await fmt(slug) : null;
    if (format?.skeleton) files.push(out(path, r.content));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const total = rows.filter((r) => byPath.get(r.file)?.format !== PASSTHROUGH).length;
  return { files, translated, total };
}
