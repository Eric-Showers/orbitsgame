import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VesselAdvisor } from './advisor/advisor';
import { AdvisoryChannel, type AdvisoryEvent } from './advisor/channel';
import { playerSnapshot } from './advisor/snapshot';
import { VOICE } from './advisor/config';
import { INTENTS, buildIntent } from './autopilot/intents';
import { pilotCue } from './autopilot/speech';
import { Pilot, type PilotEvent } from './autopilot/pilot';
import type { Maneuver } from './autopilot/types';
import { circularize, changeAltitude } from './autopilot/maneuvers/apsis';
import { MatchVelocity } from './autopilot/maneuvers/match';
import { Rendezvous } from './autopilot/maneuvers/rendezvous';
import { Evade } from './autopilot/maneuvers/evade';
import { DropMine, LaunchMissile } from './autopilot/maneuvers/weapons';
import { Orient } from './autopilot/maneuvers/orient';
import { Attitude, len, sub } from './sim/bridge';
import { FlightSession, SIM_DT } from './sim/session';
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

describe('change altitude', () => {
  it('raises a circular orbit with a Hohmann transfer', () => {
    const w = world(80_000, 80_000);
    const r = fly(w, changeAltitude(150_000));
    const a = alt(w);
    log('raise', r, a, w.session.time, w.session.player().deltaV);
    expect(r.ok).toBe(true);
    expect(Math.abs(a.pe - 150_000)).toBeLessThan(1000);
    expect(Math.abs(a.ap - 150_000)).toBeLessThan(1000);
  });

  it('lowers an orbit', () => {
    const w = world(200_000, 200_000, 2);
    const r = fly(w, changeAltitude(100_000));
    const a = alt(w);
    log('lower', r, a, w.session.time);
    expect(r.ok).toBe(true);
    expect(Math.abs(a.pe - 100_000)).toBeLessThan(1000);
    expect(Math.abs(a.ap - 100_000)).toBeLessThan(1000);
  });

  it('refuses an orbit that grazes the ground', () => {
    const w = world(80_000, 80_000);
    const r = fly(w, changeAltitude(10_000));
    expect(r.ok).toBe(false);
  });
});

describe('match velocity and rendezvous', () => {
  const beaconAhead =
    (meters: number, altitude = 80_000) =>
    (g: Game, id: number) => {
      const r = g.planet_radius() + 80_000;
      const b = g.spawn_ship(BEACON, 2, altitude, altitude, 0, meters / r);
      g.set_target(id, b);
    };

  it('kills relative velocity to a drone on another orbit', () => {
    const w = world(80_000, 80_000, 0, (g, id) => {
      const d = g.spawn_ship(DRONE, 1, 80_000, 120_000, 0, 0.05);
      g.set_target(id, d);
    });
    const target = w.session.player().target!;
    const r = fly(w, new MatchVelocity(target));
    const rel = len(sub(w.session.entity(target)!.vel, w.session.player().vel));
    log('match', r, rel);
    expect(r.ok).toBe(true);
    expect(rel).toBeLessThan(1);
  });

  it('rendezvouses with a beacon ahead in the same orbit', () => {
    const w = world(80_000, 80_000, 0, beaconAhead(25_000));
    const target = w.session.player().target!;
    const r = fly(w, new Rendezvous(target, 1000));
    const t = w.session.entity(target)!;
    const rng = len(sub(t.pos, w.session.player().pos));
    const rel = len(sub(t.vel, w.session.player().vel));
    log('rdv same orbit', r, rng, rel, w.session.time, w.session.player().deltaV);
    expect(r.ok).toBe(true);
    expect(rng).toBeLessThan(2500);
    expect(rel).toBeLessThan(0.5);
  });

  it('rendezvouses with a beacon on a higher orbit, behind us', () => {
    const w = world(80_000, 80_000, 1.0, (g, id) => {
      const R = g.planet_radius() + 140_000;
      const b = g.spawn_ship(BEACON, 2, 140_000, 140_000, 0, -0.5);
      void R;
      g.set_target(id, b);
    });
    const target = w.session.player().target!;
    const r = fly(w, new Rendezvous(target, 1000));
    const t = w.session.entity(target)!;
    const rng = len(sub(t.pos, w.session.player().pos));
    const rel = len(sub(t.vel, w.session.player().vel));
    log('rdv higher', r, rng, rel, w.session.time, w.session.player().deltaV);
    expect(r.ok).toBe(true);
    expect(rng).toBeLessThan(2500);
    expect(rel).toBeLessThan(0.5);
  });
});

