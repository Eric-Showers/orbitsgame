import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Pilot, type PilotEvent } from './autopilot/pilot';
import type { Maneuver } from './autopilot/types';
import { circularize, changeAltitude } from './autopilot/maneuvers/apsis';
import { MatchVelocity } from './autopilot/maneuvers/match';
import { Rendezvous } from './autopilot/maneuvers/rendezvous';
import { Evade } from './autopilot/maneuvers/evade';
import { Orient } from './autopilot/maneuvers/orient';
import { Attitude, len, sub } from './sim/bridge';
import { FlightSession } from './sim/session';
import { CORVETTE, BEACON, DRONE } from './sim/bridge';
import { Game, initSync } from './wasm-pkg/orbit_wasm.js';

initSync({ module: readFileSync(new URL('./wasm-pkg/orbit_wasm_bg.wasm', import.meta.url)) });

const log = (...a: unknown[]): void => void process.stderr.write(JSON.stringify(a) + '\n');

interface World {
  session: FlightSession;
  pilot: Pilot;
  events: PilotEvent[];
}

/** Player corvette at (pe, ap) altitudes and true anomaly `nu`; `extra` spawns more ships. */
function world(
  pe: number,
  ap: number,
  nu = 0,
  extra: (g: Game, id: number) => void = () => {},
): World {
  const session = new FlightSession(new Game(), (g) => {
    const id = g.spawn_ship(CORVETTE, 0, pe, ap, 0, nu);
    extra(g, id);
    return id;
  });
  const pilot = new Pilot(session);
  const events: PilotEvent[] = [];
  pilot.subscribe((e) => events.push(e));
  return { session, pilot, events };
}

/** Proposes, confirms and flies a maneuver headlessly until it ends (or the sim-time budget runs out). */
function fly(w: World, m: Maneuver, budget = 20_000): { ok: boolean; reason?: string } {
  const plan = w.pilot.propose(m);
  if (!plan.feasible) return { ok: false, reason: plan.reason };
  expect(w.pilot.confirm()).toBe(true);
  const t0 = w.session.time;
  while (w.pilot.busy && w.session.time - t0 < budget) w.session.update(0.25);
  const end = [...w.events].reverse().find((e) => e.kind === 'done' || e.kind === 'failed');
  if (end?.kind === 'done') return { ok: true };
  return { ok: false, reason: end?.kind === 'failed' ? end.reason : 'budget exceeded' };
}

const alt = (w: World): { pe: number; ap: number; e: number } => {
  const o = w.session.orbit(w.session.playerId)!;
  const R = w.session.planetRadius;
  return { pe: o.periapsis - R, ap: o.apoapsis - R, e: o.eccentricity };
};

describe('circularize', () => {
  it('rounds an ellipse at apoapsis', () => {
    const w = world(80_000, 200_000, 1.0);
    const r = fly(w, circularize('apoapsis'));
    const a = alt(w);
    log('circularize', r, a, w.session.time, w.session.player().deltaV);
    expect(r.ok).toBe(true);
    expect(Math.abs(a.ap - a.pe)).toBeLessThan(500);
  });
});
