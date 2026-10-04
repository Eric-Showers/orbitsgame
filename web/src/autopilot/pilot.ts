import { Game } from '../wasm-pkg/orbit_wasm.js';
import { decodeClassStats, EntityKind, len, sub, type ClassStats } from '../sim/bridge';
import { MAX_WARP_UNDER_THRUST, SIM_DT, type FlightSession, type StepHook } from '../sim/session';
import { fmtDistance, fmtDuration } from '../ui/format';
import { PILOT_CONFIG, type PilotConfig } from './config';
import {
  infeasible,
  type Ctx,
  type Helm,
  type Maneuver,
  type MunitionStats,
  type Plan,
  type Status,
} from './types';

export type PilotEvent =
  | { kind: 'proposed'; maneuver: Maneuver; plan: Plan }
  | { kind: 'refused'; label: string; reason: string }
  | { kind: 'cancelled'; maneuver: Maneuver }
  | { kind: 'started'; maneuver: Maneuver }
  | { kind: 'phase'; maneuver: Maneuver; phase: string }
  | { kind: 'done'; maneuver: Maneuver }
  | { kind: 'failed'; maneuver: Maneuver; reason: string }
  | { kind: 'aborted'; maneuver: Maneuver; cause: 'commander' | 'override' | 'assist-off' }
  | { kind: 'assist'; on: boolean };

export type PilotListener = (event: PilotEvent) => void;

/** The maneuver the commander has been offered and is deciding on. */
export interface Proposal {
  maneuver: Maneuver;
  plan: Plan;
}

const STORAGE_KEY = 'orbits.aiAssist';

