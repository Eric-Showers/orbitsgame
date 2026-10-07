import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildIntent, INTENTS, intentById } from './autopilot/intents';
import { Pilot } from './autopilot/pilot';
import { loadMissions } from './missions/load';
import { MissionRun } from './missions/run';
import {
  holds,
  readingTime,
  readWorld,
  shouldCut,
  TutorialRunner,
  warpLimit,
  type TutorialWorld,
} from './missions/tutorial';
import type { MissionDef, TutorialCond, TutorialStep } from './missions/types';
import { WARP_LEVELS } from './sim/session';
import { ACTIONS, applyAction, type ClientControl } from './ui/controls';
import { Game, initSync } from './wasm-pkg/orbit_wasm.js';

initSync({ module: readFileSync(new URL('./wasm-pkg/orbit_wasm_bg.wasm', import.meta.url)) });

const MISSIONS = loadMissions();
const TUTORIALS = MISSIONS.filter((m) => m.tutorial);
const none = new Set<string>();
const world = (over: Partial<TutorialWorld> = {}): TutorialWorld => ({
  mode: null,
  throttle: 0,
  ap: 80000,
  pe: 80000,
  apEta: 900,
  peEta: 1800,
  target: null,
  warpIndex: 0,
  assist: true,
  proposal: false,
  helmBusy: false,
  objectives: new Map(),
  ...over,
});

