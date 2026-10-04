import { Attitude } from '../../sim/bridge';
import { angleBetween } from '../orbitmath';
import {
  failed,
  infeasible,
  type BurnNode,
  type Ctx,
  type Maneuver,
  type Plan,
  type Status,
} from '../types';
import {
  burnSeconds,
  cannotFly,
  costVars,
  desiredHeading,
  headingError,
  usableDv,
} from './common';

/** Where, when and in which direction a burn happens, decided at plan/start time. */
export interface BurnSolution {
  time: number;
  mode: Attitude;
  dv: number;
}

type Phase = 'coast' | 'align' | 'burn' | 'done';

/**
 * Closed-loop burn: waits for its node, points the ship, then burns with a
 * tapering throttle until `remaining` reaches the tolerance. Subclasses say
 * when and which way to burn and how much dv is still owed.
 */
export abstract class BurnManeuver implements Maneuver {
  protected node: BurnSolution | null = null;
  protected phase: Phase = 'coast';
  private alignedFor = 0;
  private lastTime = 0;
  private burnStart = 0;
  private dvStart = 0;

  constructor(
    readonly kind: string,
    readonly label: string,
  ) {}

  /** Pure: the burn this maneuver would fly now, or a reason it cannot. */
  protected abstract solve(ctx: Ctx, latch: boolean): BurnSolution | string;
  /** Dv still to burn along `node.mode` (m/s); at or under tolerance means done. */
  protected abstract remaining(ctx: Ctx): number;

  protected tolerance(ctx: Ctx): number {
    return ctx.cfg.burn.dvTolerance;
  }

  /** The node time once started (for scripts that schedule off a burn). */
  get nodeTime(): number | null {
    return this.node?.time ?? null;
  }

  plan(ctx: Ctx): Plan {
    const sol = this.solve(ctx, false);
    if (typeof sol === 'string') return infeasible(sol);
    if (sol.dv < ctx.cfg.burn.minDvToBurn) {
      return { feasible: true, nodes: [], dv: 0, eta: 0, vars: costVars({ dv: 0, eta: 0 }) };
    }
    const blocked = cannotFly(ctx);
    if (blocked) return infeasible(blocked);
    if (sol.dv > usableDv(ctx)) return infeasible('Not enough fuel for that burn.');
    const node: BurnNode = { time: sol.time, mode: sol.mode, dv: sol.dv, label: this.label };
    const eta = sol.time - ctx.time + burnSeconds(ctx, sol.dv) / 2;
    return { feasible: true, nodes: [node], dv: sol.dv, eta, vars: costVars({ dv: sol.dv, eta }) };
  }

  start(ctx: Ctx): void {
    const sol = this.solve(ctx, true);
    this.node = typeof sol === 'string' ? null : sol;
    this.phase = this.node && this.node.dv >= ctx.cfg.burn.minDvToBurn ? 'coast' : 'done';
    this.alignedFor = 0;
    this.lastTime = ctx.time;
    this.dvStart = this.node?.dv ?? 0;
  }

  execute(ctx: Ctx): Status {
    const n = this.node;
    const dt = Math.max(0, ctx.time - this.lastTime);
    this.lastTime = ctx.time;
    if (!n) return failed('I could not solve that burn.');
    if (!ctx.self.alive) return failed('The ship is lost.');
    const cfg = ctx.cfg;
    const status = (phase: string, progress: number, note: string, coast = 0): Status => ({
      state: 'running',
      phase,
      progress,
      note,
      coast,
    });

    if (this.phase === 'done') {
      ctx.helm.setThrottle(0);
      return { state: 'done', phase: 'done', progress: 1, note: 'Complete', coast: 0 };
    }

    if (this.phase === 'coast' || this.phase === 'align') {
      if (ctx.self.mode !== n.mode && !ctx.helm.setAttitude(n.mode)) {
        return failed('The ship will not take that attitude. Is a target selected?');
      }
      const dur = burnSeconds(ctx, n.dv);
      const wait = n.time - dur / 2 - ctx.time;
      const aligned = headingError(ctx, n.mode) <= cfg.attitude.alignTolerance;
      this.alignedFor = aligned ? this.alignedFor + dt : 0;
      if (wait > cfg.burn.ignitionAlignSeconds) {
        return status('coast', 0, 'Coasting to burn', wait - cfg.burn.ignitionAlignSeconds);
      }
      if (wait > 0 || this.alignedFor < cfg.attitude.settleSeconds) {
        this.phase = 'align';
        return status('align', 0, 'Aligning');
      }
      this.phase = 'burn';
      this.burnStart = ctx.time;
    }

    // Burn.
    const rem = this.remaining(ctx);
    if (rem <= this.tolerance(ctx)) {
      ctx.helm.setThrottle(0);
      this.phase = 'done';
      return { state: 'done', phase: 'done', progress: 1, note: 'Burn complete', coast: 0 };
    }
    if (ctx.self.fuel <= 0) {
      ctx.helm.setThrottle(0);
      return failed('Out of fuel mid-burn.');
    }
    if (ctx.time - this.burnStart > cfg.burn.maxBurnSeconds) {
      ctx.helm.setThrottle(0);
      return failed('The burn is taking too long. Aborting.');
    }
    const want = desiredHeading(ctx, n.mode);
    if (want && angleBetween(ctx.self.heading, want) > cfg.attitude.alignTolerance * 8) {
      // Lost the heading (target moved, mode changed): cut and re-align.
      ctx.helm.setThrottle(0);
      this.phase = 'align';
      this.alignedFor = 0;
      return status('align', 0, 'Re-aligning');
    }
    const throttle = Math.min(
      1,
      Math.max(cfg.burn.minThrottle, rem / (ctx.self.maxAccel * cfg.burn.taperSeconds)),
    );
    ctx.helm.setThrottle(throttle);
    const progress = this.dvStart > 0 ? Math.min(0.99, 1 - rem / this.dvStart) : 0;
    return status('burn', progress, `Burning, ${rem.toFixed(1)} m/s to go`);
  }

  abort(ctx: Ctx): void {
    ctx.helm.setThrottle(0);
  }
}
