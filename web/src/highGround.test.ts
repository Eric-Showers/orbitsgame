import { describe, expect, it } from 'vitest';
import { highGround } from './ui/highGround';

const MU = 3.5316e12;
const R = 600_000;

describe('highGround', () => {
  it('flags the higher ship and measures drift from circular speeds', () => {
    const g = highGround(
      MU,
      { radius: R + 100_000, semiMajorAxis: R + 100_000 },
      { radius: R + 80_000, semiMajorAxis: R + 80_000 },
    );
    expect(g.side).toBe('high');
    expect(g.altDiff).toBeCloseTo(20_000);
    expect(g.drift).toBeCloseTo(32.8, 0);
    expect(g.kvMargin).toBeGreaterThan(0);
  });

  it('is even inside the band and low when below', () => {
    const a = { radius: R + 80_000, semiMajorAxis: R + 80_000 };
    expect(highGround(MU, a, { ...a, radius: R + 81_000 }).side).toBe('even');
    expect(highGround(MU, a, { radius: R + 100_000, semiMajorAxis: R + 100_000 }).side).toBe(
      'low',
    );
  });

  it('turns the KV margin negative on a large gap', () => {
    const g = highGround(
      MU,
      { radius: R + 80_000, semiMajorAxis: R + 80_000 },
      { radius: R + 300_000, semiMajorAxis: R + 300_000 },
    );
    expect(g.kvMargin).toBeLessThan(0);
  });
});
