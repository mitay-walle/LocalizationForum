/**
 * Проверки варианта перевода: сохранность плейсхолдеров/тегов и правила языка.
 * error — вариант не принимается; warn — принимается, но показываем предупреждение.
 */

export interface Rule {
  pattern: string;
  flags?: string;
  message: string;
  level?: 'error' | 'warn';
}

export interface Issue {
  level: 'error' | 'warn';
  message: string;
}

// {0}, {PAWN_label}, {PAWN_gender ? он : она} → нормализуем до {ИМЯ}; текст внутри условий переводится.
const BRACE = /\{([A-Za-z0-9_]+)[^{}]*\}/g;
// printf: %s %d %1$s %.2f %%
const PRINTF = /%(?:\d+\$)?[-+ #0]*\d*(?:\.\d+)?[sdifuxXeEgGc@]/g;
// разметка: <color=#fff>, </color>, <b>, <br/>, [b], [/url]
const TAG = /<\/?[A-Za-z][A-Za-z0-9_-]*(?:[= ][^<>]*)?\/?>|\[\/?[A-Za-z]+(?:=[^\]]*)?\]/g;
// литеральные экранированные последовательности, как в RimWorld: \n
const ESCAPE = /\\[nt]/g;

function tokens(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (t: string) => out.set(t, (out.get(t) ?? 0) + 1);
  for (const m of text.matchAll(BRACE)) add(`{${m[1]}}`);
  for (const m of text.matchAll(PRINTF)) add(m[0]);
  for (const m of text.matchAll(TAG)) add(m[0].replace(/[= ].*?(\/?[>\]])$/, '$1'));
  for (const m of text.matchAll(ESCAPE)) add(m[0]);
  return out;
}

export function checkPlaceholders(source: string, translation: string): Issue[] {
  const src = tokens(source);
  const dst = tokens(translation);
  const issues: Issue[] = [];
  for (const [t, n] of src) {
    const have = dst.get(t) ?? 0;
    if (have < n) issues.push({ level: t === '\\n' ? 'warn' : 'error', message: `Не хватает ${t}${n > 1 ? ` (нужно ${n}, есть ${have})` : ''}` });
  }
  for (const [t, n] of dst) {
    if (!src.has(t)) issues.push({ level: 'error', message: `Лишний ${t}, его нет в оригинале` });
    else if (n > (src.get(t) ?? 0) && t !== '\\n') issues.push({ level: 'warn', message: `${t} встречается больше раз, чем в оригинале` });
  }
  return issues;
}

export function checkRules(translation: string, rules: Rule[] = []): Issue[] {
  const issues: Issue[] = [];
  for (const r of rules) {
    let re: RegExp;
    try {
      re = new RegExp(r.pattern, r.flags ?? 'u');
    } catch {
      continue; // кривое правило в rules/*.json не должно ломать отправку
    }
    if (re.test(translation)) issues.push({ level: r.level ?? 'warn', message: r.message });
  }
  return issues;
}

export function validateVariant(source: string, translation: string, rules: Rule[] = []): Issue[] {
  const text = translation;
  if (!text.trim()) return [{ level: 'error', message: 'Пустой перевод' }];
  if (text.length > 10000) return [{ level: 'error', message: 'Слишком длинный текст' }];
  const issues = [...checkPlaceholders(source, text), ...checkRules(text, rules)];
  if (text !== text.trim()) issues.push({ level: 'warn', message: 'Пробелы в начале или в конце строки' });
  return issues;
}
