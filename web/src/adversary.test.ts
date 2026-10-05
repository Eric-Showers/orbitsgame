import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADVERSARY_CONFIG as CFG } from './adversary/config';
import { decide, newMemory } from './adversary/decide';
import type { Perception, Threat } from './adversary/perception';
import { orbitalAdvantage } from './adversary/scoring';
import { loadMissions } from './missions/load';
import { MissionRun } from './missions/run';
import { Attitude, EntityKind } from './sim/bridge';
import { Game, initSync } from './wasm-pkg/orbit_wasm.js';

initSync({ module: readFileSync(new URL('./wasm-pkg/orbit_wasm_bg.wasm', import.meta.url)) });

const threat = (o: Partial<Threat> = {}): Threat => ({
  id: 9,
  kind: EntityKind.Missile,
  range: 30000,
  closing: 800,
  tgo: 37,
  approach: { x: 1, y: 0, z: 0 },
  deltaV: 700,
  miss: 0,
  blastRadius: 500,
  ...o,
});

const view = (threats: Threat[], load = 0.1): Perception =>
  ({
    time: 0,
    planetRadius: 600000,
    me: {
      id: 1,
      alive: true,
      heading: { x: 0, y: 1, z: 0 },
      heatCapacity: 100,
      pos: { x: 680000, y: 0, z: 0 },
      vel: { x: 0, y: 1000, z: 0 },
    },
    stats: {},
    orbit: { sma: 680000, ecc: 0 },
    foe: undefined,
    foeRange: Infinity,
    threats,
    load,
    peAlt: 80000,
    apAlt: 80000,
    standoff: 20000,
  }) as unknown as Perception;

describe('adversary decisions', () => {
  it('tier 0 never reacts', () => {
    const mem = newMemory();
    for (let t = 0; t < 60; t++) {
      const c = decide(0, view([threat({ range: 5000, tgo: 6 })]), mem, CFG);
      expect(c.throttle).toBe(0);
    }
  });

  it('tier 1 ignores far threats, burns once when one is inside warn range', () => {
    const mem = newMemory();
    expect(
      decide(1, view([threat({ range: CFG.reactive.warnRange * 2 })]), mem, CFG).throttle,
    ).toBe(0);
    const p = view([threat({ range: CFG.reactive.warnRange * 0.5 })]);
    const c = decide(1, p, mem, CFG);
    expect(c.intent).toBe('counter');
    expect([
      Attitude.Prograde,
      Attitude.Retrograde,
      Attitude.RadialOut,
      Attitude.RadialIn,
    ]).toContain(c.attitude);
  });

  it('tier 2 starts its counter earlier than tier 1 and only for dangerous threats', () => {
    const early = view([
      threat({ range: CFG.reactive.warnRange * 1.8, tgo: CFG.anticipate.commitSeconds - 5 }),
    ]);
    const mem = newMemory();
    early.time = 1;
    const c = decide(2, early, mem, CFG);
    expect(['prepare', 'counter']).toContain(c.intent);
    expect(decide(1, early, newMemory(), CFG).intent).toBe('idle');
    const spent = view([threat({ deltaV: 0, miss: 5000 })]);
    expect(decide(2, spent, newMemory(), CFG).intent).toBe('idle');
  });

  it('a hot ship coasts instead of burning', () => {
    const p = view([threat({ range: 8000, tgo: 10 })], 0.9);
    const mem = newMemory();
    let max = 0;
    for (let t = 0; t < 40; t++) max = Math.max(max, decide(1, p, mem, CFG).throttle);
    expect(max).toBe(0);
  });

  it('scores orbit-size burns by their effect on drift to the foe', () => {
    const mu = 3.5316e12;
    const at = (alt: number, ang: number) => {
      const r = 600000 + alt;
      const v = Math.sqrt(mu / r);
      return {
        pos: { x: r * Math.cos(ang), y: r * Math.sin(ang), z: 0 },
        vel: { x: -v * Math.sin(ang), y: v * Math.cos(ang), z: 0 },
      };
    };
    const me = { ...view([threat()]).me, ...at(100000, 0) };
    const foe = { ...me, id: 2, ...at(80000, 0.3) };
    const p = {
      ...view([threat()]),
      me,
      foe,
      orbit: { ...view([]).orbit, semiMajorAxis: 700000, eccentricity: 0 },
    } as unknown as Perception;
    // Under threat: pulling further from the foe's orbit (prograde) gains drift.
    expect(orbitalAdvantage(p, Attitude.Prograde)).toBeGreaterThan(0);
    expect(orbitalAdvantage(p, Attitude.Retrograde)).toBeLessThan(0);
    expect(orbitalAdvantage(p, Attitude.RadialOut)).toBe(0);
    // Nothing inbound: the sign flips, staying matched is preferred.
    const calm = { ...p, threats: [] } as Perception;
    expect(orbitalAdvantage(calm, Attitude.Prograde)).toBeLessThan(0);
    expect(orbitalAdvantage({ ...p, foe: undefined } as Perception, Attitude.Prograde)).toBe(0);
  });
});

