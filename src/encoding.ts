// Кодировки файлов на сервере: проверка имени, текст → байты (iconv-lite, чистый JS), проверка представимости символов.
// Определение кодировки по байтам делает браузер при загрузке (site/encoding.js); список ниже должен совпадать с ним.
import iconv from 'iconv-lite';

export const ENCODINGS = [
  'utf-8', 'utf-8-bom', 'utf-16le-bom', 'utf-16be-bom',
  'windows-1252', 'windows-1251', 'windows-1250', 'iso-8859-1', 'koi8-r',
  'shift_jis', 'gb18030', 'big5', 'euc-kr',
] as const;
export type Encoding = (typeof ENCODINGS)[number];

export const isEncoding = (v: unknown): v is Encoding => typeof v === 'string' && (ENCODINGS as readonly string[]).includes(v);
export const isUnicode = (enc: string) => enc.startsWith('utf-');

const BOM: Record<string, number[]> = { 'utf-8-bom': [0xef, 0xbb, 0xbf], 'utf-16le-bom': [0xff, 0xfe], 'utf-16be-bom': [0xfe, 0xff] };
const ICONV: Record<string, string> = { 'utf-8': 'utf8', 'utf-8-bom': 'utf8', 'utf-16le-bom': 'utf16le', 'utf-16be-bom': 'utf16be' };

/** Текст → байты файла в кодировке (с BOM, если он часть кодировки). */
export function encodeText(text: string, enc: string): Uint8Array {
  const body = iconv.encode(text, ICONV[enc] ?? enc);
  const bom = BOM[enc];
  if (!bom) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  const out = new Uint8Array(bom.length + body.length);
  out.set(bom, 0);
  out.set(body, bom.length);
  return out;
}

/** Байты → текст (BOM снимается). Нужен тестам и импорту из репо игры. */
export function decodeBytes(bytes: Uint8Array, enc: string): string {
  const bom = BOM[enc];
  const body = bom && bom.every((b, i) => bytes[i] === b) ? bytes.subarray(bom.length) : bytes;
  return iconv.decode(Buffer.from(body), ICONV[enc] ?? enc);
}

/** Символы текста, которые нельзя записать в кодировке (для юникодных — пусто). Уникальные, по порядку появления. */
export function unrepresentable(text: string, enc: string): string[] {
  if (isUnicode(enc)) return [];
  const bad: string[] = [];
  for (const ch of new Set(Array.from(text))) {
    if (ch.charCodeAt(0) < 0x80) continue; // ASCII есть во всех поддерживаемых кодировках
    if (iconv.decode(iconv.encode(ch, enc), enc) !== ch) bad.push(ch);
  }
  return bad;
}

/** Атрибут encoding в XML-декларации для целевой кодировки. */
export const xmlEncodingName = (enc: string) => (enc.startsWith('utf-8') ? 'utf-8' : enc.startsWith('utf-16') ? 'utf-16' : enc);

/** Привести encoding="…" в XML-декларации (если она есть) к целевой кодировке. */
export function fixXmlDeclaration(content: string, enc: string): string {
  return content.replace(/^(﻿?<\?xml\b[^?]*?\bencoding\s*=\s*)(["'])[^"']*\2/, (_m, head, q) => `${head}${q}${xmlEncodingName(enc)}${q}`);
}

/**
 * Характерные буквы языков — чтобы предупредить, что выбранная кодировка не подходит языку перевода.
 * Для языков вне списка проверки нет.
 */
export const LANG_SAMPLES: Record<string, string> = {
  ru: 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяЁЯ', uk: 'абвгґдеєжзиіїйклмнопрстуфхцчшщьюяҐЄІЇ', be: 'абвгдеёжзійклмнопрстуўфхцчшыьэюяЎ',
  bg: 'абвгдежзийклмнопрстуфхцчшщъьюя', sr: 'абвгдђежзијклљмнњопрстћуфхцчџш', kk: 'аәбвгғдеёжзийкқлмнңоөпрстуұүфхһцчшщъыіьэюя',
  de: 'äöüßÄÖÜ', fr: 'àâæçéèêëîïôœùûüÿÉÀ', es: 'áéíñóúü¿¡Ñ', 'es-419': 'áéíñóúü¿¡Ñ', it: 'àèéìòù',
  'pt-BR': 'áâãàçéêíóôõú', 'pt-PT': 'áâãàçéêíóôõú', pt: 'áâãàçéêíóôõú', pl: 'ąćęłńóśźżĄĆĘŁŃÓŚŹŻ', cs: 'áčďéěíňóřšťúůýž',
  sk: 'áäčďéíĺľňóôŕšťúýž', hu: 'áéíóöőúüű', ro: 'ăâîșț', hr: 'čćđšž', tr: 'çğıöşüİ', nl: 'éëïóöü', sv: 'åäö', da: 'æøå', no: 'æøå', fi: 'äö',
  el: 'αβγδεζηθικλμνξοπρστυφχψωάέ', lt: 'ąčęėįšųūž', lv: 'āčēģīķļņšūž', et: 'äõöüšž',
  ja: 'あいうえおアイウエオ日本語', zh: '的一是不了人我在有他', 'zh-Hans': '的一是不了人我在有他这个们', 'zh-Hant': '的一是不了人我在有他這個們',
  ko: '한국어가나다', vi: 'ăâđêôơưạảấ', ar: 'ابتثجحخدذر', he: 'אבגדהוזחטי', fa: 'ابپتثجچحخ', th: 'กขคงจฉ', hi: 'अआइईउ',
};

/** Для каждого языка — кодировки, в которых нельзя записать его буквы (предупреждение в настройках). */
export function encodingSupport(langs: string[]): Record<string, string[]> {
  return Object.fromEntries(
    langs.map((l) => {
      const sample = LANG_SAMPLES[l] ?? LANG_SAMPLES[l.split('-')[0]];
      return [l, sample ? ENCODINGS.filter((e) => unrepresentable(sample, e).length > 0) : []];
    }),
  );
}

/** Определить кодировку по байтам — как в браузере (site/encoding.js): BOM, корректный UTF-8, иначе windows-1252. */
export function detectEncoding(b: Uint8Array): Encoding {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8-bom';
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le-bom';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be-bom';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

/**
 * Двоичный файл (картинка, звук, архив…), а не текст: нулевой байт в первых 8 КБ (кроме UTF-16 с BOM).
 * Такие файлы не переводятся — хранятся и выгружаются байт в байт. Повторяет site/encoding.js.
 */
export function looksBinary(b: Uint8Array): boolean {
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return false;
  const n = Math.min(b.length, 8192);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}
