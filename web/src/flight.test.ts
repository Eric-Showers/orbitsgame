import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Attitude, len } from './sim/bridge';
import { FlightSession, LOW_ORBIT_ALT, MAX_WARP_UNDER_THRUST, SIM_DT } from './sim/session';
import { ACTIONS, actionForKey, applyAction, type ClientControl } from './ui/controls';
import { Game, initSync } from './wasm-pkg/orbit_wasm.js';

// Runs the real WASM build of the sim in Node.
initSync({ module: readFileSync(new URL('./wasm-pkg/orbit_wasm_bg.wasm', import.meta.url)) });

const noClient: ClientControl = {
  zoomBy: () => {},
  toggleFocus: () => {},
  cycleFocus: () => {},
  focusOnTarget: () => false,
  toggleFreeCamera: () => {},
  recentre: () => {},
  setPan: () => {},
  restart: () => {},
};

function run(session: FlightSession, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.1) session.update(0.1);
}

describe('flight session', () => {
  it('starts the player in a circular low orbit', () => {
    const s = new FlightSession(new Game());
    const orbit = s.orbit(s.playerId)!;
    expect(orbit.eccentricity).toBeLessThan(1e-9);
    expect(len(s.player().pos) - s.planetRadius).toBeCloseTo(LOW_ORBIT_ALT, 3);
  });

  it('raises apoapsis with a prograde burn driven by key actions', () => {
    const s = new FlightSession(new Game());
    applyAction(s, noClient, actionForKey('Digit1')!, true);
    applyAction(s, noClient, actionForKey('KeyZ')!, true);
    expect(s.player().mode).toBe(Attitude.Prograde);
    run(s, 10);
    applyAction(s, noClient, actionForKey('KeyX')!, true);
    const orbit = s.orbit(s.playerId)!;
    expect(orbit.apoapsis - s.planetRadius).toBeGreaterThan(LOW_ORBIT_ALT + 20_000);
    expect(s.player().throttle).toBe(0);
    expect(s.player().deltaV).toBeLessThan(1500);
  });

  it('caps time warp while the engine fires', () => {
    const s = new FlightSession(new Game());
    s.setWarp(5);
    expect(s.effectiveWarp()).toBe(100);
    s.setThrottle(0.5);
    expect(s.effectiveWarp()).toBe(MAX_WARP_UNDER_THRUST);
  });

  it('pauses the sim clock', () => {
    const s = new FlightSession(new Game());
    applyAction(s, noClient, actionForKey('KeyP')!, true);
    run(s, 2);
    expect(s.time).toBe(0);
    applyAction(s, noClient, actionForKey('KeyP')!, true);
    run(s, 1);
    expect(s.time).toBeGreaterThan(1 - 2 * SIM_DT);
  });

  it('only allows target modes with a target, and never out-of-plane modes', () => {
    const s = new FlightSession(new Game());
    expect(s.setAttitude(Attitude.TargetRetrograde)).toBe(false);
    expect(s.setAttitude(Attitude.Normal)).toBe(false);
    applyAction(s, noClient, actionForKey('KeyT')!, true);
    expect(s.player().target).not.toBeNull();
    expect(s.setAttitude(Attitude.TargetRetrograde)).toBe(true);
  });

  it('rotate keys turn the ship while held and drop to HOLD', () => {
    const s = new FlightSession(new Game());
    s.setAttitude(Attitude.Prograde);
    const h0 = s.player().heading;
    const rot = actionForKey('KeyA')!;
    applyAction(s, noClient, rot, true);
    run(s, 1);
    applyAction(s, noClient, rot, false);
    const h1 = s.player().heading;
    expect(s.player().mode).toBe(Attitude.Hold);
    expect(h0.x * h1.y - h0.y * h1.x).toBeGreaterThan(0.3); // turned counter-clockwise
  });
});

describe('control map', () => {
  it('binds every key to exactly one action', () => {
    const keys = ACTIONS.flatMap((a) => a.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('names the attitude modes with orbital terms', () => {
    const labels = ACTIONS.filter((a) => a.group === 'attitude').map((a) => a.label);
    for (const term of [
      'PROGRADE',
      'RETROGRADE',
      'RADIAL OUT',
      'RADIAL IN',
      'NORMAL',
      'ANTI-NORMAL',
    ]) {
      expect(labels).toContain(term);
    }
  });
});
