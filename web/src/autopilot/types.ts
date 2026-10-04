// The maneuver-script contract. A maneuver is deterministic: given the same
// sim state it plans the same burns and issues the same controls.

import type { Attitude, ClassStats, EntityView, OrbitView } from '../sim/bridge';
import type { PilotConfig } from './config';

/** The only way a script touches the ship. Mirrors what the commander can do by hand. */
export interface Helm {
  setAttitude(mode: Attitude): boolean;
  setThrottle(t: number): void;
  setTarget(id: number | null): void;
  fireMissile(): boolean;
  dropMine(): boolean;
}

export type { ClassStats };

export interface MunitionStats {
  deltaV: number;
  accel: number;
  closingSpeed: number;
  blastRadius: number;
  armTime: number;
  triggerRange: number;
  lifetime: number;
}

/** Read-only world as the autopilot sees it at one instant, plus the helm. */
export interface Ctx {
  /** Sim time (s). */
  time: number;
  mu: number;
  planetRadius: number;
  self: EntityView;
  orbit: OrbitView | null;
  entities: readonly EntityView[];
  entity(id: number | null): EntityView | undefined;
  orbitOf(id: number): OrbitView | null;
  helm: Helm;
  cfg: PilotConfig;
  munitionsLeft(kind: 'missiles' | 'mines'): number;
  classStats(shipClass: number): ClassStats;
  missile: MunitionStats;
  mine: MunitionStats;
}

/** One planned engine burn. */
export interface BurnNode {
  /** Sim time of the burn's centre (s). */
  time: number;
  mode: Attitude;
  /** Delta-v (m/s). */
  dv: number;
  label: string;
}

export interface Plan {
  feasible: boolean;
  /** Why not, in a sentence the commander can act on. */
  reason?: string;
  nodes: BurnNode[];
  /** Total delta-v (m/s). */
  dv: number;
  /** Rough seconds from now to completion. */
  eta: number;
  /** Values for ARGUS lines, already formatted (e.g. `alt`, `dv`). */
  vars: Record<string, string>;
}

export type RunState = 'running' | 'done' | 'failed';

export interface Status {
  state: RunState;
  /** Machine phase id for speech, e.g. `coast`, `align`, `burn`. */
  phase: string;
  /** 0..1 across the whole maneuver. */
  progress: number;
  /** Short readout for the HUD. */
  note: string;
  /** Sim seconds the script can safely be left alone for (0 = call every step). */
  coast: number;
  /** Failure reason when `state` is `failed`. */
  reason?: string;
}

export interface Maneuver {
  /** Stable id, e.g. `circularize`. */
  readonly kind: string;
  /** Commander-facing name. */
  readonly label: string;
  /** Burn nodes and cost if flown from the current state. Pure. */
  plan(ctx: Ctx): Plan;
  /** Latches the plan's decisions (node times, targets). Call once before `execute`. */
  start(ctx: Ctx): void;
  /** One control tick: issues helm commands and reports progress. */
  execute(ctx: Ctx): Status;
  /** Leaves the ship safe: engine cut. */
  abort(ctx: Ctx): void;
}

export type Lazy<T> = T | ((ctx: Ctx) => T);
export const resolve = <T>(v: Lazy<T>, ctx: Ctx): T =>
  typeof v === 'function' ? (v as (c: Ctx) => T)(ctx) : v;

export const failed = (reason: string, phase = 'failed'): Status => ({
  state: 'failed',
  phase,
  progress: 0,
  note: reason,
  coast: 0,
  reason,
});

export const infeasible = (reason: string): Plan => ({
  feasible: false,
  reason,
  nodes: [],
  dv: 0,
  eta: 0,
  vars: {},
});