/** Every selector a step names that points at one control, as [attribute, id]. */
function controlRefs(step: TutorialStep): [string, string][] {
  const refs: [string, string][] = [];
  for (const sel of [...(step.highlight ?? []), ...(step.flash ?? [])]) {
    for (const m of sel.matchAll(/\[data-(action|intent)="([^"]+)"\]/g)) refs.push([m[1], m[2]]);
  }
  return refs;
}

function condsOf(c: TutorialCond | undefined): TutorialCond[] {
  if (!c) return [];
  if ('all' in c) return c.all.flatMap(condsOf);
  if ('any' in c) return c.any.flatMap(condsOf);
  return [c];
}

describe('tutorial levels', () => {
  it('the first seven levels are tutorials and the rest are missions', () => {
    expect(MISSIONS.slice(0, 7).every((m) => m.tutorial)).toBe(true);
    expect(MISSIONS.slice(7).some((m) => m.tutorial)).toBe(false);
    expect(TUTORIALS.map((m) => m.id)).toEqual([
      'first-burn',
      'beacon-rendezvous',
      'round-trip',
      'live-fire',
      'crossing-traffic',
      'long-reach',
      'mine-corridor',
    ]);
  });

  it('tutorials have no written briefing; missions keep theirs', () => {
    for (const m of TUTORIALS) expect(m.briefing, m.id).toEqual([]);
    for (const m of MISSIONS.filter((x) => !x.tutorial))
      expect(m.briefing.length, m.id).toBeGreaterThan(0);
  });

  it('every step names real controls, ships and objectives', () => {
    const actions = new Set(ACTIONS.map((a) => a.id));
    const intents = new Set(INTENTS.map((i) => i.id));
    for (const m of TUTORIALS) {
      const tags = new Set(m.ships.map((s) => s.tag));
      const objs = new Set(m.objectives.map((o) => o.id));
      m.tutorial!.steps.forEach((step, i) => {
        const at = `${m.id} step ${i + 1}`;
        expect(step.say.length, at).toBeGreaterThan(0);
        for (const [kind, id] of controlRefs(step)) {
          expect((kind === 'action' ? actions : intents).has(id), `${at}: ${kind} ${id}`).toBe(
            true,
          );
        }
        for (const c of [...condsOf(step.until), ...condsOf(step.skipIf)]) {
          if ('target' in c && typeof c.target === 'string')
            expect(tags.has(c.target), at).toBe(true);
          if ('objective' in c) expect(objs.has(c.objective), at).toBe(true);
          if ('action' in c) {
            for (const id of [c.action].flat()) expect(actions.has(id), `${at}: ${id}`).toBe(true);
          }
          if ('mode' in c) expect(actions.has(c.mode), at).toBe(true);
        }
      });
    }
  });

  it('a step that waits on the player has a way to nudge them', () => {
    for (const m of TUTORIALS) {
      for (const [i, s] of m.tutorial!.steps.entries()) {
        const waits = (s.flash?.length ?? 0) > 0 && s.until && !s.skipIf;
        if (waits) expect(s.hint, `${m.id} step ${i + 1}`).toBeTruthy();
      }
    }
  });
});

describe('conditions', () => {
  const clock = (
    actions: string[] = [],
    elapsed = 0,
  ): { elapsed: number; actions: Set<string> } => ({
    elapsed,
    actions: new Set(actions),
  });

  it('tests actions, orbit, target and objectives', () => {
    expect(holds({ action: 'prograde' }, world(), clock(['prograde']))).toBe(true);
    expect(holds({ action: ['a', 'b'] }, world(), clock(['b']))).toBe(true);
    expect(holds({ action: 'prograde' }, world(), clock())).toBe(false);
    expect(holds({ ap: { min: 119000 } }, world({ ap: 120000 }), clock())).toBe(true);
    expect(holds({ ap: { min: 119000 } }, world({ ap: 100000 }), clock())).toBe(false);
    expect(holds({ ap: { max: 91000 } }, world({ ap: null }), clock())).toBe(false);
    expect(holds({ throttle: 'off' }, world({ throttle: 0 }), clock())).toBe(true);
    expect(holds({ throttle: 'on' }, world({ throttle: 0.5 }), clock())).toBe(true);
    const t = { tag: 'lead', range: 20000, closing: 10 };
    expect(holds({ target: true }, world({ target: t }), clock())).toBe(true);
    expect(holds({ target: 'tail' }, world({ target: t }), clock())).toBe(false);
    expect(holds({ range: { below: 25000 } }, world({ target: t }), clock())).toBe(true);
    expect(holds({ range: { below: 25000 } }, world(), clock())).toBe(false);
    const objectives = new Map([
      ['a', 'done' as const],
      ['b', 'active' as const],
    ]);
    expect(holds({ objective: 'a', status: 'done' }, world({ objectives }), clock())).toBe(true);
    expect(holds({ objective: 'b', status: 'done' }, world({ objectives }), clock())).toBe(false);
    expect(holds({ done: 1 }, world({ objectives }), clock())).toBe(true);
    expect(holds({ done: 2 }, world({ objectives }), clock())).toBe(false);
    expect(holds({ all: [{ throttle: 'off' }, { warp: true }] }, world(), clock())).toBe(false);
    expect(holds({ any: [{ throttle: 'off' }, { warp: true }] }, world(), clock())).toBe(true);
    expect(holds({ seconds: 3 }, world(), clock([], 3))).toBe(true);
  });

  it('holds back warp near an apsis or a closing target, never forcing it up', () => {
    const near = world({ apEta: 10 });
    expect(WARP_LEVELS[warpLimit({ say: '', warpGuard: 'apoapsis' }, near)!]).toBe(2);
    expect(warpLimit({ say: '', warpGuard: 'apoapsis' }, world({ apEta: 2 }))).toBe(0);
    expect(warpLimit({ say: '', warpGuard: 'apoapsis' }, world({ apEta: 1e6 }))).toBe(
      WARP_LEVELS.length - 1,
    );
    expect(warpLimit({ say: '' }, near)).toBeNull();
    const closing = world({ target: { tag: null, range: 30000, closing: 3000 } });
    expect(WARP_LEVELS[warpLimit({ say: '', warpGuard: 'target' }, closing)!]).toBe(2);
    const receding = world({ target: { tag: null, range: 30000, closing: -50 } });
    expect(warpLimit({ say: '', warpGuard: 'target' }, receding)).toBeNull();
  });

  it('cuts the engine at the altitude a step names', () => {
    const step: TutorialStep = { say: '', cutAt: { ap: 120000 } };
    expect(shouldCut(step, world({ ap: 119000, throttle: 1 }))).toBe(false);
    expect(shouldCut(step, world({ ap: 120100, throttle: 1 }))).toBe(true);
    expect(shouldCut(step, world({ ap: 120100, throttle: 0 }))).toBe(false);
    expect(shouldCut(null, world({ ap: 1e6, throttle: 1 }))).toBe(false);
  });

  it('gives a reading step time to be read', () => {
    expect(readingTime('Short.')).toBe(4);
    expect(readingTime(Array(40).fill('word').join(' '))).toBeGreaterThan(15);
  });
});

describe('runner', () => {
  const steps: TutorialStep[] = [
    { say: 'one', until: { action: 'prograde' }, hint: 'press it' },
    { say: 'two', skipIf: { throttle: 'off' }, until: { throttle: 'on' } },
    { say: 'three' },
  ];
  const make = (): { r: TutorialRunner; said: string[]; seen: (number | null)[] } => {
    const said: string[] = [];
    const seen: (number | null)[] = [];
    const r = new TutorialRunner(
      { steps },
      { say: (_id, t) => said.push(t), onStep: (s, i) => seen.push(s ? i : null) },
      'x',
    );
    return { r, said, seen };
  };

  it('speaks each step, waits for its action, skips met steps and finishes', () => {
    const { r, said, seen } = make();
    r.begin(world());
    expect(said).toEqual(['one']);
    r.update(world(), 1);
    expect(r.index).toBe(0);
    r.press('prograde', false);
    r.update(world(), 1);
    expect(r.index).toBe(0);
    r.press('prograde', true);
    r.update(world(), 0.1);
    // Step two is skipped: the throttle is already off.
    expect(r.index).toBe(2);
    expect(said).toEqual(['one', 'three']);
    r.update(world(), 10);
    expect(r.finished).toBe(true);
    expect(seen.at(-1)).toBeNull();
  });

  it('repeats the hint while the player dawdles, and can be skipped', () => {
    const { r, said, seen } = make();
    r.begin(world());
    r.update(world(), 26);
    expect(said).toEqual(['one', 'press it']);
    r.update(world(), 10);
    expect(said.length).toBe(2);
    r.update(world(), 20);
    expect(said.length).toBe(3);
    r.skip();
    expect(r.finished).toBe(true);
    expect(seen.at(-1)).toBeNull();
    r.update(world(), 100);
    expect(said.length).toBe(3);
  });
});

// Plays each tutorial the way a player following ARGUS would, and checks the level is won.
const client: ClientControl = {
  zoomBy() {},
  toggleFocus() {},
  cycleFocus() {},
  focusOnTarget: () => true,
  toggleFreeCamera() {},
  recentre() {},
  setPan() {},
  restart() {},
};

function playThrough(def: MissionDef): { run: MissionRun; finished: boolean; spoken: string[] } {
  const run = new MissionRun(new Game(), def);
  const session = run.session;
  const pilot = new Pilot(session);
  pilot.setAssist(false); // a first-time player: the tutorial must ask for it
  const spoken: string[] = [];
  let altitudeKm = 120;
  const runner = new TutorialRunner(
    def.tutorial!,
    {
      say: (_id, t) => spoken.push(t),
      onStep: (s) => {
        if (s?.prefill) altitudeKm = s.prefill.altitudeKm;
      },
    },
    def.id,
  );
  const press = (id: string): void => {
    const action = ACTIONS.find((a) => a.id === id)!;
    applyAction(session, client, action, true);
    // Mirrors main.ts: the guide hears every press and whether the ship took it.
    runner.press(id, true);
  };
  const pressedOnStep = new Set<string>();
  const dt = 0.1;
  let started = false;
  for (let t = 0; t < 4 * 3600 && run.outcome === 'running'; t += dt) {
    const w = readWorld(session, pilot, run);
    if (!started) {
      started = true;
      runner.begin(w);
    } else {
      runner.update(w, dt);
    }
    const step = runner.step;
    if (step) {
      runner.guard(session, w, run.ids);
      const flash = step.flash?.[0] ?? '';
      const action = /data-action="([^"]+)"/.exec(flash)?.[1];
      const intent = /data-intent="([^"]+)"/.exec(flash)?.[1];
      if (action === 'warp-up') {
        if (session.warpIndex < 5) press(action);
      } else if (action === 'target-next') {
        if (!(step.until && holds(step.until, w, { elapsed: 0, actions: none }))) press(action);
      } else if (action) {
        // A player presses a button once and waits; mines are laid a few seconds apart.
        const again = action === 'drop-mine' && t % 10 < dt;
        if (!w.helmBusy && (!pressedOnStep.has(`${runner.index}:${action}`) || again)) {
          pressedOnStep.add(`${runner.index}:${action}`);
          press(action);
        }
      } else if (flash.includes('pilot-toggle')) {
        pilot.setAssist(true);
      } else if (intent && !pilot.proposal && !pilot.busy) {
        const built = buildIntent(intentById(intent)!, {
          target: session.player().target,
          altitudeKm,
        });
        if (typeof built !== 'string') pilot.propose(built);
      } else if (flash.includes('pilot-go')) {
        pilot.confirm();
      }
    }
    run.update(dt);
    if (runner.finished) break;
  }
  return { run, finished: runner.finished, spoken };
}

describe('playing the tutorials as told', () => {
  for (const def of TUTORIALS) {
    it(`${def.id}: following every step wins the level`, () => {
      const { run, spoken } = playThrough(def);
      expect(spoken.length).toBeGreaterThan(3);
      expect(run.outcome, run.reason).toBe('won');
    }, 120_000);
  }
});
