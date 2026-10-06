import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsonFlat, jsonNested } from '../src/formats/json.js';
import { rimworld } from '../src/formats/rimworld.js';

const fx = (p: string) => readFileSync(join(import.meta.dirname, 'fixtures', p), 'utf8');

describe('rimworld', () => {
  const f = rimworld;

  it('matches only Keyed/DefInjected xml', () => {
    expect(f.matches('Core/Keyed/Alerts.xml')).toBe(true);
    expect(f.matches('Royalty/DefInjected/ThoughtDef/A.xml')).toBe(true);
    expect(f.matches('Core/LanguageInfo.xml')).toBe(false);
    expect(f.matches('Core/Strings/Names/Animal_Male.txt')).toBe(false);
  });

  it('parses Keyed with entities and escapes', () => {
    const s = f.parse('Core/Keyed/Alerts.xml', fx('rimworld/Core/Keyed/Alerts.xml'));
    expect(s.map((x) => x.key)).toEqual(['BreakRiskMinor', 'BreakRiskMinorDesc', 'Starving', 'LostWeapon']);
    expect(s[1].source).toContain('\\n{0}');
    expect(s[2].source).toBe('{PAWN_nameDef} is starving & needs food');
    expect(s[3].source).toBe('{PAWN_pronoun} lost {PAWN_possessive} <color=#ff0000>weapon</color>');
  });

  it('takes source from EN comment when value is TODO, keeps context', () => {
    const s = f.parse('x/DefInjected/ThoughtDef/T.xml', fx('rimworld/Core/DefInjected/ThoughtDef/Thoughts_Memory.xml'));
    expect(s[0]).toEqual({ key: 'ArtifactMoodBoost.stages.strange_feeling.label', source: 'strange feeling', context: 'Thought_Memory, null. Label: {PAWN}.' });
    expect(s[1].source).toBe('I feel strange, but also very relaxed.');
    expect(s[1].context).toBeUndefined();
  });

  it('splits lists into Key[i] and serializes them back', () => {
    const s = f.parse('x/DefInjected/RulePackDef/N.xml', fx('rimworld/Core/DefInjected/RulePackDef/Names.xml'));
    expect(s.map((x) => x.key)).toEqual([
      'NamerColony.rulePack.rulesStrings[0]',
      'NamerColony.rulePack.rulesStrings[1]',
      'NamerColony.rulePack.rulesStrings[2]',
    ]);
    expect(s[0].source).toBe('r_name->[adj] [noun]');
    const out = f.serialize('x', s.map((x, i) => ({ key: x.key, source: x.source, text: ['r_name->[adj] [noun]', 'adj->Храбрый', 'noun->Волк'][i] })));
    expect(out).toContain('<NamerColony.rulePack.rulesStrings>\n    <li>r_name-&gt;[adj] [noun]</li>\n    <li>adj-&gt;Храбрый</li>');
    expect(f.parse('x', out).map((x) => x.source)).toEqual(['r_name->[adj] [noun]', 'adj->Храбрый', 'noun->Волк']);
  });

  it('round-trips translations with special chars', () => {
    const out = f.serialize('Core/Keyed/A.xml', [
      { key: 'Starving', source: 'A & B -- C', text: '{PAWN_nameDef} голодает & <b>умирает</b>' },
    ]);
    expect(out).toContain('<!-- EN: A &amp; B - - C -->');
    const back = f.parse('Core/Keyed/A.xml', out);
    expect(back).toEqual([{ key: 'Starving', source: '{PAWN_nameDef} голодает & <b>умирает</b>' }]);
  });
});

describe('json', () => {
  it('nested flatten and rebuild', () => {
    const f = jsonNested;
    const s = f.parse('en.json', fx('json/en.json'));
    expect(s.map((x) => x.key)).toEqual(['menu.start_game', 'menu.settings', 'menu.exit', 'hud.ammo', 'hud.reactor']);
    const out = JSON.parse(f.serialize('en.json', [{ key: 'menu.start_game', source: '', text: 'Новая игра' }, { key: 'hud.ammo', source: '', text: 'Патроны: %d/%d' }]));
    expect(out).toEqual({ menu: { start_game: 'Новая игра' }, hud: { ammo: 'Патроны: %d/%d' } });
  });

  it('flat', () => {
    const f = jsonFlat;
    expect(JSON.parse(f.serialize('a.json', [{ key: 'a.b', source: '', text: 'x' }]))).toEqual({ 'a.b': 'x' });
  });
});
