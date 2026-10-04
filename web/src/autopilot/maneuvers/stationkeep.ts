import { len, sub } from '../../sim/bridge';
import { failed, infeasible, type Ctx, type Maneuver, type Plan, type Status } from '../types';
import { fmtDistance, fmtSpeed } from './common';
import { MatchVelocity, relSpeed } from './match';
import { Rendezvous } from './rendezvous';

/**
 * Holds station beside a target: watches the relative velocity and nulls it
 * whenever it leaves a deadband; if the target slips outside the hold range
 * it flies a rendezvous to close again. Runs until aborted.
 */
export class StationKeep implements Maneuver {
  readonly kind = 'station-keep';
  readonly label = 'Station-keep';
  private fix: Maneuver | null = null;
  private fixLabel = '';

  constructor(private targetId: number) {}

  plan(ctx: Ctx): Plan {
    const t = ctx.entity(this.targetId);
    if (!t?.alive) return infeasible('The target is gone.');
    if (ctx.self.maxAccel <= 0) return infeasible('This vessel has no main engine.');
    const range = len(sub(t.pos, ctx.self.pos));
    return {
      feasible: true,
      nodes: [],
      dv: 0,
      eta: 0,
      vars: { range: fmtDistance(range), hold: fmtDistance(ctx.cfg.stationKeep.holdRange) },
    };
  }

  start(ctx: Ctx): void {
    this.fix = null;
    if (ctx.self.target !== this.targetId) ctx.helm.setTarget(this.targetId);
  }

  execute(ctx: Ctx): Status {
    const t = ctx.entity(this.targetId);
    if (!t?.alive) return failed('Lost the target.');
    const cfg = ctx.cfg.stationKeep;
    if (this.fix) {
      const st = this.fix.execute(ctx);
      if (st.state === 'running')
        return { ...st, progress: 0, note: `${this.fixLabel}: ${st.note}` };
      this.fix = null;
      if (st.state === 'failed') return failed(st.reason ?? 'Station-keeping failed.');
    }
    const range = len(sub(t.pos, ctx.self.pos));
    const rel = relSpeed(ctx, this.targetId) ?? 0;
    if (rel > cfg.deadband) {
      this.engage(ctx, new MatchVelocity(this.targetId), 'Nulling drift');
    } else if (range > cfg.holdRange) {
      this.engage(
        ctx,
        new Rendezvous(this.targetId, cfg.recaptureStandoff, 'Re-closing'),
        'Closing',
      );
    }
    return {
      state: 'running',
      phase: this.fix ? 'correct' : 'hold',
      progress: 0,
      note: `Holding at ${fmtDistance(range)}, drift ${fmtSpeed(rel)}`,
      coast: this.fix ? 0 : 1,
    };
  }

  private engage(ctx: Ctx, m: Maneuver, label: string): void {
    if (!m.plan(ctx).feasible) return;
    m.start(ctx);
    this.fix = m;
    this.fixLabel = label;
  }

  abort(ctx: Ctx): void {
    this.fix?.abort(ctx);
    ctx.helm.setThrottle(0);
  }
}
