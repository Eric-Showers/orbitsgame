import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EntityKind } from './sim/bridge';
import { FlightSession } from './sim/session';
import { munitionStats, orbitStats, resourceStats, targetStats } from './ui/hudData';
import { Game, initSync } from './wasm-pkg/orbit_wasm.js';

initSync({ module: readFileSync(new URL('./wasm-pkg/orbit_wasm_bg.wasm', import.meta.url)) });

describe('hud data', () => {
  it('reports own orbit apsides with times to each', () => {
    const s = new FlightSession(new Game());
    const o = s.orbit(s.player().id)!;
    const os = orbitStats(o, s.planetRadius);
    expect(os.apAlt).toBeCloseTo(80_000, -2);
    expect(os.peAlt).toBeCloseTo(80_000, -2);
    expect(os.peEta).toBeGreaterThanOrEqual(0);
    expect(os.peEta).toBeLessThanOrEqual(os.period);
  });

  it('reports the target orbit, range and closing speed', () => {
    const s = new FlightSession(new Game());
    const drone = s.all().find((e) => e.team === 1)!;
    const t = targetStats(s, s.player(), drone);
    expect(t.range).toBeCloseTo(15_000, -2);
    expect(t.orbit?.peAlt).toBeCloseTo(80_000, -2);
    expect(t.dvMatch).toBeGreaterThanOrEqual(0);
  });

  it('shows magazines and a missile in flight with its target', () => {
    const s = new FlightSession(new Game());
    const drone = s.all().find((e) => e.team === 1)!;
    s.setTarget(drone.id);
    const before = resourceStats(s, s.player());
    expect(s.fireMissile()).toBe(true);
    expect(resourceStats(s, s.player()).missiles).toBe(before.missiles - 1);
    const m = munitionStats(s).find((x) => x.kind === EntityKind.Missile)!;
    expect(m.targetId).toBe(drone.id);
    expect(m.mainDv).toBeGreaterThan(0);
    expect(m.range).toBeGreaterThan(0);
  });
});
