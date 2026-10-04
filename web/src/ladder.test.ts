import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Evade } from './autopilot/maneuvers/evade';
import { MatchVelocity } from './autopilot/maneuvers/match';
import { Rendezvous } from './autopilot/maneuvers/rendezvous';
import { Pilot } from './autopilot/pilot';
import type { Maneuver } from './autopilot/types';
import { loadMissions } from './missions/load';
import { MissionRun } from './missions/run';
import { Attitude, EntityKind, len, sub } from './sim/bridge';
import { Game, initSync } from './wasm-pkg/orbit_wasm.js';

initSync({ module: readFileSync(new URL('./wasm-pkg/orbit_wasm_bg.wasm', import.meta.url)) });

const log = (...a: unknown[]): void => void process.stderr.write(JSON.stringify(a) + '\n');
const MISSIONS = loadMissions();
const start = (id: string): MissionRun =>
  new MissionRun(
    new Game(),
    MISSIONS.find((m) => m.id === id)!,
  );

function fly(run: MissionRun, seconds: number, until: () => boolean = () => false): void {
  const end = run.session.time + seconds;
  while (run.session.time < end && run.outcome === 'running' && !until()) run.update(0.25);
}

/** Flies an autopilot maneuver to completion inside the mission loop. */
function autopilot(run: MissionRun, pilot: Pilot, m: Maneuver, budget = 20_000): boolean {
  const plan = pilot.propose(m);
  if (!plan.feasible) {
    log('infeasible', plan.reason);
    return false;
  }
  pilot.confirm();
  fly(run, budget, () => !pilot.busy);
  return !pilot.busy;
}

/** Nudges the last few hundred metres by hand, then kills the leftover speed. */
function closeIn(run: MissionRun, pilot: Pilot, tag: string, within = 250): void {
  const s = run.session;
  const id = run.ids.get(tag)!;
  s.setTarget(id);
  s.setAttitude(Attitude.Target);
  fly(run, 20);
  s.setThrottle(0.01);
  fly(run, 120, () => range(run, tag) < within);
  s.setThrottle(0);
  autopilot(run, pilot, new MatchVelocity(id));
}

/** Targets `tag`, fires one missile, and waits for it to detonate or expire. */
function shoot(run: MissionRun, tag: string): void {
  const s = run.session;
  s.setTarget(run.ids.get(tag)!);
  expect(s.fireMissile()).toBe(true);
  const live = (): boolean =>
    s.all().some((e) => e.alive && e.kind === EntityKind.Missile && e.team === 0);
  fly(run, 700, () => !live());
}

/** Fires salvos of up to two missiles at `tag` once inside `reach`, until it dies or the run ends. */
function hunt(run: MissionRun, tag: string, reach: number, budget = 4000): void {
  const s = run.session;
  const id = run.ids.get(tag)!;
  const t0 = s.time;
  while (run.outcome === 'running' && s.entity(id)?.alive && s.time - t0 < budget) {
    const r = range(run, tag);
    s.setWarp(r > 3 * reach ? 2 : 0);
    const inFlight = s
      .all()
      .filter((e) => e.alive && e.kind === EntityKind.Missile && e.team === 0).length;
    if (r < reach && inFlight < 2 && s.munitionsLeft(s.playerId).missiles > 0) {
      s.setTarget(id);
      s.fireMissile();
    }
    run.update(0.25);
  }
  s.setWarp(0);
}

const range = (run: MissionRun, tag: string): number =>
  len(sub(run.session.entity(run.ids.get(tag)!)!.pos, run.session.player().pos));

