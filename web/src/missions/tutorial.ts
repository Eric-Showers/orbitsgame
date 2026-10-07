import type { Pilot } from '../autopilot/pilot';
import { timeToApsis } from '../autopilot/orbitmath';
import { dot, len, sub } from '../sim/bridge';
import { WARP_LEVELS, type FlightSession } from '../sim/session';
import { ACTIONS } from '../ui/controls';
import type { MissionRun, ObjectiveStatus } from './run';
import type { AltRange, TutorialCond, TutorialDef, TutorialStep } from './types';

// Guided tutorials. A level's `tutorial` is a list of steps; each has a line for
// the ship AI, optional interface parts to light up, and a condition that says
// when the player has done what it asked. This file is the logic only (pure
// functions of a `TutorialWorld` snapshot, so it tests without a browser); the
// overlay that draws it is `ui/tutorial.ts`.

/** Real seconds of margin the warp guard keeps before an apsis or an arrival. */
const WARP_MARGIN = 3;
/** First hint after this many seconds on a step, then again at the same interval. */
const HINT_AFTER = 25;
/** Reading pause for a step with no condition: floor, plus time per word. */
const READ_MIN = 4;
const READ_PER_WORD = 0.45;

/** What the tutorial can see of the flight. Built fresh each frame. */
export interface TutorialWorld {
  /** Control action id matching the ship's attitude mode, if any. */
  mode: string | null;
  throttle: number;
  /** Apsis altitudes above the surface (m); null on an open orbit. */
  ap: number | null;
  pe: number | null;
  apEta: number | null;
  peEta: number | null;
  /** The locked target, if alive. */
  target: { tag: string | null; range: number; closing: number; relSpeed: number } | null;
  warpIndex: number;
  assist: boolean;
  proposal: boolean;
  helmBusy: boolean;
  objectives: ReadonlyMap<string, ObjectiveStatus>;
}

const MODE_ACTION = new Map(
  ACTIONS.filter((a) => a.attitude !== undefined).map((a) => [a.attitude, a.id]),
);

/** Reads the flight into the shape the conditions test. `run` is null in free flight. */
export function readWorld(
  session: FlightSession,
  pilot: Pilot,
  run: MissionRun | null,
): TutorialWorld {
  const me = session.player();
  const o = me.alive ? session.orbit(me.id) : null;
  const open = o === null || o.eccentricity >= 1;
  const t = session.entity(me.target);
  let target: TutorialWorld['target'] = null;
  if (t?.alive) {
    const rel = sub(t.pos, me.pos);
    const range = len(rel);
    const relV = sub(t.vel, me.vel);
    let tag: string | null = null;
    for (const [k, id] of run?.ids ?? []) if (id === t.id) tag = k;
    target = { tag, range, closing: range > 0 ? -dot(rel, relV) / range : 0, relSpeed: len(relV) };
  }
  return {
    mode: MODE_ACTION.get(me.mode) ?? null,
    throttle: me.throttle,
    ap: o && !open ? o.apoapsis - session.planetRadius : null,
    pe: o ? o.periapsis - session.planetRadius : null,
    apEta: o && !open ? timeToApsis(o, 'apoapsis') : null,
    peEta: o ? timeToApsis(o, 'periapsis') : null,
    target,
    warpIndex: session.warpIndex,
    assist: pilot.assist,
    proposal: pilot.proposal !== null,
    helmBusy: pilot.busy,
    objectives: new Map((run?.objectives ?? []).map((x) => [x.def.id, x.status])),
  };
}

interface Clock {
  elapsed: number;
  /** Action ids the commander pressed (and the ship accepted) since the step began. */
  actions: ReadonlySet<string>;
}

function inRange(v: number | null, r: AltRange | undefined): boolean {
  if (r === undefined) return true;
  if (v === null) return false;
  return (r.min === undefined || v >= r.min) && (r.max === undefined || v <= r.max);
}

/** Whether a condition holds right now. */
export function holds(cond: TutorialCond, w: TutorialWorld, c: Clock): boolean {
  if ('all' in cond) return cond.all.every((x) => holds(x, w, c));
  if ('any' in cond) return cond.any.some((x) => holds(x, w, c));
  if ('action' in cond) {
    const ids = Array.isArray(cond.action) ? cond.action : [cond.action];
    return ids.some((id) => c.actions.has(id));
  }
  if ('mode' in cond) return w.mode === cond.mode;
  if ('throttle' in cond) return cond.throttle === 'on' ? w.throttle > 0.02 : w.throttle === 0;
  if ('ap' in cond || 'pe' in cond) {
    const o = cond as { ap?: AltRange; pe?: AltRange };
    return inRange(w.ap, o.ap) && inRange(w.pe, o.pe);
  }
  if ('apEtaBelow' in cond) return w.apEta !== null && w.apEta <= cond.apEtaBelow;
  if ('peEtaBelow' in cond) return w.peEta !== null && w.peEta <= cond.peEtaBelow;
  if ('target' in cond) {
    if (w.target === null) return false;
    return cond.target === true || w.target.tag === cond.target;
  }
  if ('range' in cond) {
    if (w.target === null) return false;
    const { below, above } = cond.range;
    return (
      (below === undefined || w.target.range <= below) &&
      (above === undefined || w.target.range >= above)
    );
  }
  if ('closing' in cond) {
    if (w.target === null) return false;
    const { above, below } = cond.closing;
    return (
      (above === undefined || w.target.closing >= above) &&
      (below === undefined || w.target.closing <= below)
    );
  }
  if ('relSpeed' in cond) {
    if (w.target === null) return false;
    const { above, below } = cond.relSpeed;
    return (
      (above === undefined || w.target.relSpeed >= above) &&
      (below === undefined || w.target.relSpeed <= below)
    );
  }
  if ('warp' in cond) return w.warpIndex > 0;
  if ('assist' in cond) return w.assist === cond.assist;
  if ('proposal' in cond) return w.proposal;
  if ('helmBusy' in cond) return w.helmBusy === cond.helmBusy;
  if ('objective' in cond) return w.objectives.get(cond.objective) === cond.status;
  if ('done' in cond)
    return [...w.objectives.values()].filter((s) => s === 'done').length >= cond.done;
  if ('seconds' in cond) return c.elapsed >= cond.seconds;
  return false;
}

