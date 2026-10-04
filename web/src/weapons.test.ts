import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeEvents, EntityKind, SimEventKind, type SimEvent } from './sim/bridge';
import { FlightSession, SIM_DT } from './sim/session';
import { actionForKey, applyAction, type ClientControl } from './ui/controls';
import { Game, initSync } from './wasm-pkg/orbit_wasm.js';

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

function step(s: FlightSession, seconds: number): SimEvent[] {
  s.game.step(Math.round(seconds / SIM_DT), SIM_DT);
  const events = decodeEvents(s.game.take_events());
  s.setThrottle(0); // refreshes the session's entity snapshot
  return events;
}

describe('weapons', () => {
  it('a missile fired with F destroys the drone ahead', () => {
    const s = new FlightSession(new Game());
    const drone = s.all().find((e) => e.team === 1)!;
    s.setTarget(drone.id);
    applyAction(s, noClient, actionForKey('KeyF')!, true);
    expect(s.player().target).toBe(drone.id);
    expect(s.all().some((e) => e.kind === EntityKind.Missile)).toBe(true);
    const events = [...s.takeEvents(), ...step(s, 120)];
    expect(events.some((e) => e.kind === SimEventKind.Detonation)).toBe(true);
    expect(events.some((e) => e.kind === SimEventKind.ShipDestroyed && e.id === drone.id)).toBe(
      true,
    );
  });

  it('a mine dropped with M sleeps until the low drone passes, then kills it', () => {
    const s = new FlightSession(new Game());
    applyAction(s, noClient, actionForKey('KeyM')!, true);
    const mine = s.all().find((e) => e.kind === EntityKind.Mine)!;
    expect(mine.target).toBeNull();
    const events = step(s, 2400);
    expect(events.some((e) => e.kind === SimEventKind.MineTriggered && e.id === mine.id)).toBe(
      true,
    );
    expect(events.some((e) => e.kind === SimEventKind.ShipDestroyed)).toBe(true);
    expect(s.player().alive).toBe(true);
  });

  it('refuses to fire without a target', () => {
    const s = new FlightSession(new Game());
    expect(s.fireMissile()).toBe(false);
  });
});