const MISSIONS = loadMissions();
const NEW = ['kestrel', 'shrike', 'hunter', 'wolf-pack', 'last-convoy'];

/** Scripted solution: volleys at the nearest hostile once it is inside `inside` metres. */
function solve(id: string, salvo: number, gap: number, inside: number): MissionRun {
  const run = new MissionRun(
    new Game(),
    MISSIONS.find((m) => m.id === id)!,
  );
  const s = run.session;
  let t = 0;
  let next = 0;
  while (run.outcome === 'running' && t < 3000) {
    if (t >= next) {
      const me = s.player();
      const dist = (e: { pos: { x: number; y: number } }): number =>
        Math.hypot(e.pos.x - me.pos.x, e.pos.y - me.pos.y);
      const foe = s
        .all()
        .filter((e) => e.alive && e.team === 1 && e.kind === EntityKind.Ship)
        .sort((a, b) => dist(a) - dist(b))[0];
      if (foe && dist(foe) < inside) {
        s.setTarget(foe.id);
        let n = 0;
        for (let k = 0; k < salvo; k++) if (s.fireMissile()) n++;
        next = t + (n ? gap : 5);
      }
    }
    run.update(0.25);
    t += 0.25;
  }
  return run;
}

describe('adversary missions', () => {
  it('extends the ladder with five adversary missions, none timed', () => {
    for (const id of NEW) {
      const m = MISSIONS.find((x) => x.id === id)!;
      expect(m, id).toBeDefined();
      expect(m.ships.some((sh) => sh.ai?.pilot)).toBe(true);
      expect(JSON.stringify(m)).not.toMatch(/timeLimit/);
    }
    expect(MISSIONS.length).toBe(17);
  });

  const plans: Record<string, [number, number, number]> = {
    kestrel: [2, 60, 1e9],
    shrike: [2, 60, 1e9],
    hunter: [2, 40, 30000],
    'wolf-pack': [2, 100, 1e9],
    'last-convoy': [2, 60, 1e9],
  };
  for (const id of NEW) {
    it(`${id} is winnable with a scripted salvo plan`, () => {
      expect(solve(id, ...plans[id]!).outcome).toBe('won');
    }, 120_000);
  }

  it('a lone missile cannot kill a Tier 2 pilot', () => {
    const run = new MissionRun(
      new Game(),
      MISSIONS.find((m) => m.id === 'shrike')!,
    );
    const s = run.session;
    s.setTarget(run.ids.get('shrike')!);
    expect(s.fireMissile()).toBe(true);
    for (let t = 0; t < 400 && run.outcome === 'running'; t += 0.25) run.update(0.25);
    expect(run.outcome).toBe('running');
  }, 60_000);
});
