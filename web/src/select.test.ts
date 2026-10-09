import { describe, expect, it } from 'vitest';
import { VOICE, type LineSpec } from './advisor/config';
import { candidatesFor, LineSelector, matches, type Candidate } from './advisor/select';
import type { Situation } from './advisor/situation';

const sit = (tags: string[], vars: Record<string, string> = {}): Situation => ({
  tags: new Set(tags),
  vars,
});

const spec = (over: Partial<LineSpec>): LineSpec => ({
  priority: 'quip',
  category: 'quip',
  text: [],
  ...over,
});

describe('tag expressions', () => {
  it('needs all, any one of, and none of', () => {
    const tags = new Set(['a', 'b']);
    expect(matches(undefined, tags)).toBe(true);
    expect(matches({ all: ['a', 'b'] }, tags)).toBe(true);
    expect(matches({ all: ['a', 'c'] }, tags)).toBe(false);
    expect(matches({ any: ['c', 'b'] }, tags)).toBe(true);
    expect(matches({ any: ['c', 'd'] }, tags)).toBe(false);
    expect(matches({ none: ['b'] }, tags)).toBe(false);
    expect(matches({ all: ['a'], none: ['z'] }, tags)).toBe(true);
  });
});

describe('candidates', () => {
  const s = spec({
    text: ['plain'],
    variants: [
      { t: 'tagged', when: { all: ['x'] } },
      { t: 'argus only', persona: ['argus'] },
      { t: 'about {target}' },
    ],
  });

  it('keeps plain lines and the tagged ones that fit', () => {
    expect(
      candidatesFor('q', s, s.text, 'argus', sit([], { target: 'T' })).map((c) => c.text),
    ).toEqual(['plain', 'argus only', 'about {target}']);
    expect(candidatesFor('q', s, s.text, 'argus', sit(['x'])).map((c) => c.text)).toContain(
      'tagged',
    );
  });

  it('drops other personas variants and lines whose slots have no value', () => {
    const texts = candidatesFor('q', s, s.text, 'halcyon', sit([])).map((c) => c.text);
    expect(texts).toEqual(['plain']);
  });

  it('applies the line-level condition to every variant', () => {
    const gated = spec({ text: ['a'], when: { all: ['x'] } });
    expect(candidatesFor('q', gated, gated.text, 'argus', sit([]))).toEqual([]);
    expect(candidatesFor('q', gated, gated.text, 'argus', sit(['x']))).toHaveLength(1);
  });
});

describe('selector', () => {
  const opts = { repeatWindow: 100, topChoices: 1 };
  const c = (key: string, over: Partial<Candidate> = {}): Candidate => ({
    id: 'q',
    text: key,
    key,
    weight: 1,
    tags: [],
    ...over,
  });

  it('prefers the more specific line', () => {
    const s = new LineSelector(opts, () => 0);
    expect(
      s.choose([c('plain'), c('fit', { tags: ['a', 'b'] }), c('some', { tags: ['a'] })], 0)?.key,
    ).toBe('fit');
  });

  it('lifts lines that use a salient tag', () => {
    const s = new LineSelector({ ...opts, salient: ['fight'] }, () => 0);
    expect(
      s.choose([c('calm', { tags: ['a', 'b'] }), c('fight', { tags: ['fight'] })], 0)?.key,
    ).toBe('fight');
  });

  it('passes over recently used lines for fresh ones, and returns to them when nothing else is left', () => {
    const s = new LineSelector(opts, () => 0);
    const all = [c('a', { weight: 2 }), c('b')];
    expect(s.choose(all, 0)?.key).toBe('a');
    expect(s.choose(all, 10)?.key).toBe('b');
    expect(s.choose(all, 20)?.key).toBe('a'); // both used: the better one again
    expect(s.choose(all, 500)?.key).toBe('a'); // window over
  });

  it('honours cooldown and once, and forgets them on reset', () => {
    const s = new LineSelector(opts, () => 0);
    expect(s.choose([c('x', { cooldown: 50 })], 0)).not.toBeNull();
    expect(s.choose([c('x', { cooldown: 50 })], 10)).toBeNull();
    expect(s.choose([c('x', { cooldown: 50 })], 60)).not.toBeNull();
    expect(s.choose([c('o', { once: true })], 0)).not.toBeNull();
    expect(s.choose([c('o', { once: true })], 1000)).toBeNull();
    s.reset();
    expect(s.choose([c('o', { once: true })], 0)).not.toBeNull();
  });

  it('draws among the best few and returns null for no candidates', () => {
    let r = 0.99;
    const s = new LineSelector({ ...opts, topChoices: 3 }, () => r);
    expect(s.choose([], 0)).toBeNull();
    const all = [
      c('a', { weight: 3 }),
      c('b', { weight: 2 }),
      c('c', { weight: 1 }),
      c('d', { weight: 0.1 }),
    ];
    const seen = new Set<string>();
    for (const x of [0, 0.5, 0.99]) {
      r = x;
      seen.add(s.choose(all, 1000 * (seen.size + 1))?.key ?? '');
      s.reset();
    }
    expect(seen.has('d')).toBe(false);
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('the shipped library', () => {
  const known = new Set([
    'orbit.circular',
    'orbit.elliptical',
    'orbit.escape',
    'orbit.low',
    'orbit.high',
    'orbit.impact',
    'hull.damaged',
    'hull.critical',
    'hull.pristine',
    'heat.high',
    'heat.cool',
    'throttle.burning',
    'throttle.idle',
    'warp.high',
    'hostile.none',
    'hostile.near',
    'hostile.far',
    'hostile.hunting',
    'missile.inbound',
    'mine.near',
    'target.set',
    'mission.none',
    'mission.orbit',
    'mission.rendezvous',
    'mission.destroy',
    'mission.mineZone',
    'mission.survive',
    'player.idle_long',
    'player.just_killed',
    'player.kill_streak',
    'player.just_missed',
    'player.recent_damage',
    'burn.recent',
  ]);
  const used = (e?: { all?: string[]; any?: string[]; none?: string[] }): string[] => [
    ...(e?.all ?? []),
    ...(e?.any ?? []),
    ...(e?.none ?? []),
  ];

  it('only names tags the situation can produce', () => {
    const bad: string[] = [];
    for (const [id, line] of Object.entries(VOICE.lines)) {
      for (const t of used(line.when)) if (!known.has(t)) bad.push(`${id}: ${t}`);
      for (const v of line.variants ?? [])
        for (const t of used(v.when))
          if (!known.has(t) && !t.startsWith('persona.')) bad.push(`${id}: ${t}`);
    }
    expect(bad).toEqual([]);
  });

  it('only uses slots the situation supplies', () => {
    const slots = new Set(['callsign', 'name', 'target', 'range', 'kills', 'altitude', 'pe', 'ap']);
    const bad: string[] = [];
    for (const [id, line] of Object.entries(VOICE.lines)) {
      if (line.category !== 'quip') continue;
      for (const t of [...line.text, ...(line.variants ?? []).map((v) => v.t)])
        for (const m of t.matchAll(/\{(\w+)\}/g)) if (!slots.has(m[1])) bad.push(`${id}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });

  it('has no tagged line that names a slot without the tag that provides it', () => {
    const bad: string[] = [];
    for (const [id, line] of Object.entries(VOICE.lines)) {
      for (const v of line.variants ?? []) {
        if (
          v.t.includes('{target}') &&
          !used(v.when)
            .concat(used(line.when))
            .some((t) => t === 'target.set' || t === 'hostile.hunting')
        )
          bad.push(`${id}: ${v.t}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
