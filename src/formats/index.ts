import { db } from '../db.js';
import { jsonFlat, jsonNested } from './json.js';
import { LINE_PRESETS, makeLinesFormat } from './lines.js';
import { rimworld } from './rimworld.js';
import type { Format } from './types.js';

export type { Format, ParsedString, OutString } from './types.js';
export { validateLinesConfig, makeLinesFormat } from './lines.js';

/** Форматы, написанные кодом (сложная структура файла). */
const BUILTIN: Record<string, { format: Format; title: string; extensions: string[] }> = {
  rimworld: { format: rimworld, title: 'RimWorld (Keyed / DefInjected XML)', extensions: ['.xml'] },
  json: { format: jsonFlat, title: 'JSON, плоский { "key": "text" }', extensions: ['.json'] },
  'json-nested': { format: jsonNested, title: 'JSON, вложенный { "menu": { "start": "…" } }', extensions: ['.json'] },
};

export const builtinIds = Object.keys(BUILTIN);
export const isBuiltin = (id: string) => id in BUILTIN || LINE_PRESETS.some((p) => p.slug === id);

export interface FormatInfo {
  slug: string;
  title: string;
  kind: 'builtin' | 'preset' | 'custom';
  extensions: string[];
  config?: unknown;
  owner?: string | null;
}

/** Найти формат по id: встроенный → пресет → пользовательский из БД. null — нет такого. */
export async function resolveFormat(id: string): Promise<Format | null> {
  if (BUILTIN[id]) return BUILTIN[id].format;
  const preset = LINE_PRESETS.find((p) => p.slug === id);
  if (preset) return makeLinesFormat(id, preset.config);
  const [row] = await db()<{ config: unknown }[]>`select config from custom_formats where slug = ${id}`;
  return row ? makeLinesFormat(id, row.config) : null;
}

export async function getFormat(id: string): Promise<Format> {
  const f = await resolveFormat(id);
  if (!f) throw new Error(`Неизвестный формат "${id}"`);
  return f;
}

export async function listFormats(): Promise<FormatInfo[]> {
  const custom = await db()<{ slug: string; title: string; config: { extensions: string[] }; owner: string | null }[]>`
    select f.slug, f.title, f.config, u.login as owner from custom_formats f left join users u on u.id = f.created_by order by f.title`;
  return [
    ...Object.entries(BUILTIN).map(([slug, b]) => ({ slug, title: b.title, kind: 'builtin' as const, extensions: b.extensions })),
    ...LINE_PRESETS.map((p) => ({ slug: p.slug, title: p.title, kind: 'preset' as const, extensions: p.config.extensions, config: p.config })),
    ...custom.map((c) => ({ slug: c.slug, title: c.title, kind: 'custom' as const, extensions: c.config.extensions, config: c.config, owner: c.owner })),
  ];
}

// ---------- форматы по расширениям файлов ----------

/** «Не переводить, копировать как есть» в карте форматов игры. */
export const PASSTHROUGH = '-';

/** Расширение файла в нижнем регистре с точкой: «Scripts/A.GPC» → «.gpc»; без расширения — ''. */
export function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/** Формат файла по карте игры: точное расширение, затем «*». undefined — в карте нет. */
export function mappedFormat(map: Record<string, string> | null | undefined, path: string): string | undefined {
  return map?.[extOf(path)] ?? map?.['*'];
}

/** Форматы, объявившие это расширение: встроенные → готовые построчные → пользовательские. */
export async function formatsForExtension(ext: string): Promise<string[]> {
  if (!ext) return [];
  return (await listFormats()).filter((f) => f.extensions.some((e) => e.toLowerCase() === ext)).map((f) => f.slug);
}

const canonical = (path: string, s: string) => {
  if (extOf(path) === '.json') {
    try {
      return JSON.stringify(JSON.parse(s.replace(/^﻿/, '')));
    } catch {
      return s;
    }
  }
  return s.replace(/\r\n/g, '\n').trim();
};

/** Ключ карты форматов: «.ext» в нижнем регистре или «*». */
export const isMapKey = (k: string) => k === '*' || /^\.[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*$/.test(k);

/**
 * Подобрать формат для нового расширения по образцам файлов этого расширения (sample = текст файла).
 * Кандидаты — форматы, объявившие расширение; формат игры по умолчанию (preferred) проверяется первым.
 * Берётся первый, который находит строки и собирает каждый образец обратно в то же самое
 * (так .json с вложенными объектами получает json-nested, плоский — json); иначе — нашедший больше всего строк.
 * null — ни один формат не нашёл строк (или кандидатов нет): файлы копируются как есть.
 */
export async function suggestFormat(ext: string, samples: { path: string; text: string }[], preferred?: string | null): Promise<string | null> {
  const candidates = await formatsForExtension(ext);
  if (!candidates.length) return null;
  if (!samples.length) return preferred && candidates.includes(preferred) ? preferred : candidates[0];
  const order = preferred && candidates.includes(preferred) ? [preferred, ...candidates.filter((c) => c !== preferred)] : candidates;
  let best: string | null = null;
  let bestStrings = 0;
  for (const slug of order) {
    const f = await resolveFormat(slug);
    if (!f) continue;
    let strings = 0;
    let roundTrip = true;
    for (const { path, text } of samples.slice(0, 20)) {
      try {
        const found = f.parse(path, text);
        strings += found.length;
        const rt = f.serialize(path, found.map((s) => ({ key: s.key, source: s.source, text: s.source })), text);
        if (canonical(path, rt) !== canonical(path, text)) roundTrip = false;
      } catch {
        roundTrip = false; // не разбирается этим форматом
      }
    }
    if (strings && roundTrip) return slug;
    if (strings > bestStrings) [best, bestStrings] = [slug, strings];
  }
  return best;
}

/** Формат файла: карта игры (расширение → «*»), иначе формат игры по умолчанию (для старых игр). */
export function fileFormat(game: { format?: string | null; format_map?: Record<string, string> | null }, path: string): string | undefined {
  return mappedFormat(game.format_map ?? undefined, path) ?? (game.format || undefined);
}
