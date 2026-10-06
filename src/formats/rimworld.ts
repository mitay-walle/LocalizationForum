import type { Format, OutString, ParsedString } from './types.js';

/**
 * RimWorld LanguageData (Keyed/*.xml и DefInjected/<DefType>/*.xml).
 *
 *   <LanguageData>
 *     <!-- EN: Minor break risk -->
 *     <BreakRiskMinor>Риск лёгкого срыва</BreakRiskMinor>
 *     <Foo.rulesStrings>
 *       <li>r_name->Bar</li>
 *     </Foo.rulesStrings>
 *   </LanguageData>
 *
 * Элементы списка (<li>) хранятся как отдельные строки с ключом `Key[0]`, `Key[1]`…
 * В исходниках значение может быть TODO, тогда оригинал берём из комментария EN:.
 * LanguageInfo.xml, Strings/, WordInfo/ — не строки, их правят обычными PR.
 */

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const encode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Комментарий | открывающий тег | закрывающий тег | самозакрывающийся тег | текст
const TOKEN = /<!--([\s\S]*?)-->|<([A-Za-z_][\w.\-\[\]]*)\s*>|<\/([A-Za-z_][\w.\-\[\]]*)\s*>|<([A-Za-z_][\w.\-\[\]]*)\s*\/>|<\?[\s\S]*?\?>|([^<]+)/g;

function parseLanguageData(content: string): ParsedString[] {
  const out: ParsedString[] = [];
  const xml = content.replace(/^﻿/, '');
  let depth = 0; // 0 — вне LanguageData, 1 — внутри, 2 — внутри строки, 3 — внутри <li>
  let key = '';
  let text = '';
  let li: string[] = [];
  let liText = '';
  let hasLi = false;
  let pendingEn: string | undefined;
  let pendingCtx: string[] = [];

  for (const m of xml.matchAll(TOKEN)) {
    const [, comment, open, close, selfClose, chunk] = m;
    if (comment !== undefined) {
      if (depth !== 1) continue;
      const c = comment.trim();
      if (/^EN:/i.test(c)) pendingEn = c.replace(/^EN:\s*/i, '');
      else if (c && !/^UNUSED$/i.test(c)) pendingCtx.push(c);
    } else if (open !== undefined) {
      if (depth === 0) depth = 1; // <LanguageData>
      else if (depth === 1) {
        depth = 2;
        key = open;
        text = '';
        li = [];
        hasLi = false;
      } else if (depth === 2 && open === 'li') {
        depth = 3;
        hasLi = true;
        liText = '';
      }
    } else if (close !== undefined) {
      if (depth === 3 && close === 'li') {
        li.push(decode(liText));
        depth = 2;
      } else if (depth === 2 && close === key) {
        const context = pendingCtx.length ? pendingCtx.join('\n') : undefined;
        if (hasLi) {
          const en = pendingEn ? [...pendingEn.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => decode(x[1])) : [];
          li.forEach((v, i) => {
            const source = v === 'TODO' && en[i] !== undefined ? en[i] : v;
            out.push({ key: `${key}[${i}]`, source, context });
          });
        } else {
          const v = decode(text.trim());
          const source = v === 'TODO' && pendingEn !== undefined ? decode(pendingEn) : v;
          out.push({ key, source, context });
        }
        pendingEn = undefined;
        pendingCtx = [];
        depth = 1;
      } else if (depth === 1) depth = 0;
    } else if (selfClose !== undefined) {
      if (depth === 1) {
        pendingEn = undefined;
        pendingCtx = [];
      }
    } else if (chunk !== undefined) {
      if (depth === 2) text += chunk;
      else if (depth === 3) liText += chunk;
    }
  }
  return out;
}

export const rimworld: Format = {
  id: 'rimworld',
  matches: (p) => /(^|\/)(Keyed|DefInjected)\/.+\.xml$/i.test(p),
  parse: (_path, content) => parseLanguageData(content),
  serialize(_path, strings: OutString[]) {
    const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<LanguageData>', ''];
    // Собираем списки обратно: Key[0], Key[1] → <Key><li>…</li></Key>
    const lists = new Map<string, OutString[]>();
    const order: Array<string | OutString> = [];
    for (const s of strings) {
      const m = s.key.match(/^(.*)\[(\d+)\]$/);
      if (m) {
        if (!lists.has(m[1])) {
          lists.set(m[1], []);
          order.push(m[1]);
        }
        lists.get(m[1])![Number(m[2])] = s;
      } else order.push(s);
    }
    for (const item of order) {
      if (typeof item === 'string') {
        const items = (lists.get(item) ?? []).filter(Boolean);
        lines.push('  <!-- EN:');
        for (const s of items) lines.push(`    <li>${encode(s.source).replace(/--/g, '- -')}</li>`);
        lines.push('  -->');
        lines.push(`  <${item}>`);
        for (const s of items) lines.push(`    <li>${encode(s.text)}</li>`);
        lines.push(`  </${item}>`);
      } else {
        lines.push(`  <!-- EN: ${encode(item.source).replace(/--/g, '- -')} -->`);
        lines.push(`  <${item.key}>${encode(item.text)}</${item.key}>`);
      }
    }
    lines.push('', '</LanguageData>', '');
    return lines.join('\n');
  },
};
