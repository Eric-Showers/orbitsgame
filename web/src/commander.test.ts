import { describe, expect, it } from 'vitest';
import { VesselAdvisor } from './advisor/advisor';
import { AdvisoryChannel, type AdvisoryEvent } from './advisor/channel';
import { VOICE } from './advisor/config';
import { PERSONAS } from './advisor/personas';
import { speechSeconds } from './advisor/queue';
import { addressCommander, cleanName, CommanderName, DEFAULT_COMMANDER } from './commander';
import { Attitude, CORVETTE, EntityKind, type EntityView } from './sim/bridge';

function memory(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

describe('commander name', () => {
  it('cleans markup, spacing and shouting', () => {
    expect(cleanName('  <b>Eric</b>  ')).toBe('bEric/b');
    expect(cleanName('Ada   Lovelace')).toBe('Ada Lovelace');
    expect(cleanName('ERIC')).toBe('Eric');
    expect(cleanName('x'.repeat(40))).toHaveLength(24);
  });

  it('falls back to the title, remembers a chosen name, and tells listeners', () => {
    const mem = memory();
    const c = new CommanderName(mem);
    expect(c.name).toBe(DEFAULT_COMMANDER);
    expect(c.custom).toBe(false);
    const heard: string[] = [];
    c.subscribe((n) => heard.push(n));
    c.set('Eric');
    expect(heard).toEqual(['Eric']);
    expect(new CommanderName(mem).name).toBe('Eric');
    c.set('   ');
    expect(c.name).toBe(DEFAULT_COMMANDER);
    expect(new CommanderName(mem).custom).toBe(false);
  });

  it('swaps the word Commander for the name and nothing else', () => {
    expect(addressCommander('Yes, Commander. Commanders vary.', 'Eric')).toBe(
      'Yes, Eric. Commanders vary.',
    );
    expect(addressCommander('Yes, Commander.', DEFAULT_COMMANDER)).toBe('Yes, Commander.');
  });

  it('is what the AI calls the player in lines and coaching', () => {
    const ch = new AdvisoryChannel();
    const heard: AdvisoryEvent[] = [];
    ch.subscribe((e) => heard.push(e));
    const advisor = new VesselAdvisor(ch);
    advisor.setCommander('Eric');
    const me: EntityView = {
      id: 0,
      kind: EntityKind.Ship,
      team: 0,
      shipClass: CORVETTE,
      alive: true,
      pos: { x: 680_000, y: 0, z: 0 },
      vel: { x: 0, y: 2_100, z: 0 },
      heading: { x: 0, y: 1, z: 0 },
      throttle: 0,
      heat: 0,
      heatCapacity: 600,
      outputCap: 1,
      deltaV: 0,
      mode: Attitude.Hold,
      target: null,
      hp: 100,
      mass: 10_000,
      maxAccel: 10,
    };
    const snap = {
      simTime: 0,
      planetRadius: 600_000,
      self: me,
      orbit: null,
      entities: [me],
      events: [],
    };
    advisor.announce({ id: 'coach', text: 'Lesson one, Commander.' }, snap, 0);
    advisor.observe(snap, 1);
    const said = heard.map((e) => e.text).join(' ');
    expect(said).toContain('Lesson one, Eric.');
    expect(said).toContain('Eric');
    expect(said).not.toContain('Commander');
  });
});

describe('dialogue pace', () => {
  it('reads a typical line in a few seconds, not ten', () => {
    const line = 'Missile inbound, 12 kilometres and closing 300 metres per second. Evade now.';
    for (const p of PERSONAS) {
      expect(speechSeconds(line, VOICE, p.speech.wordsPerMinute)).toBeLessThan(5);
    }
    expect(VOICE.speech.gapSeconds).toBeLessThanOrEqual(0.2);
  });
});
