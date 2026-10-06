import { describe, expect, it } from 'vitest';
import { TAU } from './autopilot/orbitmath';
import { Attitude } from './sim/bridge';
import { alignments, phaseGap, phaseOf, phaseTrack, plannedBurnsUsable } from './ui/orbitWave';

const MU = 3.986e14;
const period = (r: number): number => TAU * Math.sqrt(r ** 3 / MU);

const circ = (r: number, at = 0) => ({
  pos: { x: r * Math.cos(at), y: r * Math.sin(at), z: 0 },
  vel: { x: -Math.sin(at) * Math.sqrt(MU / r), y: Math.cos(at) * Math.sqrt(MU / r), z: 0 },
});

describe('phase', () => {
  it('folds gaps into half a turn either side', () => {
    expect(phaseGap(0.1, TAU - 0.1)).toBeCloseTo(0.2, 9);
    expect(phaseGap(TAU - 0.1, 0.1)).toBeCloseTo(-0.2, 9);
  });

  it('wraps the angle of a position into [0, 2pi)', () => {
    expect(phaseOf({ x: 1, y: -1, z: 0 })).toBeCloseTo(TAU - Math.PI / 4, 9);
  });
});

describe('phase tracks', () => {
  it('advances one turn per period on a circular orbit', () => {
    const r = 7e6;
    const { pos, vel } = circ(r);
    const p = period(r);
    const track = phaseTrack(MU, pos, vel, 5, p * 4);
    expect(track).toHaveLength(5);
    for (const a of track) expect(Math.min(a, TAU - a)).toBeLessThan(1e-6);
    const quarter = phaseTrack(MU, pos, vel, 2, p / 4);
    expect(quarter[1]).toBeCloseTo(Math.PI / 2, 6);
  });

  it('a lower orbit pulls ahead of a higher one', () => {
    const low = circ(6.6e6);
    const high = circ(7.4e6);
    const a = phaseTrack(MU, low.pos, low.vel, 31, 3000);
    const b = phaseTrack(MU, high.pos, high.vel, 31, 3000);
    expect(phaseGap(a[10], b[10])).toBeGreaterThan(0);
  });

  it('applies a planned prograde burn that slows the angular rate afterwards', () => {
    const { pos, vel } = circ(7e6);
    const coast = phaseTrack(MU, pos, vel, 61, 3000);
    const burned = phaseTrack(MU, pos, vel, 61, 3000, {
      now: 0,
      nodes: [{ time: 0, mode: Attitude.Prograde, dv: 150, label: 'raise' }],
    });
    expect(burned[0]).toBeCloseTo(coast[0], 9);
    expect(phaseGap(burned[60], coast[60])).not.toBeCloseTo(0, 2);
  });

  it('ignores a target-relative node it cannot place', () => {
    const { pos, vel } = circ(7e6);
    const nodes = [{ time: 0, mode: Attitude.TargetPrograde, dv: 10, label: 'match' }];
    expect(plannedBurnsUsable(pos, vel, nodes)).toBe(false);
    const coast = phaseTrack(MU, pos, vel, 11, 1000);
    const same = phaseTrack(MU, pos, vel, 11, 1000, { now: 0, nodes });
    expect(same).toEqual(coast);
  });
});

describe('alignments', () => {
  it('finds when a chaser laps its target, spaced by the synodic period', () => {
    const rA = 6.6e6;
    const rB = 1.0e7;
    const a = circ(rA);
    const b = circ(rB, 1);
    const horizon = 6 * 3600;
    const ta = phaseTrack(MU, a.pos, a.vel, 721, horizon);
    const tb = phaseTrack(MU, b.pos, b.vel, 721, horizon);
    const hits = alignments(ta, tb, horizon);
    const synodic = 1 / (1 / period(rA) - 1 / period(rB));
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[1] - hits[0]).toBeCloseTo(synodic, -2);
    // The first one is when the chaser covers the 1 rad head start.
    expect(hits[0]).toBeCloseTo(synodic / TAU, -2);
  });

  it('reports none for co-orbiting ships that never meet', () => {
    const a = circ(7e6);
    const b = circ(7e6, 1);
    const horizon = 3600;
    expect(
      alignments(
        phaseTrack(MU, a.pos, a.vel, 61, horizon),
        phaseTrack(MU, b.pos, b.vel, 61, horizon),
        horizon,
      ),
    ).toEqual([]);
  });
});
