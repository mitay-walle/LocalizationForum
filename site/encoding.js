// Кодировки файлов игры: определение по байтам и декодирование. Работает в браузере и в Node (тесты).
// Список и названия должны совпадать с src/encoding.ts (это проверяет тест).

/** Поддерживаемые кодировки. «-bom» — с меткой порядка байтов в начале файла (её сохраняем при выгрузке). */
export const ENCODINGS = [
  'utf-8', 'utf-8-bom', 'utf-16le-bom', 'utf-16be-bom',
  'windows-1252', 'windows-1251', 'windows-1250', 'iso-8859-1', 'koi8-r',
  'shift_jis', 'gb18030', 'big5', 'euc-kr',
];

/** Метка для TextDecoder (BOM TextDecoder снимает сам). */
const DECODER_LABEL = { 'utf-8-bom': 'utf-8', 'utf-16le-bom': 'utf-16le', 'utf-16be-bom': 'utf-16be' };

/** Догадка для «не UTF-8 и без BOM»: однобайтовая западноевропейская; пользователь может выбрать другую. */
export const LEGACY_GUESS = 'windows-1252';

/**
 * Определить кодировку по байтам: BOM UTF-8 / UTF-16 LE / UTF-16 BE → корректный UTF-8 без BOM →
 * иначе устаревшая однобайтовая (windows-1252 по умолчанию).
 */
export function detectEncoding(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8-bom';
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le-bom';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be-bom';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return 'utf-8';
  } catch {
    return LEGACY_GUESS;
  }
}

/** Байты → текст в заданной кодировке. BOM в текст не попадает, переводы строк сохраняются как есть. */
export function decodeBytes(bytes, encoding) {
  const label = DECODER_LABEL[encoding] || encoding;
  return new TextDecoder(label).decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

/** Юникодная кодировка — в ней можно записать любой символ. */
export const isUnicode = (encoding) => /^utf-/.test(encoding);

/**
 * Двоичный файл (картинка, звук, архив…), а не текст: нулевой байт в первых 8 КБ (кроме UTF-16 с BOM).
 * Такие файлы не переводятся — уходят на форум байтами и выгружаются как есть. Повторяет src/encoding.ts.
 */
export function looksBinary(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return false;
  const n = Math.min(b.length, 8192);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}
