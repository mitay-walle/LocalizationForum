import { createHash } from 'node:crypto';
import { db } from './db.js';
import { getFormat, type OutString } from './formats/index.js';

export interface InFile {
  path: string;
  content: string;
}

export interface Game {
  id: number;
  slug: string;
  title: string;
  repo: string | null;
  format: string;
  source_lang: string;
  languages: string[];
  rules: Record<string, unknown>;
}

export const hashSource = (s: string) => createHash('sha1').update(s).digest('hex');
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.?\//, '');

function parseFiles(game: Game, files: InFile[]) {
  const format = getFormat(game.format);
  const parsed: { file: string; key: string; source: string; context: string | null; position: number }[] = [];
  const errors: string[] = [];
  for (const f of files) {
    const path = norm(f.path);
    if (!format.matches(path)) continue;
    try {
      format.parse(path, f.content).forEach((s, i) =>
        parsed.push({ file: path, key: s.key, source: s.source, context: s.context ?? null, position: i }),
      );
    } catch (e) {
      errors.push(`${path}: ${(e as Error).message}`);
    }
  }
  return { parsed, errors };
}

/**
 * Импорт исходников игры. Новые строки добавляются, изменённые обновляются
 * (их переводы становятся «устаревшими» через source_hash), пропавшие помечаются removed.
 */
export async function importSource(game: Game, files: InFile[]) {
  const { parsed, errors } = parseFiles(game, files);
  if (errors.length && !parsed.length) return { added: 0, changed: 0, removed: 0, unchanged: 0, errors };

  const sql = db();
  return sql.begin(async (tx) => {
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
    const batchFiles = new Set(files.map((f) => norm(f.path)));
    const gone = existing
      .filter((r) => !r.removed && batchFiles.has(r.file) && !seen.has(`${r.file}\u0000${r.key}`))
      .map((r) => r.id);
    if (gone.length) await tx`update strings set removed = true, updated_at = now() where id = any(${gone})`;
    await tx`update games set updated_at = now() where id = ${game.id}`;

    return { added, changed, removed: gone.length, unchanged, errors };
  });
}

/** После загрузки всех пачек: строки из файлов, которых больше нет в source/, помечаются removed. */
export async function finalizeSource(game: Game, paths: string[]) {
  const keep = paths.map(norm);
  const res = await db()`
    update strings set removed = true, updated_at = now()
    where game_id = ${game.id} and not removed and not (file = any(${keep}))`;
  return { removed: res.count };
}

/**
 * Импорт готового перевода (например, существующего RimWorld-ru): заполняет утверждённые
 * переводы там, где их ещё нет. overwrite=true — перезаписать и существующие.
 */
export async function importTranslation(game: Game, lang: string, files: InFile[], overwrite = false) {
  const { parsed, errors } = parseFiles(game, files);
  const sql = db();
  const strings = await sql<{ id: number; file: string; key: string; source: string; source_hash: string }[]>`
    select id, file, key, source, source_hash from strings where game_id = ${game.id} and not removed`;
  const byKey = new Map(strings.map((s) => [`${s.file}\u0000${s.key}`, s]));
  const rows: { string_id: number; lang: string; text: string; source_hash: string }[] = [];
  let unknown = 0;
  for (const p of parsed) {
    const s = byKey.get(`${p.file}\u0000${p.key}`);
    if (!s) { unknown++; continue; }
    if (p.source === 'TODO' || !p.source.trim()) continue;
    rows.push({ string_id: s.id, lang, text: p.source, source_hash: s.source_hash });
  }
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
  return { imported, skipped: rows.length - imported, unknown, errors };
}

/** Собрать файлы перевода в родном формате игры. */
export async function exportLanguage(game: Game, lang: string) {
  const format = getFormat(game.format);
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

  const files: InFile[] = [];
  let translated = 0;
  for (const [file, list] of byFile) {
    // Список (Key[0], Key[1]…) выгружается целиком: непереведённые элементы — оригиналом,
    // иначе игра получит обрезанный список.
    const listHasTranslation = new Set<string>();
    for (const r of list) {
      const m = r.key.match(/^(.*)\[\d+\]$/);
      if (m && r.text !== null) listHasTranslation.add(m[1]);
    }
    const out: OutString[] = [];
    for (const r of list) {
      const m = r.key.match(/^(.*)\[\d+\]$/);
      if (r.text !== null) {
        translated++;
        out.push({ key: r.key, source: r.source, text: r.text });
      } else if (m && listHasTranslation.has(m[1])) {
        out.push({ key: r.key, source: r.source, text: r.source });
      }
    }
    if (out.length) files.push({ path: file, content: format.serialize(file, out) });
  }
  return { files, translated, total: rows.length };
}
