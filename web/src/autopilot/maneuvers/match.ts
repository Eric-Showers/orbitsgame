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
    super('match-velocity', 'Match velocity');
  }

  protected tolerance(ctx: Ctx): number {
    return ctx.cfg.matchVelocity.tolerance;
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

