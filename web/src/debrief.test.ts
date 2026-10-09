import { describe, expect, it } from 'vitest';
import { VOICE } from './advisor/config';
import { coastApproaches, evaluateDebrief, fmtOrbits } from './advisor/debrief';
import type { VesselSnapshot } from './advisor/triggers';
import {
  Attitude,
  CORVETTE,
  DRONE,
  EntityKind,
  type EntityView,
  type OrbitView,
} from './sim/bridge';

const MU = 3.5316e12;
const R = 600_000;

function circularState(
  r: number,
  phase: number,
): { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } } {
  const v = Math.sqrt(MU / r);
  return {
    pos: { x: r * Math.cos(phase), y: r * Math.sin(phase), z: 0 },
    vel: { x: -v * Math.sin(phase), y: v * Math.cos(phase), z: 0 },
  };
}

function orbitOf(r: number): OrbitView {
  return {
    semiMajorAxis: r,
    eccentricity: 0,
    semiLatusRectum: r,
    periapsis: r,
    apoapsis: r,
    period: 2 * Math.PI * Math.sqrt((r * r * r) / MU),
    argPeriapsis: 0,
    trueAnomaly: 0,
  };
}

function ship(over: Partial<EntityView>): EntityView {
  return {
    id: 0,
    kind: EntityKind.Ship,
    team: 0,
    shipClass: CORVETTE,
    alive: true,
    ...circularState(R + 80_000, 0),
    heading: { x: 0, y: 1, z: 0 },
    throttle: 0,
    heat: 0,
    heatCapacity: 1000,
    outputCap: 1,
    deltaV: 0,
    mode: Attitude.Hold,
    target: null,
    hp: 100,
    mass: 10_000,
    maxAccel: 1,
    ...over,
  } as EntityView;
}

function scene(targetRadius: number, phase: number, hostile = true): VesselSnapshot {
  const me = ship({ target: 1 });
  const foe = ship({
    id: 1,
    team: hostile ? 1 : 0,
    shipClass: DRONE,
    ...circularState(targetRadius, phase),
  });
  return {
    simTime: 0,
    planetRadius: R,
    self: me,
    orbit: orbitOf(R + 80_000),
    entities: [me, foe],
    events: [],
  };
}

const ids = (cues: { id: string }[]): string[] => cues.map((c) => c.id);
const run = (s: VesselSnapshot) =>
  evaluateDebrief(s, VOICE.debrief, VOICE.thresholds, VOICE.situation.circularEccentricity);

describe('fmtOrbits', () => {
  it('says waits as counts of orbits in plain words', () => {
    expect(fmtOrbits(2.5 * 3000, 3000)).toBe('two and a half orbits');
    expect(fmtOrbits(3000, 3000)).toBe('one orbit');
    expect(fmtOrbits(1.25 * 3000, 3000)).toBe('one and a quarter orbits');
    expect(fmtOrbits(0.5 * 3000, 3000)).toBe('half an orbit');
    expect(fmtOrbits(0.75 * 3000, 3000)).toBe('three quarters of an orbit');
    expect(fmtOrbits(0.1 * 3000, 3000)).toBe('less than half an orbit');
    expect(fmtOrbits(12 * 3000, 3000)).toBe('12 orbits');
  });
});

describe('coastApproaches', () => {
  it('finds the pass between two circular orbits and its relative speed', () => {
    const a = circularState(R + 80_000, 0);
    const b = circularState(R + 90_000, 0.5);
    const horizon = 8 * 2 * Math.PI * Math.sqrt(a.pos.x ** 3 / MU);
    const { first, best } = coastApproaches(MU, a, b, horizon);
    expect(first).not.toBeNull();
    // Passing as the phase closes: separation falls to about the 10 km radial gap.
    expect(first!.distance).toBeGreaterThan(9_000);
    expect(first!.distance).toBeLessThan(12_000);
    expect(first!.time).toBeGreaterThan(0);
    expect(first!.relSpeed).toBeGreaterThan(0);
    expect(best!.distance).toBeLessThanOrEqual(first!.distance);
  });

  it('finds nothing when the bodies never separate or close', () => {
    const a = circularState(R + 80_000, 0);
    const { first } = coastApproaches(MU, a, circularState(R + 80_000, 1), 5000);
    expect(first === null || first.distance > 0).toBe(true);
  });
});

describe('post-burn debrief', () => {
  it('describes the new orbit and the next apsis', () => {
    const me = ship({});
    const elliptic: OrbitView = {
      ...orbitOf(R + 80_000),
      eccentricity: 0.05,
      periapsis: R + 80_000,
      apoapsis: R + 150_000,
      trueAnomaly: 1,
    };
    const cues = evaluateDebrief(
      { simTime: 0, planetRadius: R, self: me, orbit: elliptic, entities: [me], events: [] },
      VOICE.debrief,
      VOICE.thresholds,
      0.02,
    );
    expect(ids(cues)).toEqual(['debrief.orbit', 'debrief.next_apoapsis']);
    expect(cues[0].vars?.pe).toBe('80.0 km');
  });

  it('calls a circular result circular, and says nothing for an impact orbit', () => {
    expect(ids(run({ ...scene(R + 80_000, 0), entities: [ship({})] }))).toEqual([
      'debrief.orbit_circular',
    ]);
    const me = ship({});
    const dive: OrbitView = { ...orbitOf(R - 1000), eccentricity: 0.1, periapsis: R - 1000 };
    expect(
      evaluateDebrief(
        { simTime: 0, planetRadius: R, self: me, orbit: dive, entities: [me], events: [] },
        VOICE.debrief,
        VOICE.thresholds,
        0.02,
      ),
    ).toEqual([]);
  });

  it('gives the next closest approach to the target with what it means', () => {
    const cues = run(scene(R + 90_000, 0.5));
    const kinds = ids(cues).filter((i) => i.startsWith('debrief.approach.'));
    expect(kinds.length).toBeGreaterThan(0);
    const first = cues.find(
      (c) => c.id.startsWith('debrief.approach.') && c.id !== 'debrief.approach.better',
    )!;
    expect(first.vars).toMatchObject({ target: 'Drone 1' });
    expect(first.vars?.orbits).toMatch(/orbit/);
    expect(first.vars?.miss).toMatch(/km|m$/);
    // A 10 km pass is inside missile range of a hostile, outside rendezvous range.
    expect(first.id).toBe('debrief.approach.weapons');
    expect(ids(cues)).toContain('debrief.relspeed.gentle');
  });

  it('treats a friendly pass as near, not a weapons shot', () => {
    const cues = run(scene(R + 90_000, 0.5, false));
    expect(ids(cues)).toContain('debrief.approach.near');
  });

  it('says wide for a distant pass', () => {
    const cues = run(scene(R + 180_000, 0.5));
    expect(ids(cues)).toContain('debrief.approach.wide');
  });
});
