import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LINE_PRESETS, makeLinesFormat, validateLinesConfig } from '../src/formats/lines.js';

const preset = (slug: string) => makeLinesFormat(slug, LINE_PRESETS.find((p) => p.slug === slug)!.config);
const gpc = readFileSync(join(import.meta.dirname, 'fixtures', 'gunpoint', 'Intro.gpc'), 'utf8');

describe('lines: gunpoint preset', () => {
  const f = preset('gunpoint');
  it('finds only dialogue text, keyed by line number, with speaker context', () => {
    expect(f.matches('Scripts/Intro.gpc')).toBe(true);
    expect(f.matches('Scripts/readme.txt')).toBe(false);
    expect(f.parse('x.gpc', gpc)).toEqual([
      { key: 'L2', source: 'Who are you?', context: 'Them' },
      { key: 'L7', source: 'A friend.', context: 'Me' },
      { key: 'L9', source: 'Nobody.', context: 'Me' },
      { key: 'L13', source: 'Okay then.', context: 'Them' },
    ]);
  });
  it('rebuilds the file byte-for-byte, replacing only text lines (CRLF, no trailing newline kept)', () => {
    const same = f.serialize('x.gpc', f.parse('x.gpc', gpc).map((s) => ({ ...s, text: s.source })), gpc);
    expect(same).toBe(gpc);
    const ru = f.serialize('x.gpc', [{ key: 'L2', source: '', text: 'Ты кто?' }, { key: 'L9', source: '', text: 'Никто.\nправда' }], gpc);
    expect(ru).toBe(gpc.replace('Who are you?', 'Ты кто?').replace('Nobody.', 'Никто. правда'));
  });
  it('skips the END SCENE script command', () => {
    expect(f.parse('x.gpc', 'Them:\r\nHi.\r\n3\r\nEND SCENE')).toEqual([{ key: 'L2', source: 'Hi.', context: 'Them' }]);
  });
  it('validates single line and structural lookalikes', () => {
    expect(f.validate!('Ок')).toEqual([]);
    expect(f.validate!('12')).toHaveLength(1);
    expect(f.validate!('Они:')).toEqual([]); // кириллица не похожа на метку Them:/Me:
    expect(f.validate!('Boss:')).toHaveLength(1);
    expect(f.validate!('a\nb')).toHaveLength(1);
  });
  it('round-trips the real Gunpoint scripts if present locally', () => {
    const dir = process.env.GUNPOINT_DIR;
    if (!dir) return;
    for (const n of readdirSync(dir).filter((x) => x.endsWith('.gpc'))) {
      const c = readFileSync(join(dir, n), 'utf8');
      const strings = f.parse(n, c);
      expect(f.serialize(n, strings.map((s) => ({ ...s, text: s.source })), c)).toBe(c);
    }
  });
});

describe('lines: keyValue', () => {
  const f = preset('properties');
  const src = '# comment\n[menu]\nstart = Start game\nexit=Exit\nstart = Again\n\n';
  it('parses keys, sections as context, duplicates', () => {
    expect(f.parse('a.ini', src)).toEqual([
      { key: 'start', source: 'Start game', context: 'menu' },
      { key: 'exit', source: 'Exit', context: 'menu' },
      { key: 'start#2', source: 'Again', context: 'menu' },
    ]);
    expect(f.serialize('a.ini', [{ key: 'exit', source: '', text: 'Выход' }], src)).toBe(src.replace('exit=Exit', 'exit=Выход'));
  });
});

describe('lines: config validation', () => {
  it('rejects bad configs with readable errors', () => {
    expect(() => validateLinesConfig({ extensions: ['gpc'], mode: 'lines' })).toThrow(/extensions/);
    expect(() => validateLinesConfig({ extensions: ['.x'], mode: 'other' })).toThrow(/mode/);
    expect(() => validateLinesConfig({ extensions: ['.x'], mode: 'lines', text: '(.*)' })).toThrow(/text/);
    expect(() => validateLinesConfig({ extensions: ['.x'], mode: 'keyValue', text: '(?<text>.*)' })).toThrow(/key/);
    expect(() => validateLinesConfig({ extensions: ['.x'], mode: 'lines', skip: ['['] })).toThrow(/skip\[0\]/);
    expect(validateLinesConfig({ extensions: ['.x'], mode: 'lines' })).toMatchObject({ mode: 'lines' });
  });
});
