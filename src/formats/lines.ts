import type { Format, OutString, ParsedString } from './types.js';

/**
 * Настраиваемый построчный формат — описывается данными (JSON), без кода.
 * Подходит для .gpc (Gunpoint), .properties / .ini / .lang (key=value), .txt со строкой на реплику и т.п.
 *
 *   {
 *     "extensions": [".gpc"],                  // какие файлы брать
 *     "mode": "lines",                         // lines — ключ = номер строки; keyValue — ключ из группы (?<key>)
 *     "text": "^(?<text>.*)$",                 // какая часть строки переводится (группа text); по умолчанию вся строка
 *     "skip": ["^\\s*$", "^\\d+$"],            // строки, которые никогда не переводятся
 *     "contextLine": "^(?<label>[A-Za-z ]+):$",// строка-заголовок: не переводится, становится контекстом следующих
 *     "comment": "^\\s*[#;]"                   // комментарии (не переводятся)
 *   }
 *
 * Файл всегда собирается поверх оригинала: меняется только участок группы text,
 * остальные байты (пустые строки, номера, разделители, CRLF) остаются как были.
 */
export interface LinesConfig {
  extensions: string[];
  mode: 'lines' | 'keyValue';
  text?: string;
  skip?: string[];
  contextLine?: string;
  comment?: string;
}

interface Compiled {
  cfg: LinesConfig;
  text: RegExp;
  skip: RegExp[];
  contextLine?: RegExp;
  comment?: RegExp;
}

function compile(raw: unknown): Compiled {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Конфиг формата — JSON-объект');
  const cfg = raw as LinesConfig;
  if (!Array.isArray(cfg.extensions) || !cfg.extensions.length || cfg.extensions.some((e) => typeof e !== 'string' || !/^\.[\w.-]+$/.test(e)))
    throw new Error('extensions: список расширений вида [".gpc", ".txt"]');
  if (cfg.mode !== 'lines' && cfg.mode !== 'keyValue') throw new Error('mode: "lines" или "keyValue"');
  const re = (name: string, src: unknown, flags = 'd') => {
    if (typeof src !== 'string') throw new Error(`${name}: строка с регулярным выражением`);
    try {
      return new RegExp(src, flags);
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  };
  const text = re('text', cfg.text ?? (cfg.mode === 'keyValue' ? '^\\s*(?<key>[^=\\s]+)\\s*=\\s?(?<text>.*)$' : '^(?<text>.*\\S.*)$'));
  if (!/\(\?<text>/.test(text.source)) throw new Error('text: нужна именованная группа (?<text>…)');
  if (cfg.mode === 'keyValue' && !/\(\?<key>/.test(text.source)) throw new Error('text: для keyValue нужна группа (?<key>…)');
  if (cfg.skip !== undefined && !Array.isArray(cfg.skip)) throw new Error('skip: список регулярных выражений');
  const contextLine = cfg.contextLine ? re('contextLine', cfg.contextLine) : undefined;
  if (contextLine && !/\(\?<label>/.test(contextLine.source)) throw new Error('contextLine: нужна группа (?<label>…)');
  return {
    cfg,
    text,
    skip: (cfg.skip ?? []).map((s, i) => re(`skip[${i}]`, s)),
    contextLine,
    comment: cfg.comment ? re('comment', cfg.comment) : undefined,
  };
}

/** Проверить конфиг; бросает понятную ошибку. */
export function validateLinesConfig(raw: unknown): LinesConfig {
  return compile(raw).cfg;
}

function splitLines(content: string) {
  const bom = content.startsWith('﻿') ? '﻿' : '';
  const body = content.slice(bom.length);
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  return { lines: body.split(/\r?\n/), eol, bom };
}

type Hit = { line: number; key: string; start: number; end: number; source: string; context?: string };

function scan(c: Compiled, content: string): { hits: Hit[]; lines: string[]; eol: string; bom: string } {
  const { lines, eol, bom } = splitLines(content);
  const hits: Hit[] = [];
  const seen = new Map<string, number>();
  let label: string | undefined;
  lines.forEach((line, i) => {
    if (c.comment?.test(line)) return;
    const ctx = c.contextLine ? c.contextLine.exec(line) : null;
    if (ctx) {
      label = ctx.groups?.label?.trim() || undefined;
      return;
    }
    if (c.skip.some((r) => r.test(line))) return;
    const m = c.text.exec(line);
    const span = m?.indices?.groups?.text;
    if (!m || !span || m.groups?.text === undefined || !m.groups.text.trim()) return;
    let key = c.cfg.mode === 'keyValue' ? (m.groups.key ?? '').trim() : `L${i + 1}`;
    if (!key) return;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) key = `${key}#${n}`; // повторяющийся ключ в одном файле
    hits.push({ line: i, key, start: span[0], end: span[1], source: m.groups.text, context: label });
  });
  return { hits, lines, eol, bom };
}

export function makeLinesFormat(id: string, raw: unknown): Format {
  const c = compile(raw);
  const exts = c.cfg.extensions.map((e) => e.toLowerCase());
  return {
    id,
    skeleton: true,
    matches: (p) => exts.some((e) => p.toLowerCase().endsWith(e)),
    parse(_path, content): ParsedString[] {
      return scan(c, content).hits.map((h) => ({ key: h.key, source: h.source, context: h.context }));
    },
    serialize(_path, strings: OutString[], original = '') {
      const { hits, lines, eol, bom } = scan(c, original);
      const byKey = new Map(strings.map((s) => [s.key, s.text]));
      // Заменяем с конца строки, чтобы смещения не поехали (на строке может быть только одно совпадение, но на всякий случай)
      for (const h of [...hits].reverse()) {
        const t = byKey.get(h.key);
        if (t === undefined) continue;
        const line = lines[h.line];
        lines[h.line] = line.slice(0, h.start) + t.replace(/\r?\n/g, ' ') + line.slice(h.end);
      }
      return bom + lines.join(eol);
    },
    validate(text) {
      const issues: string[] = [];
      if (/[\r\n]/.test(text)) issues.push('В этом формате перевод должен быть в одну строку');
      if (c.skip.some((r) => r.test(text)) || c.contextLine?.test(text) || c.comment?.test(text))
        issues.push('Такая строка будет воспринята не как текст (совпадает с правилами skip / contextLine / comment формата)');
      return issues;
    },
  };
}

/** Готовые пресеты, которые сразу появляются в списке форматов. */
export const LINE_PRESETS: { slug: string; title: string; config: LinesConfig }[] = [
  {
    slug: 'gunpoint',
    title: 'Gunpoint — диалоги .gpc',
    config: { extensions: ['.gpc'], mode: 'lines', skip: ['^\\s*$', '^\\d+\\s*$'], contextLine: '^(?<label>[A-Za-z][A-Za-z ]*):\\s*$' },
  },
  {
    slug: 'properties',
    title: 'key=value (.properties, .ini, .lang)',
    config: { extensions: ['.properties', '.ini', '.lang', '.cfg'], mode: 'keyValue', comment: '^\\s*[#;!]', contextLine: '^\\s*\\[(?<label>[^\\]]+)\\]\\s*$' },
  },
  {
    slug: 'plain-lines',
    title: 'Текст: одна строка — одна реплика (.txt)',
    config: { extensions: ['.txt'], mode: 'lines', skip: ['^\\s*$'] },
  },
];
