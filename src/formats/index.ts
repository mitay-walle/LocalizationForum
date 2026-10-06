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