describe('teaching ladder', () => {
  it('round trip: rendezvous with the beacon ahead, then the one behind', () => {
    const run = start('round-trip');
    const pilot = new Pilot(run.session);
    run.session.setTarget(run.ids.get('lead')!);
    expect(autopilot(run, pilot, new Rendezvous(run.ids.get('lead')!, 200))).toBe(true);
    closeIn(run, pilot, 'lead');
    fly(run, 60, () => run.objectives[0].status === 'done');
    log('front', run.objectives[0], run.session.time);
    expect(run.objectives[0].status).toBe('done');
    run.session.setTarget(run.ids.get('tail')!);
    expect(autopilot(run, pilot, new Rendezvous(run.ids.get('tail')!, 200))).toBe(true);
    closeIn(run, pilot, 'tail');
    fly(run, 60, () => run.outcome !== 'running');
    log('back', run.outcome, run.reason, run.session.time, run.stars());
    expect(run.outcome).toBe('won');
  });

  it('crossing traffic: wait at the crossing, shoot each drone as it sweeps through', () => {
    const run = start('crossing-traffic');
    const s = run.session;
    for (const tag of ['cross1', 'cross2']) {
      s.setWarp(3);
      fly(run, 4200, () => range(run, tag) < 60_000);
      s.setWarp(0);
      log(tag, 'range', range(run, tag), 'at', s.time);
      fly(run, 4200, () => range(run, tag) < 30_000);
      shoot(run, tag);
    }
    fly(run, 5);
    log('crossing', run.outcome, run.reason, s.time, run.stars());
    expect(run.outcome).toBe('won');
  });

  it('long reach: a missile from 130 km runs dry, closing first connects', () => {
    const blind = start('long-reach');
    shoot(blind, 'far');
    expect(blind.outcome).toBe('running');
    expect(blind.session.munitionsLeft(blind.session.playerId).missiles).toBe(1);

    const run = start('long-reach');
    const pilot = new Pilot(run.session);
    const id = run.ids.get('far')!;
    run.session.setTarget(id);
    expect(autopilot(run, pilot, new Rendezvous(id, 6000, 'Intercept', 'intercept'))).toBe(true);
    log('intercept range', range(run, 'far'), run.session.time);
    shoot(run, 'far');
    fly(run, 5);
    log('reach', run.outcome, run.reason, run.session.time, run.stars());
    expect(run.outcome).toBe('won');
  });

  it('under fire: dodging early lets you outlast four missiles', () => {
    const run = start('under-fire');
    const pilot = new Pilot(run.session);
    const threat = (): boolean =>
      run.session
        .all()
        .some(
          (e) =>
            e.alive &&
            e.kind === EntityKind.Missile &&
            e.team === 1 &&
            len(sub(e.pos, run.session.player().pos)) < 40_000,
        );
    while (run.outcome === 'running' && run.session.time < 900) {
      if (!pilot.busy && threat()) {
        const plan = pilot.propose(new Evade());
        if (plan.feasible) pilot.confirm();
      }
      run.update(0.25);
    }
    log(
      'under fire',
      run.outcome,
      run.reason,
      run.session.time,
      run.session.player().hp,
      run.stars(),
    );
    expect(run.outcome).toBe('won');
  });

  it('under fire: sitting still loses', () => {
    const run = start('under-fire');
    fly(run, 900);
    log('idle', run.outcome, run.reason, run.session.time);
    expect(run.outcome).toBe('lost');
  });

  it('convoy escort: the raider dies to a salvo before it reaches the freighter', () => {
    const run = start('convoy-escort');
    hunt(run, 'raider', 30_000);
    log('escort', run.outcome, run.reason, run.session.time, range(run, 'freighter'), run.stars());
    expect(run.outcome).toBe('won');
  });

  it('convoy escort: ignoring the raider loses the freighter', () => {
    const run = start('convoy-escort');
    run.session.setWarp(2);
    fly(run, 3600);
    log('escort idle', run.outcome, run.reason, run.session.time);
    expect(run.outcome).toBe('lost');
    expect(run.reason).toMatch(/Freighter was lost/);
  });

  it('task force: gunboat first, then the minelayer, wingman alive', () => {
    const run = start('task-force');
    hunt(run, 'hunter', 60_000);
    log(
      'tf1',
      run.outcome,
      run.reason,
      run.session.time,
      run.objectives.map((o) => o.status),
    );
    if (run.outcome === 'running') hunt(run, 'layer', 60_000);
    log('tf2', run.outcome, run.reason, run.session.time, run.stars(), run.session.player().hp);
    expect(run.outcome).toBe('won');
  });

  it('coaching lines fire once, at their trigger', () => {
    const run = start('round-trip');
    expect(run.takeCoach()).toHaveLength(1);
    expect(run.takeCoach()).toHaveLength(0);
    const pilot = new Pilot(run.session);
    run.session.setTarget(run.ids.get('lead')!);
    autopilot(run, pilot, new Rendezvous(run.ids.get('lead')!, 200));
    closeIn(run, pilot, 'lead');
    fly(run, 60, () => run.objectives[0].status === 'done');
    expect(run.takeCoach()).toHaveLength(1);
  });
});
