import { describe, expect, it } from 'vitest';
import { Attitude } from './sim/bridge';
import {
  apoapsisOf,
  periapsisOf,
  projectBurns,
  sampleWave,
  waveCrossings,
  waveFromState,
  waveRadius,
  type WaveOrbit,
} from './ui/orbitWave';

const MU = 3.986e14;

const circ = (
  r: number,
): { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } } => ({
  pos: { x: r, y: 0, z: 0 },
  vel: { x: 0, y: Math.sqrt(MU / r), z: 0 },
});

describe('wave sampling', () => {
  const o: WaveOrbit = { p: 7_000_000 * (1 - 0.01 ** 2), e: 0.01, w: 0.5 };

  it('peaks at apoapsis and bottoms at periapsis, half a turn apart', () => {
    const e: WaveOrbit = { p: 8_000_000 * 0.75, e: 0.25, w: 1 };
    expect(waveRadius(e, e.w)).toBeCloseTo(periapsisOf(e), 3);
    expect(waveRadius(e, e.w + Math.PI)).toBeCloseTo(apoapsisOf(e)!, 3);
    const s = sampleWave(e, 361).filter((v): v is number => v !== null);
    expect(Math.max(...s)).toBeCloseTo(apoapsisOf(e)!, -2);
    expect(Math.min(...s)).toBeCloseTo(periapsisOf(e)!, -2);
  });

  it('closes the loop and keeps a circle flat', () => {
    const s = sampleWave(o, 181);
    expect(s[0]).toBeCloseTo(s[180]!, 3);
    const c = sampleWave({ p: 7e6, e: 0, w: 0 }, 50);
    expect(new Set(c.map((v) => Math.round(v!))).size).toBe(1);
  });

  it('leaves gaps where an open orbit has no point', () => {
    const hyper: WaveOrbit = { p: 1e7, e: 1.5, w: 0 };
    expect(apoapsisOf(hyper)).toBeNull();
    const s = sampleWave(hyper, 181);
    expect(s[90]).toBeNull();
    expect(s[0]).not.toBeNull();
  });

  it('caps radii above the plot ceiling', () => {
    expect(sampleWave({ p: 1e7, e: 0.9, w: 0 }, 181, 2e7).some((v) => v === null)).toBe(true);
  });
});

describe('elements from a state', () => {
  it('recovers a circular orbit', () => {
    const { pos, vel } = circ(7e6);
    const w = waveFromState(MU, pos, vel)!;
    expect(w.e).toBeCloseTo(0, 6);
    expect(periapsisOf(w)).toBeCloseTo(7e6, 0);
  });

  it('puts periapsis at the burn point after a prograde kick', () => {
    const { pos, vel } = circ(7e6);
    const w = waveFromState(MU, pos, { x: 0, y: vel.y + 100, z: 0 })!;
    expect(w.e).toBeGreaterThan(0);
    expect(Math.cos(w.w)).toBeCloseTo(1, 6);
    expect(periapsisOf(w)).toBeCloseTo(7e6, 0);
    expect(apoapsisOf(w)!).toBeGreaterThan(7e6);
  });

  it('rejects a radial state', () => {
    expect(waveFromState(MU, { x: 7e6, y: 0, z: 0 }, { x: 10, y: 0, z: 0 })).toBeNull();
  });
});

describe('crossings', () => {
  it('finds two intersections of an ellipse and a circle through it', () => {
    const ell: WaveOrbit = { p: 7.5e6 * (1 - 0.1 ** 2), e: 0.1, w: 0 };
    const hits = waveCrossings(ell, { p: 7.5e6, e: 0, w: 0 });
    expect(hits).toHaveLength(2);
    for (const th of hits) expect(waveRadius(ell, th)).toBeCloseTo(7.5e6, 0);
  });

  it('reports nothing for the same orbit, even with float noise', () => {
    expect(waveCrossings({ p: 7e6, e: 0, w: 0 }, { p: 7e6 + 0.001, e: 1e-9, w: 1 })).toHaveLength(
      0,
    );
  });

  it('finds none between nested circles', () => {
    expect(waveCrossings({ p: 7e6, e: 0, w: 0 }, { p: 8e6, e: 0, w: 0 })).toHaveLength(0);
  });

  it('finds two between ellipses rotated against each other', () => {
    const a: WaveOrbit = { p: 7e6 * 0.96, e: 0.2 * 0 + 0.2, w: 0 };
    const b: WaveOrbit = { p: 7e6 * 0.96, e: 0.2, w: Math.PI / 2 };
    const hits = waveCrossings(a, b);
    expect(hits).toHaveLength(2);
    for (const th of hits) expect(waveRadius(a, th)).toBeCloseTo(waveRadius(b, th)!, 0);
  });
});

describe('projected burns', () => {
  it('a prograde burn raises the far side, and a second one at apoapsis circularizes higher', () => {
    const { pos, vel } = circ(7e6);
    const dv1 = 80;
    const [first] = projectBurns(MU, pos, vel, 0, [
      { time: 0, mode: Attitude.Prograde, dv: dv1, label: 'raise' },
    ]);
    expect(periapsisOf(first.after)).toBeCloseTo(7e6, 0);
    expect(apoapsisOf(first.after)!).toBeGreaterThan(7.3e6);
    expect(first.theta).toBeCloseTo(0, 9);
    expect(first.radius).toBeCloseTo(7e6, 3);

    const half = Math.PI * Math.sqrt(((7e6 + apoapsisOf(first.after)!) / 2) ** 3 / MU);
    const vAp = Math.sqrt(MU / apoapsisOf(first.after)!);
    const vApActual = Math.sqrt(
      MU * (2 / apoapsisOf(first.after)! - 2 / (7e6 + apoapsisOf(first.after)!)),
    );
    const burns = projectBurns(MU, pos, vel, 0, [
      { time: 0, mode: Attitude.Prograde, dv: dv1, label: 'raise' },
      { time: half, mode: Attitude.Prograde, dv: vAp - vApActual, label: 'circ' },
    ]);
    expect(burns).toHaveLength(2);
    expect(burns[1].after.e).toBeLessThan(1e-3);
    expect(burns[1].after.p).toBeCloseTo(apoapsisOf(first.after)!, -1);
  });

  it('a retrograde burn lowers the opposite side', () => {
    const { pos, vel } = circ(7e6);
    const [b] = projectBurns(MU, pos, vel, 0, [
      { time: 0, mode: Attitude.Retrograde, dv: 60, label: 'lower' },
    ]);
    expect(periapsisOf(b.after)).toBeLessThan(7e6 - 1e5);
    expect(apoapsisOf(b.after)).toBeCloseTo(7e6, 0);
  });

  it('stops at a target-relative node it cannot place', () => {
    const { pos, vel } = circ(7e6);
    expect(
      projectBurns(MU, pos, vel, 0, [
        { time: 0, mode: Attitude.TargetPrograde, dv: 10, label: 'match' },
      ]),
    ).toHaveLength(0);
  });
});