describe('orient', () => {
  it('points retrograde and finishes', () => {
    const w = world(80_000, 80_000);
    const r = fly(w, new Orient(Attitude.Retrograde));
    const me = w.session.player();
    const dot = me.heading.x * me.vel.x + me.heading.y * me.vel.y;
    expect(r.ok).toBe(true);
    expect(dot / len(me.vel)).toBeLessThan(-0.99);
  });

  it('refuses a target mode with no target', () => {
    const w = world(80_000, 80_000);
    expect(fly(w, new Orient(Attitude.TargetRetrograde)).ok).toBe(false);
  });
});

describe('weapons scripts', () => {
  const hostile =
    (ahead: number, lo = 80_000, hi = 80_000) =>
    (g: Game, id: number) => {
      const r = g.planet_radius() + 80_000;
      const d = g.spawn_ship(DRONE, 1, lo, hi, 0, ahead / r);
      g.set_target(id, d);
    };

  it('fires a missile only when the intercept check passes', () => {
    const near = world(80_000, 80_000, 0, hostile(15_000));
    const before = near.session.munitionsLeft(near.session.playerId).missiles;
    expect(fly(near, new LaunchMissile(near.session.player().target!)).ok).toBe(true);
    expect(near.session.munitionsLeft(near.session.playerId).missiles).toBe(before - 1);

    const far = world(80_000, 80_000, 0, hostile(120_000));
    const r = fly(far, new LaunchMissile(far.session.player().target!));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/out/);
    expect(far.session.munitionsLeft(far.session.playerId).missiles).toBe(before);
  });

  it('lays a mine only where a hostile will pass', () => {
    const w = world(80_000, 80_000, 0, hostile(-20_000, 77_000, 77_000));
    expect(fly(w, new DropMine()).ok).toBe(true);
    const lonely = world(80_000, 80_000);
    const r = fly(lonely, new DropMine());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/hostile/);
    const high = world(80_000, 80_000, 0, hostile(20_000, 300_000, 300_000));
    expect(fly(high, new DropMine()).ok).toBe(false);
  });

  it('intercepts a drone: closes to missile range and matches speed', () => {
    const w = world(80_000, 80_000, 0, hostile(15_000, 120_000, 120_000));
    const id = w.session.player().target!;
    const r = fly(w, new Rendezvous(id, 6000, 'Intercept', 'intercept'));
    const t = w.session.entity(id)!;
    const rng = len(sub(t.pos, w.session.player().pos));
    log('intercept', r, rng, w.session.time);
    expect(r.ok).toBe(true);
    expect(rng).toBeGreaterThan(3000);
    expect(rng).toBeLessThan(10_000);
    expect(fly(w, new LaunchMissile(id)).ok).toBe(true);
  });
});

describe('evade', () => {
  const shootAtUs = (g: Game, us: number): void => {
    const r = g.planet_radius() + 80_000;
    const gun = g.spawn_ship(2, 1, 80_000, 80_000, 0, 20_000 / r);
    g.set_target(gun, us);
    g.launch_missile(gun);
  };

  it('has nothing to do without a threat', () => {
    const w = world(80_000, 80_000);
    expect(fly(w, new Evade()).ok).toBe(false);
  });

  it('dodges a missile that would otherwise hit', () => {
    const idle = world(80_000, 80_000, 0, shootAtUs);
    for (let t = 0; t < 120; t += 0.25) idle.session.update(0.25);
    const hitIdle = idle.session.player().hp < 100 || !idle.session.player().alive;
    const dodge = world(80_000, 80_000, 0, shootAtUs);
    fly(dodge, new Evade(), 120);
    const hp = dodge.session.player().hp;
    log('evade', {
      hitIdle,
      hp,
      alive: dodge.session.player().alive,
      idleHp: idle.session.player().hp,
    });
    expect(hitIdle).toBe(true);
    expect(dodge.session.player().alive && hp).toBe(100);
  });
});