function loadAssist(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Phases where the ship turns or burns; warped to a modest level so they do not drag. */
const WORK_PHASES = new Set(['align', 'burn']);

/**
 * The ship AI's hands. Holds at most one running maneuver, ticks it with the
 * sim, and gives the commander confirm / cancel / abort. Manual flight orders
 * take over instantly. Reads the sim like the advisor does, but unlike the
 * advisor it can fly the ship, and only on the commander's confirmed order.
 */
export class Pilot implements StepHook {
  assist = loadAssist();
  autoWarp: boolean;
  proposal: Proposal | null = null;
  active: Maneuver | null = null;
  status: Status | null = null;
  private listeners = new Set<PilotListener>();
  private lastPhase = '';
  private warpSet = -1;
  private warpBefore = 0;
  private warpManual = false;
  private classCache = new Map<number, ClassStats>();
  private missile = munition(1);
  private mine = munition(2);

  constructor(
    private session: FlightSession,
    private cfg: PilotConfig = PILOT_CONFIG,
  ) {
    this.autoWarp = cfg.autoWarp.enabled;
    session.hook = this;
    session.onManualInput = () => this.manualInput();
  }

  /** Detach from the session (new flight). Cuts the engine if a maneuver was flying. */
  dispose(): void {
    this.abort('commander');
    this.session.hook = null;
    this.session.onManualInput = null;
  }

  subscribe(l: PilotListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(e: PilotEvent): void {
    for (const l of this.listeners) l(e);
  }

  get busy(): boolean {
    return this.active !== null;
  }

  setAssist(on: boolean): void {
    if (on === this.assist) return;
    if (!on) {
      this.cancel();
      this.abort('assist-off');
    }
    this.assist = on;
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      // Private mode: the setting lasts for this page only.
    }
    this.emit({ kind: 'assist', on });
  }

  /** Plans a maneuver and offers it to the commander. Returns the plan (feasible or not). */
  propose(maneuver: Maneuver): Plan {
    const plan = this.assist ? maneuver.plan(this.ctx()) : infeasible('AI assist is switched off.');
    this.proposal = null;
    if (!plan.feasible) {
      this.refuse(maneuver.label, plan.reason ?? 'That is not possible right now.');
      return plan;
    }
    this.proposal = { maneuver, plan };
    this.emit({ kind: 'proposed', maneuver, plan });
    return plan;
  }

  /** Tells the commander ARGUS cannot do something (also used before a plan exists). */
  refuse(label: string, reason: string): void {
    this.emit({ kind: 'refused', label, reason });
  }

  cancel(): void {
    if (!this.proposal) return;
    const { maneuver } = this.proposal;
    this.proposal = null;
    this.emit({ kind: 'cancelled', maneuver });
  }

  /** Commander accepts the proposal; the maneuver starts flying. Replaces any running one. */
  confirm(): boolean {
    const p = this.proposal;
    if (!p || !this.assist) return false;
    this.proposal = null;
    if (this.active) this.abort('commander');
    this.active = p.maneuver;
    this.status = null;
    this.lastPhase = '';
    this.warpManual = false;
    this.warpBefore = this.session.warpIndex;
    this.warpSet = -1;
    p.maneuver.start(this.ctx());
    this.emit({ kind: 'started', maneuver: p.maneuver });
    return true;
  }

  abort(cause: 'commander' | 'override' | 'assist-off' = 'commander'): void {
    const m = this.active;
    if (!m) return;
    m.abort(this.ctx());
    this.session.refresh();
    this.finish();
    this.emit({ kind: 'aborted', maneuver: m, cause });
  }

  /** The commander touched the controls. They always win. */
  manualInput(): void {
    this.proposal = null;
    if (this.active) this.abort('override');
  }

  // ---- StepHook -----------------------------------------------------------------

  maxSteps(): number {
    if (!this.active || !this.status) return this.active ? 1 : Infinity;
    return this.status.coast > 0 ? Math.max(1, Math.floor(this.status.coast / SIM_DT)) : 1;
  }

  warpCap(): number {
    if (!this.active) return Infinity;
    return !this.status || this.status.coast <= 0 ? MAX_WARP_UNDER_THRUST : Infinity;
  }

  afterSteps(): void {
    const m = this.active;
    if (!m) return;
    if (!this.session.player().alive) {
      this.finish();
      this.emit({ kind: 'failed', maneuver: m, reason: 'The ship is lost.' });
      return;
    }
    const st = m.execute(this.ctx());
    this.status = st;
    this.session.refresh();
    if (st.state === 'running') {
      const phase = st.phase.split('.').pop() ?? st.phase;
      if (phase !== this.lastPhase) {
        this.lastPhase = phase;
        this.emit({ kind: 'phase', maneuver: m, phase });
      }
      this.steerWarp(st);
      return;
    }
    this.finish();
    if (st.state === 'done') this.emit({ kind: 'done', maneuver: m });
    else this.emit({ kind: 'failed', maneuver: m, reason: st.reason ?? 'It did not work.' });
  }

  /** Warps through long coasts and drops to 1x for the work. */
  private steerWarp(st: Status): void {
    const s = this.session;
    if (!this.autoWarp || this.warpManual) return;
    if (this.warpSet >= 0 && s.warpIndex !== this.warpSet) {
      this.warpManual = true; // the commander took the warp control
      return;
    }
    const levels = this.cfg.autoWarp.levels;
    let pick = 0;
    if (st.coast > 0) {
      for (let i = 0; i < levels.length; i++) {
        if (st.coast / levels[i] >= this.cfg.autoWarp.minRealSeconds) pick = i;
      }
    } else if (WORK_PHASES.has(st.phase.split('.').pop() ?? '')) {
      pick = Math.max(0, levels.indexOf(this.cfg.autoWarp.workLevel));
    }
    s.setWarp(pick);
    this.warpSet = s.warpIndex;
  }

  private finish(): void {
    if (this.autoWarp && !this.warpManual && this.warpSet >= 0)
      this.session.setWarp(this.warpBefore);
    this.active = null;
    this.status = null;
  }

  // ---- context ------------------------------------------------------------------

  private helm(): Helm {
    const s = this.session;
    const g = s.game;
    const id = s.playerId;
    return {
      setAttitude: (mode) => g.set_attitude(id, mode),
      setThrottle: (t) => g.set_throttle(id, Math.max(0, Math.min(1, t))),
      setTarget: (t) => g.set_target(id, t ?? -1),
      fireMissile: () => {
        const ok = g.launch_missile(id) >= 0;
        s.refresh();
        return ok;
      },
      dropMine: () => {
        const ok = g.drop_mine(id) >= 0;
        s.refresh();
        return ok;
      },
    };
  }

  /** Builds the read-only world view the scripts plan and fly from. */
  ctx(): Ctx {
    const s = this.session;
    const self = s.player();
    return {
      time: s.time,
      mu: s.game.mu(),
      planetRadius: s.planetRadius,
      self,
      orbit: self.alive ? s.orbit(self.id) : null,
      entities: s.all(),
      entity: (id) => s.entity(id),
      orbitOf: (id) => s.orbit(id),
      helm: this.helm(),
      cfg: this.cfg,
      munitionsLeft: (kind) => s.munitionsLeft(self.id)[kind],
      classStats: (c) => this.stats(c),
      missile: this.missile,
      mine: this.mine,
    };
  }

  private stats(shipClass: number): ClassStats {
    let c = this.classCache.get(shipClass);
    if (!c) {
      c = decodeClassStats(Game.class_stats(shipClass));
      this.classCache.set(shipClass, c);
    }
    return c;
  }

  /** Values ARGUS may mention about the ship and its target right now. */
  speechVars(): Record<string, string> {
    const s = this.session;
    const me = s.player();
    const orbit = s.orbit(me.id);
    const R = s.planetRadius;
    const vars: Record<string, string> = {};
    if (orbit) {
      vars.pe = fmtDistance(orbit.periapsis - R);
      vars.ap = Number.isFinite(orbit.apoapsis) ? fmtDistance(orbit.apoapsis - R) : 'escape';
      vars.period = fmtDuration(orbit.period);
    }
    const t = s.entity(me.target);
    if (t?.alive && t.kind === EntityKind.Ship) vars.range = fmtDistance(len(sub(t.pos, me.pos)));
    return vars;
  }
}

function munition(kind: number): MunitionStats {
  const [
    ,
    deltaV = 0,
    accel = 0,
    closingSpeed = 0,
    blastRadius = 0,
    ,
    armTime = 0,
    triggerRange = 0,
    lifetime = 0,
  ] = Game.munition_stats(kind);
  return { deltaV, accel, closingSpeed, blastRadius, armTime, triggerRange, lifetime };
}
