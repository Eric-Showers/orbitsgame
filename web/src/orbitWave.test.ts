import { describe, expect, it } from 'vitest';
import { TAU } from './autopilot/orbitmath';
import { Attitude } from './sim/bridge';
import { altitudeOf, altitudeTrack, plannedBurnsUsable } from './ui/orbitWave';

const MU = 3.986e14;
const R = 6.4e6;
const period = (r: number): number => TAU * Math.sqrt(r ** 3 / MU);

const circ = (r: number, at = 0) => ({
  pos: { x: r * Math.cos(at), y: r * Math.sin(at), z: 0 },
  vel: { x: -Math.sin(at) * Math.sqrt(MU / r), y: Math.cos(at) * Math.sqrt(MU / r), z: 0 },
});

describe('altitude', () => {
  it('is distance from the centre minus the planet radius', () => {
    expect(altitudeOf({ x: 3, y: 4, z: 0 }, 2)).toBe(3);
  });
});

describe('altitude tracks', () => {
  it('stays flat on a circular orbit', () => {
    const { pos, vel } = circ(7e6);
    const track = altitudeTrack(MU, R, pos, vel, 9, period(7e6) * 2);
    expect(track).toHaveLength(9);
    for (const a of track) expect(a).toBeCloseTo(7e6 - R, -1);
  });

  it('swings between periapsis and apoapsis on an ellipse', () => {
    const rp = 7e6;
    const { pos } = circ(rp);
    const vp = Math.sqrt(MU * (2 / rp - 2 / (rp + 1e7)));
    const track = altitudeTrack(MU, R, pos, { x: 0, y: vp, z: 0 }, 3, period((rp + 1e7) / 2));
    expect(track[0]).toBeCloseTo(rp - R, -1);
    expect(track[2]).toBeCloseTo(rp - R, -1);
  });

  it('goes negative when the orbit dips under the ground', () => {
    const { pos, vel } = circ(7e6);
    const slow = { x: vel.x, y: vel.y * 0.8, z: 0 };
    expect(Math.min(...altitudeTrack(MU, R, pos, slow, 61, 3000))).toBeLessThan(0);
  });

  it('applies a planned prograde burn that raises the far side afterwards', () => {
    const { pos, vel } = circ(7e6);
    const coast = altitudeTrack(MU, R, pos, vel, 61, 3000);
    const burned = altitudeTrack(MU, R, pos, vel, 61, 3000, {
      now: 0,
      nodes: [{ time: 0, mode: Attitude.Prograde, dv: 150, label: 'raise' }],
    });
    expect(burned[0]).toBeCloseTo(coast[0], 3);
    expect(Math.max(...burned)).toBeGreaterThan(Math.max(...coast) + 1000);
  });

  it('ignores a target-relative node it cannot place', () => {
    const { pos, vel } = circ(7e6);
    const nodes = [{ time: 0, mode: Attitude.TargetPrograde, dv: 10, label: 'match' }];
    expect(plannedBurnsUsable(pos, vel, nodes)).toBe(false);
    const coast = altitudeTrack(MU, R, pos, vel, 11, 1000);
    expect(altitudeTrack(MU, R, pos, vel, 11, 1000, { now: 0, nodes })).toEqual(coast);
  });
});
