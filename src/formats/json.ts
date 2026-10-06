import type { Format, OutString, ParsedString } from './types.js';

function flatten(obj: unknown, prefix: string, out: ParsedString[]) {
  if (typeof obj === 'string') {
    out.push({ key: prefix, source: obj });
  } else if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  // числа, массивы и null не переводим
}

function parseJson(path: string, content: string): ParsedString[] {
  const data = JSON.parse(content.replace(/^﻿/, ''));
  const out: ParsedString[] = [];
  flatten(data, '', out);
  return out;
}

/** Плоский JSON: { "menu.start": "Start" } */
export const jsonFlat: Format = {
  id: 'json',
  matches: (p) => p.endsWith('.json'),
  parse: parseJson,
  serialize(_path, strings: OutString[]) {
    const obj: Record<string, string> = {};
    for (const s of strings) obj[s.key] = s.text;
    return JSON.stringify(obj, null, 2) + '\n';
  },
};

/** Вложенный JSON: { "menu": { "start": "Start" } } — ключи хранятся через точку. */
export const jsonNested: Format = {
  id: 'json-nested',
  matches: (p) => p.endsWith('.json'),
  parse: parseJson,
  serialize(_path, strings: OutString[]) {
    const root: Record<string, unknown> = {};
    for (const s of strings) {
      const parts = s.key.split('.');
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
        node = node[part] as Record<string, unknown>;
      }
      node[parts[parts.length - 1]] = s.text;
    }
    return JSON.stringify(root, null, 2) + '\n';
  },
};
