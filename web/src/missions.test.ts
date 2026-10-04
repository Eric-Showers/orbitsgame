import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Attitude, dot, EntityKind } from './sim/bridge';
import { loadMissions, validateMissions } from './missions/load';
import { MissionRun } from './missions/run';
import type { MissionDef, MissionFile } from './missions/types';
import { Game, initSync } from './wasm-pkg/orbit_wasm.js';

initSync({ module: readFileSync(new URL('./wasm-pkg/orbit_wasm_bg.wasm', import.meta.url)) });

const MISSIONS = loadMissions();
const mission = (id: string): MissionDef => MISSIONS.find((m) => m.id === id)!;
const start = (def: MissionDef): MissionRun => new MissionRun(new Game(), def);

/** Advances in 0.1 s frames (at the session's current warp) until `until` holds or time runs out. */
function fly(run: MissionRun, seconds: number, until: () => boolean = () => false): void {
  const end = run.session.time + seconds;
  while (run.session.time < end && run.outcome === 'running' && !until()) run.update(0.1);
}

function apAlt(run: MissionRun): number {
  return run.session.orbit(run.session.playerId)!.apoapsis - run.session.planetRadius;
}

function peAlt(run: MissionRun): number {
  return run.session.orbit(run.session.playerId)!.periapsis - run.session.planetRadius;
}

/** Two-burn Hohmann transfer from a circular orbit up to `target` altitude. */
function hohmannUp(run: MissionRun, target: number): void {
  const s = run.session;
  s.setAttitude(Attitude.Prograde);
  fly(run, 30); // slew to prograde
  s.setThrottle(0.3);
  fly(run, 600, () => apAlt(run) >= target);
  s.setThrottle(0);
  s.setWarp(4);
  fly(run, 4000, () => dot(s.player().pos, s.player().vel) <= 0); // at apoapsis
  s.setWarp(0);
  s.setThrottle(0.3);
  fly(run, 600, () => peAlt(run) >= target - 300);
  s.setThrottle(0);
}

/** Targets `tag` and fires one missile; waits until it detonates or expires. */
function shoot(run: MissionRun, tag: string): void {
  const s = run.session;
  s.setTarget(run.ids.get(tag)!);
  expect(s.fireMissile()).toBe(true);
  const live = (): boolean =>
    s.all().some((e) => e.alive && e.kind === EntityKind.Missile && e.team === 0);
  fly(run, 300, () => !live());
}

describe('mission data', () => {
  it('ships a valid ladder of six missions', () => {
    expect(MISSIONS.length).toBe(6);
    expect(validateMissions({ version: 1, missions: MISSIONS })).toEqual([]);
  });

  it('reports broken references instead of loading them', () => {
    const bad = structuredClone(mission('live-fire'));
    bad.objectives[0] = { ...bad.objectives[0], type: 'destroy', targets: ['nobody'] } as never;
    bad.objectives[1].after = 'later';
    const problems = validateMissions({ version: 1, missions: [bad] } as MissionFile);
    expect(problems.join('\n')).toMatch(/unknown ship tag nobody/);
    expect(problems.join('\n')).toMatch(/"after" must name an earlier objective/);
    expect(() => loadMissions({ version: 1, missions: [bad] })).toThrow(/Invalid mission data/);
  });

  it('applies the player loadout from data', () => {
    const run = start(mission('live-fire'));
    expect(run.session.munitionsLeft(run.session.playerId)).toEqual({ missiles: 3, mines: 0 });
  });
});

describe('missions are winnable as designed', () => {
  it('first burn: a Hohmann transfer to 120 km wins with all three stars', () => {
    const run = start(mission('first-burn'));
    hohmannUp(run, 120_000);
    fly(run, 60);
    expect(run.reason).toBe('All objectives complete');
    expect(run.outcome).toBe('won');
    expect(run.stars()).toBe(3);
  });

  it('live fire: both drones fall to missiles, the second spawning after the first', () => {
    const run = start(mission('live-fire'));
    expect(run.ids.has('drone2')).toBe(false);
    shoot(run, 'drone1');
    expect(run.objectives[0].status).toBe('done');
    expect(run.ids.has('drone2')).toBe(true);
    shoot(run, 'drone2');
    expect(run.outcome).toBe('won');
  });

  it('mine corridor: three mines laid at 89.5 km catch the convoy', () => {
    const run = start(mission('mine-corridor'));
    hohmannUp(run, 89_500);
    for (let i = 0; i < 3; i++) {
      expect(run.session.dropMine()).toBe(true);
      fly(run, 20);
    }
    expect(run.objectives[0].status).toBe('done');
    run.session.setWarp(3);
    fly(run, 5000);
    expect(run.reason).toBe('All objectives complete');
  });

  it('minelayer: three long-range missile hits kill it', () => {
    const run = start(mission('minelayer'));
    for (let i = 0; i < 4 && run.outcome === 'running'; i++) shoot(run, 'layer');
    expect(run.outcome).toBe('won');
  });

  it('gunboat duel: shooting from outside its range wins', () => {
    const run = start(mission('gunboat-duel'));
    while (run.outcome === 'running' && run.session.munitionsLeft(run.session.playerId).missiles) {
      const tag = run.objectives[0].status === 'done' ? 'gunboat2' : 'gunboat1';
      shoot(run, tag);
    }
    fly(run, 5);
    expect(run.reason).toBe('All objectives complete');
  });
});

