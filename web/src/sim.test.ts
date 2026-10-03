import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { initSync, Sim } from './wasm-pkg/orbit_wasm.js';

// Loads the real WASM build of orbit-sim in Node and checks the orbit.
initSync({ module: readFileSync(new URL('./wasm-pkg/orbit_wasm_bg.wasm', import.meta.url)) });

describe('orbit-wasm', () => {
  it('keeps a circular orbit at constant radius in the z = 0 plane', () => {
    const sim = new Sim(1.0);
    sim.add_circular_orbit(1.0);
    for (let i = 0; i < 1000; i++) sim.step(0.01);
    const [x, y, z] = sim.positions();
    expect(Math.hypot(x, y)).toBeCloseTo(1.0, 4);
    expect(z).toBe(0);
    expect(sim.time()).toBeCloseTo(10, 9);
  });
});
