import { describe, expect, it } from 'vitest';
import { PERSONAS } from './advisor/personas';
import { spoken, unspokenAcronyms } from './advisor/spoken';
import { VOICE } from './advisor/config';

describe('spoken', () => {
  it('spells out units and symbols', () => {
    expect(spoken('Closing at 84 m/s, 25 km out.')).toBe(
      'Closing at 84 meters per second, 25 kilometers out.',
    );
    expect(spoken('Within 1 km and 300 m.')).toBe('Within 1 kilometer and 300 meters.');
    expect(spoken('Heat at 62%.')).toBe('Heat at 62 percent.');
    expect(spoken('Burn needs 120 dv.')).toBe('Burn needs 120 delta vee.');
    expect(spoken('1,200 m/s and 2.5 km/s')).toBe(
      '1,200 meters per second and 2.5 kilometers per second',
    );
  });

  it('spells out initialisms and leaves words alone', () => {
    expect(spoken('The AI reports an ETA.')).toBe('The A I reports an E T A.');
    expect(spoken('Press CIRCULARIZE, then FIRE.')).toBe('Press CIRCULARIZE, then FIRE.');
    expect(spoken('Meters of margin, my friend.')).toBe('Meters of margin, my friend.');
  });
});

describe('written lines read cleanly aloud', () => {
  const lines: [string, string][] = [];
  for (const [id, spec] of Object.entries(VOICE.lines)) {
    for (const t of spec.text) lines.push([id, t]);
    for (const v of spec.variants ?? []) lines.push([id, v.t]);
  }
  for (const p of PERSONAS) {
    for (const [id, texts] of Object.entries(p.lines))
      for (const t of texts) lines.push([`${p.id}:${id}`, t]);
  }

  it('has no initialism a speech engine could misread', () => {
    const bad = lines
      .filter(([, t]) => unspokenAcronyms(t).length > 0)
      .map(([id, t]) => `${id}: ${t}`);
    expect(bad).toEqual([]);
  });

  it('keeps every line short enough to say in one breath', () => {
    const long = lines.filter(([, t]) => t.split(/\s+/).length > 40).map(([id]) => id);
    expect(long).toEqual([]);
  });
});