/** A tiny mission built inline: the runtime is driven purely by data. */
function custom(patch: Partial<MissionDef>): MissionDef {
  return {
    id: 'test',
    title: 'Test',
    summary: '',
    briefing: [],
    player: { class: 'corvette', orbit: { pe: 80_000 } },
    ships: [],
    objectives: [],
    score: { parTime: 100, fuelReserve: 0.5 },
    ...patch,
  };
}

describe('mission rules', () => {
  it('rendezvous needs the hold time inside range and speed', () => {
    const run = start(
      custom({
        ships: [{ tag: 'b', class: 'beacon', team: 'neutral', orbit: { pe: 80_000, lead: 100 } }],
        objectives: [
          {
            id: 'r',
            type: 'rendezvous',
            label: '',
            target: 'b',
            range: 300,
            maxRelSpeed: 1,
            hold: 5,
          },
        ],
      }),
    );
    fly(run, 4);
    expect(run.objectives[0].status).toBe('active');
    expect(run.objectives[0].progress).toBeGreaterThan(0.7);
    fly(run, 2);
    expect(run.outcome).toBe('won');
  });

  it('a kill by the wrong weapon fails the mission', () => {
    const run = start(
      custom({
        player: { class: 'corvette', orbit: { pe: 80_000 }, loadout: { missiles: 1 } },
        ships: [{ tag: 'd', class: 'drone', team: 'enemy', orbit: { pe: 80_000, lead: 5000 } }],
        objectives: [{ id: 'k', type: 'destroy', label: '', targets: ['d'], by: 'mine' }],
      }),
    );
    shoot(run, 'd');
    expect(run.outcome).toBe('lost');
    expect(run.reason).toMatch(/destroyed by missile, not by mine/);
  });

  it('fails on the time limit and freezes the sim', () => {
    const run = start(
      custom({
        objectives: [{ id: 's', type: 'survive', label: '', seconds: 100 }],
        fail: { timeLimit: 10 },
      }),
    );
    fly(run, 20);
    expect(run.outcome).toBe('lost');
    expect(run.reason).toBe('Out of time');
    const t = run.session.time;
    run.update(1);
    expect(run.session.time).toBe(t);
  });

  it('survive completes after its duration', () => {
    const run = start(
      custom({ objectives: [{ id: 's', type: 'survive', label: '', seconds: 5 }] }),
    );
    fly(run, 6);
    expect(run.outcome).toBe('won');
  });

  it('crashing into the planet loses', () => {
    const run = start(
      custom({ objectives: [{ id: 's', type: 'survive', label: '', seconds: 1e6 }] }),
    );
    run.session.setAttitude(Attitude.Retrograde);
    fly(run, 30);
    run.session.setThrottle(1);
    fly(run, 3000);
    expect(run.outcome).toBe('lost');
    expect(run.reason).toMatch(/crashed/);
  });

  it('a hostile gunner fires once the player is inside its range', () => {
    const run = start(
      custom({
        ships: [
          {
            tag: 'g',
            class: 'gunboat',
            team: 'enemy',
            orbit: { pe: 80_000, lead: 8000 },
            ai: { gunner: { range: 10_000, cooldown: 30, firstShotDelay: 2 } },
          },
        ],
        objectives: [{ id: 's', type: 'survive', label: '', seconds: 1e6 }],
      }),
    );
    const enemyMissiles = (): number =>
      run.session.all().filter((e) => e.kind === EntityKind.Missile && e.team === 1).length;
    fly(run, 1);
    expect(enemyMissiles()).toBe(0);
    fly(run, 2);
    expect(enemyMissiles()).toBe(1);
    fly(run, 20);
    expect(enemyMissiles()).toBe(1); // cooldown
  });
});
