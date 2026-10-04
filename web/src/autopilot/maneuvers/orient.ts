import { Attitude } from '../../sim/bridge';
import { failed, infeasible, type Ctx, type Maneuver, type Plan, type Status } from '../types';
import { headingError } from './common';

const NAMES: Partial<Record<Attitude, string>> = {
  [Attitude.Hold]: 'hold heading',
  [Attitude.Prograde]: 'prograde',
  [Attitude.Retrograde]: 'retrograde',
  [Attitude.RadialOut]: 'radial out',
  [Attitude.RadialIn]: 'radial in',
  [Attitude.Target]: 'target',
  [Attitude.AntiTarget]: 'away from target',
  [Attitude.TargetPrograde]: 'target prograde',
  [Attitude.TargetRetrograde]: 'target retrograde',
};

export const attitudeName = (mode: Attitude): string => NAMES[mode] ?? 'attitude';

/**
 * Points the ship along an attitude mode. With `hold` it keeps running (the
 * mode tracks as the orbit moves); otherwise it finishes once aligned.
 */
export class Orient implements Maneuver {
  readonly kind = 'orient';
  readonly label: string;
  private alignedFor = 0;
  private lastTime = 0;

  constructor(
    private mode: Attitude,
    private hold = false,
  ) {
    this.label = `Point ${attitudeName(mode)}`;
  }

  plan(ctx: Ctx): Plan {
    if (!ctx.self.alive) return infeasible('The ship is lost.');
    if (this.mode >= Attitude.Target && this.mode <= Attitude.TargetRetrograde && !ctx.entity(ctx.self.target)) {
      return infeasible('Select a target first.');
    }
    const slew = ctx.classStats(ctx.self.shipClass).slewRate;
    const eta = slew > 0 ? Math.PI / slew : Infinity;
    return { feasible: true, nodes: [], dv: 0, eta, vars: { mode: attitudeName(this.mode) } };
  }

  start(ctx: Ctx): void {
    this.alignedFor = 0;
    this.lastTime = ctx.time;
  }

  execute(ctx: Ctx): Status {
    const dt = Math.max(0, ctx.time - this.lastTime);
    this.lastTime = ctx.time;
    if (!ctx.self.alive) return failed('The ship is lost.');
    if (ctx.self.mode !== this.mode && !ctx.helm.setAttitude(this.mode)) {
      return failed('The ship will not take that attitude. Is a target selected?');
    }
    const aligned = headingError(ctx, this.mode) <= ctx.cfg.attitude.alignTolerance;
    this.alignedFor = aligned ? this.alignedFor + dt : 0;
    const settled = this.alignedFor >= ctx.cfg.attitude.settleSeconds;
    if (settled && !this.hold) {
      return { state: 'done', phase: 'done', progress: 1, note: 'Aligned', coast: 0 };
    }
    return {
      state: 'running',
      phase: settled ? 'hold' : 'align',
      progress: settled ? 1 : 0,
      note: settled ? 'Holding' : 'Aligning',
      coast: settled ? 1 : 0,
    };
  }

  abort(): void {}
}
