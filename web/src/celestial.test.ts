import { describe, expect, it } from 'vitest';
import { inPlanetShadow, moonPeriod, moonPosition, sunDirection } from './render/celestial';

const MU = 3.5316e12;
const R = 600_000;

describe('celestial bodies', () => {
  it('keeps the sun direction a unit vector at its configured angle', () => {
    const s = sunDirection(0, { angleDeg: 90, rateDegPerHour: 0, edgeMarginPx: 0 });
    expect(s.x).toBeCloseTo(0);
    expect(s.y).toBeCloseTo(1);
    const turned = sunDirection(3600, { angleDeg: 0, rateDegPerHour: 90, edgeMarginPx: 0 });
    expect(turned.y).toBeCloseTo(1);
  });

  it('returns the moon to its start after one Kepler period at a constant radius', () => {
    const t = moonPeriod(MU);
    const a = moonPosition(0, MU);
    const b = moonPosition(t, MU);
    expect(b.x).toBeCloseTo(a.x, 3);
    expect(b.y).toBeCloseTo(a.y, 3);
    const c = moonPosition(t / 3, MU);
    expect(Math.hypot(c.x, c.y)).toBeCloseTo(Math.hypot(a.x, a.y), 3);
  });

  it('shadows only the anti-sunward cylinder behind the planet', () => {
    const sun = { x: 1, y: 0 };
    expect(inPlanetShadow({ x: -2 * R, y: 0.5 * R }, sun, R)).toBe(true);
    expect(inPlanetShadow({ x: -2 * R, y: 1.5 * R }, sun, R)).toBe(false);
    expect(inPlanetShadow({ x: 2 * R, y: 0 }, sun, R)).toBe(false);
  });
});