/** Seconds a step with no condition stays up: enough to read its line. */
export function readingTime(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(READ_MIN, 1.5 + words * READ_PER_WORD);
}

/** The warp index the flight must not exceed so a step's event is not skipped, or null for no limit. */
export function warpLimit(step: TutorialStep | null, w: TutorialWorld): number | null {
  if (!step?.warpGuard) return null;
  if (step.warpGuard === 'stop') return 0;
  let eta: number | null;
  if (step.warpGuard === 'apoapsis') eta = w.apEta;
  else if (step.warpGuard === 'periapsis') eta = w.peEta;
  else eta = w.target && w.target.closing > 0 ? w.target.range / w.target.closing : null;
  if (eta === null) return null;
  let limit = 0;
  WARP_LEVELS.forEach((level, i) => {
    if (level * WARP_MARGIN <= eta) limit = i;
  });
  return limit;
}

/** Whether the step's safety net wants the engine cut now. */
export function shouldCut(step: TutorialStep | null, w: TutorialWorld): boolean {
  const cut = step?.cutAt;
  if (!cut || w.throttle === 0) return false;
  return (
    (cut.ap !== undefined && w.ap !== null && w.ap >= cut.ap) ||
    (cut.pe !== undefined && w.pe !== null && w.pe >= cut.pe)
  );
}

/** Where the ship AI speaks and the overlay reacts. */
export interface TutorialHost {
  /** The ship AI says a line (it also shows on screen). */
  say(id: string, text: string): void;
  /** A step began (or the walkthrough ended: `step` is null). */
  onStep(step: TutorialStep | null, index: number, total: number): void;
}

/** Walks a level's steps. Create one per accepted tutorial. */
export class TutorialRunner {
  private i = -1;
  private elapsed = 0;
  private pressed = new Set<string>();
  private lastHint = 0;
  private skipped = false;
  private locked = -1;

  constructor(
    private def: TutorialDef,
    private host: TutorialHost,
    private levelId: string,
  ) {}

  get total(): number {
    return this.def.steps.length;
  }

  get index(): number {
    return this.i;
  }

  get step(): TutorialStep | null {
    return this.i >= 0 && this.i < this.total ? this.def.steps[this.i] : null;
  }

  get finished(): boolean {
    return this.skipped || this.i >= this.total;
  }

  /** Starts the first step. */
  begin(w: TutorialWorld): void {
    this.enter(0, w);
  }

  /** The commander pressed a control action. */
  press(id: string, ok: boolean): void {
    if (ok) this.pressed.add(id);
  }

  /** Abandons the walkthrough; the level goes on unguided. */
  skip(): void {
    if (this.finished) return;
    this.skipped = true;
    this.host.onStep(null, this.i, this.total);
  }

  /**
   * Applies the current step's effects on the flight: eases warp off, cuts the
   * engine at the altitude it names, locks the ship it points at. `ids` maps
   * mission tags to ship ids.
   */
  guard(session: FlightSession, w: TutorialWorld, ids: ReadonlyMap<string, number>): void {
    const step = this.step;
    if (!step || this.skipped) return;
    const limit = warpLimit(step, w);
    if (limit !== null && session.warpIndex > limit) session.setWarp(limit);
    if (shouldCut(step, w)) {
      session.throttleRamp = 0;
      session.setThrottle(0);
    }
    const id = step.lock === undefined ? undefined : ids.get(step.lock);
    if (id !== undefined && this.locked !== this.i) {
      this.locked = this.i;
      session.setTarget(id);
    }
  }

  /** Moves to the next step now (the NEXT button on a reading step). */
  advance(w: TutorialWorld): void {
    if (!this.finished) this.enter(this.i + 1, w);
  }

  /** Ticks the walkthrough by real seconds. Call every flight frame. */
  update(w: TutorialWorld, dt: number): void {
    const step = this.step;
    if (!step || this.skipped) return;
    this.elapsed += dt;
    const clock = { elapsed: this.elapsed, actions: this.pressed };
    const done = step.until ? holds(step.until, w, clock) : this.elapsed >= readingTime(step.say);
    if (done) {
      this.enter(this.i + 1, w);
    } else if (step.hint && this.elapsed - this.lastHint >= HINT_AFTER) {
      this.lastHint = this.elapsed;
      this.host.say(`tutorial.${this.levelId}.${this.i}.hint`, step.hint);
    }
  }

  private enter(from: number, w: TutorialWorld): void {
    let i = from;
    // Steps whose goal is already met are skipped.
    while (i < this.total) {
      const skip = this.def.steps[i].skipIf;
      if (!skip || !holds(skip, w, { elapsed: 0, actions: new Set() })) break;
      i++;
    }
    this.i = i;
    this.elapsed = 0;
    this.lastHint = 0;
    this.pressed = new Set();
    const step = this.step;
    if (step) this.host.say(`tutorial.${this.levelId}.${i}`, step.say);
    this.host.onStep(step, i, this.total);
  }
}
