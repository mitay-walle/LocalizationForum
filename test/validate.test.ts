import { describe, expect, it } from 'vitest';
import { validateVariant } from '../src/validate.js';

const errors = (src: string, dst: string) => validateVariant(src, dst).filter((i) => i.level === 'error').map((i) => i.message);

describe('placeholders', () => {
  it('accepts reordered placeholders', () => {
    expect(errors('{0} killed {1}', '{1} убит игроком {0}')).toEqual([]);
  });
  it('flags missing and extra', () => {
    expect(errors('Hello {0}', 'Привет')).toEqual(['Не хватает {0}']);
    expect(errors('Hello', 'Привет {0}')).toEqual(['Лишний {0}, его нет в оригинале']);
  });
  it('normalizes RimWorld conditional macros', () => {
    expect(errors('{PAWN_gender ? He : She} left', '{PAWN_gender ? Он ушёл : Она ушла}')).toEqual([]);
  });
  it('checks printf and tags but ignores tag attributes', () => {
    expect(errors('Ammo: %d/%d', 'Патроны: %d')).toEqual(['Не хватает %d (нужно 2, есть 1)']);
    expect(errors('<color=#f00>Hot</color>', '<color=#ff0000>Жарко</color>')).toEqual([]);
    expect(errors('<b>Hot</b>', 'Жарко')).toHaveLength(2);
  });
  it('missing \\n is only a warning', () => {
    const r = validateVariant('a\\nb', 'а б');
    expect(r).toEqual([{ level: 'warn', message: 'Не хватает \\n' }]);
  });
  it('rules', () => {
    const r = validateVariant('a - b', 'а - б', [{ pattern: '\\s-\\s', message: 'тире', level: 'warn' }, { pattern: '[', message: 'broken' }]);
    expect(r).toEqual([{ level: 'warn', message: 'тире' }]);
  });
  it('empty', () => {
    expect(errors('x', '  ')).toEqual(['Пустой перевод']);
  });
});
