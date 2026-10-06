// Локализация интерфейса сайта. Не путать с языками перевода игр (#/g/slug/ru) — это язык самих кнопок и подсказок.
// Словари лежат в locales/<код>.js и подгружаются по требованию; недостающие ключи берутся из английского.

/** Языки интерфейса: код → самоназвание. */
export const LOCALES = [
  ['ru', 'Русский'],
  ['en', 'English'],
  ['uk', 'Українська'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['pt-BR', 'Português (BR)'],
  ['pl', 'Polski'],
  ['zh', '中文'],
  ['ja', '日本語'],
];
const CODES = LOCALES.map(([c]) => c);
const FALLBACK = 'en';

let current = FALLBACK;
let dict = {};
let fallback = {};
let plural = new Intl.PluralRules(FALLBACK);
const cache = {};

const load = (code) => (cache[code] ??= import(`./locales/${code}.js`).then((m) => m.default));

/** Подобрать поддерживаемый язык: точное совпадение, затем по основной части (pt → pt-BR, zh-CN → zh). */
export function matchLocale(code) {
  if (!code) return null;
  const lc = String(code).toLowerCase();
  const exact = CODES.find((c) => c.toLowerCase() === lc);
  if (exact) return exact;
  const base = lc.split(/[-_]/)[0];
  return CODES.find((c) => c.toLowerCase().split('-')[0] === base) || null;
}

/** Язык по умолчанию: сохранённый выбор, иначе язык браузера, иначе английский. */
export function detectLocale(saved) {
  const fromSaved = matchLocale(saved);
  if (fromSaved) return fromSaved;
  for (const l of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const m = matchLocale(l);
    if (m) return m;
  }
  return FALLBACK;
}

export async function setLocale(code) {
  const next = matchLocale(code) || FALLBACK;
  const [d, f] = await Promise.all([load(next), load(FALLBACK)]);
  dict = d;
  fallback = f;
  current = next;
  plural = new Intl.PluralRules(next);
  document.documentElement.lang = next;
  return next;
}

export const getLocale = () => current;

/**
 * Перевод по ключу. {param} подставляется из params (без экранирования — экранируйте пользовательские данные сами).
 * Если значение — объект {one, few, many, other}, форма выбирается по params.n (Intl.PluralRules).
 */
export function t(key, params = {}) {
  let v = dict[key] ?? fallback[key] ?? key;
  if (typeof v === 'object') v = v[plural.select(Number(params.n) || 0)] ?? v.other;
  return String(v).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}