describe('pilot control', () => {
  it('hands over instantly when the commander touches a control', () => {
    const w = world(80_000, 200_000, 1.0);
    w.pilot.propose(circularize('apoapsis'));
    w.pilot.confirm();
    let guard = 0;
    while (w.session.player().throttle === 0 && guard++ < 2000) w.session.update(0.25);
    expect(w.session.player().throttle).toBeGreaterThan(0);
    w.session.setAttitude(Attitude.Retrograde);
    expect(w.pilot.busy).toBe(false);
    expect(w.events.some((e) => e.kind === 'aborted' && e.cause === 'override')).toBe(true);
    w.session.update(SIM_DT * 2);
    expect(w.session.player().mode).toBe(Attitude.Retrograde);
  });

  it('does nothing without a confirmation, and cancel drops the proposal', () => {
    const w = world(80_000, 200_000);
    w.pilot.propose(circularize());
    expect(w.pilot.proposal).not.toBeNull();
    w.pilot.cancel();
    expect(w.pilot.confirm()).toBe(false);
    for (let t = 0; t < 200; t += 0.25) w.session.update(0.25);
    expect(w.session.player().throttle).toBe(0);
  });

  it('refuses everything when assist is off, and aborts a running maneuver', () => {
    const w = world(80_000, 200_000, 1.0);
    w.pilot.propose(circularize());
    w.pilot.confirm();
    w.session.update(1);
    w.pilot.setAssist(false);
    expect(w.pilot.busy).toBe(false);
    expect(w.pilot.propose(circularize()).feasible).toBe(false);
    w.pilot.setAssist(true);
  });

  it('warps through long coasts on its own and hands the warp back', () => {
    const w = world(80_000, 200_000, 1.0);
    w.session.setWarp(0);
    w.pilot.propose(circularize('apoapsis'));
    w.pilot.confirm();
    let maxWarp = 1;
    for (let i = 0; i < 4000 && w.pilot.busy; i++) {
      w.session.update(0.25);
      maxWarp = Math.max(maxWarp, w.session.effectiveWarp());
    }
    expect(maxWarp).toBeGreaterThan(10);
    expect(w.session.warpIndex).toBe(0);
  });
});

describe('commander layer', () => {
  it('has a proposal and a completion line for every intent', () => {
    const w = world(80_000, 80_000);
    for (const intent of INTENTS) {
      const m = buildIntent(intent, { target: 99, altitudeKm: 120 });
      expect(typeof m).not.toBe('string');
      if (typeof m === 'string') continue;
      expect(VOICE.lines[`ap.propose.${m.kind}`] ?? VOICE.lines['ap.propose']).toBeDefined();
      expect(VOICE.lines[`ap.done.${m.kind}`] ?? VOICE.lines['ap.done']).toBeDefined();
    }
    void w;
  });

  it('asks for a target instead of building a target intent without one', () => {
    for (const intent of INTENTS.filter((i) => i.needs === 'target')) {
      expect(typeof buildIntent(intent, { target: null, altitudeKm: 120 })).toBe('string');
    }
  });

  it('ARGUS explains, confirms and reports a Hohmann in full sentences with no blanks', () => {
    const w = world(80_000, 80_000);
    const channel = new AdvisoryChannel();
    const spoken: AdvisoryEvent[] = [];
    channel.subscribe((e) => spoken.push(e));
    const advisor = new VesselAdvisor(channel);
    let clock = 0;
    w.pilot.subscribe((ev) => {
      const cue = pilotCue(ev, w.pilot.speechVars());
      clock += 10; // each line gets the voice to itself
      if (cue) advisor.announce(cue, playerSnapshot(w.session, []), clock);
    });
    const intent = INTENTS.find((i) => i.id === 'set-altitude')!;
    const m = buildIntent(intent, { target: null, altitudeKm: 140 }) as Maneuver;
    expect(fly(w, m).ok).toBe(true);
    const ids = spoken.map((e) => e.id);
    log(spoken.map((e) => e.text));
    expect(ids).toContain('ap.propose.altitude');
    expect(ids).toContain('ap.start');
    expect(ids).toContain('ap.done.altitude');
    for (const e of spoken) expect(e.text).not.toMatch(/[{}]/);
    expect(spoken.find((e) => e.id === 'ap.propose.altitude')!.text).toMatch(/140\.0 km/);
  });

  it('refuses out loud when assist is off', () => {
    const w = world(80_000, 80_000);
    w.pilot.setAssist(false);
    const refused: PilotEvent[] = [];
    w.pilot.subscribe((e) => refused.push(e));
    w.pilot.propose(circularize());
    expect(refused.some((e) => e.kind === 'refused')).toBe(true);
    w.pilot.setAssist(true);
  });
});
