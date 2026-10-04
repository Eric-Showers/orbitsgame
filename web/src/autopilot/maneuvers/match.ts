import { Attitude, len, sub } from '../../sim/bridge';
import type { Ctx, Plan } from '../types';
import { BurnManeuver, type BurnSolution } from './burn';
import { fmtSpeed } from './common';

export function relSpeed(ctx: Ctx, id: number): number | null {
  const t = ctx.entity(id);
  return t?.alive ? len(sub(t.vel, ctx.self.vel)) : null;
}

/** Burns against the relative velocity until the target and we drift together. */
export class MatchVelocity extends BurnManeuver {
  constructor(private targetId: number) {
    super('match-velocity', 'Match velocity', 'We are already drifting together.');
  }

  /** Gravity pulls bodies on different orbits apart, so far from the target only a floor is reachable. */
  protected tolerance(ctx: Ctx): number {
    const t = ctx.entity(this.targetId);
    const mv = ctx.cfg.matchVelocity;
    if (!t) return mv.tolerance;
    const r = len(ctx.self.pos);
    const tidal = ((ctx.mu / (r * r)) * len(sub(t.pos, ctx.self.pos))) / r;
    return Math.max(mv.tolerance, tidal * mv.tidalSeconds);
  }

  protected solve(ctx: Ctx, latch: boolean): BurnSolution | string {
    const rel = relSpeed(ctx, this.targetId);
    if (rel === null) return 'The target is gone.';
    if (latch && ctx.self.target !== this.targetId) ctx.helm.setTarget(this.targetId);
    const dv = rel <= this.tolerance(ctx) ? 0 : rel;
    return { time: ctx.time, mode: Attitude.TargetRetrograde, dv };
  }

  plan(ctx: Ctx): Plan {
    const p = super.plan(ctx);
    const rel = relSpeed(ctx, this.targetId);
    return p.feasible ? { ...p, vars: { ...p.vars, rel: fmtSpeed(rel ?? 0) } } : p;
  }

  protected remaining(ctx: Ctx): number {
    return relSpeed(ctx, this.targetId) ?? 0;
  }
}
