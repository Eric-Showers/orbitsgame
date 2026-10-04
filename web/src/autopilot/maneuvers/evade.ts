import { Attitude, EntityKind, len, sub } from '../../sim/bridge';
import { failed, infeasible, type Ctx, type Maneuver, type Plan, type Status } from '../types';
import { cannotFly, fmtDistance } from './common';

/**
 * Dodges incoming munitions: while any missile or hunting mine is locked on
 * us inside the warn range, burns across the line of sight (radial out, then
 * radial in on the next dodge, never below a safe altitude). Done once the
 * sky has been clear for a while.
 */
export class Evade implements Maneuver {
  readonly kind = 'evade';
  readonly label = 'Evade';
  private burnUntil = -Infinity;
  private burning = false;
  private outward = true;
  private clearSince = 0;

  private threats(ctx: Ctx): number {
    const me = ctx.self;
    return ctx.entities.filter(
      (e) =>
        e.alive &&
        (e.kind === EntityKind.Missile || e.kind === EntityKind.Mine) &&
        e.team !== me.team &&
        e.target === me.id &&
        len(sub(e.pos, me.pos)) <= ctx.cfg.evade.warnRange,
    ).length;
  }

  plan(ctx: Ctx): Plan {
    const blocked = cannotFly(ctx);
    if (blocked) return infeasible(blocked);
    const n = this.threats(ctx);
    if (n === 0) return infeasible('Nothing is locked on us right now.');
    const dv = ctx.self.maxAccel * ctx.cfg.evade.burnSeconds * ctx.cfg.evade.throttle;
    return {
      feasible: true,
      nodes: [],
      dv,
      eta: ctx.cfg.evade.burnSeconds,
      vars: { count: String(n), dv: dv.toFixed(0) + ' m/s', range: fmtDistance(ctx.cfg.evade.warnRange) },
    };
  }

  start(ctx: Ctx): void {
    this.burning = false;
    this.burnUntil = -Infinity;
    this.clearSince = ctx.time;
  }

  execute(ctx: Ctx): Status {
    if (!ctx.self.alive) return failed('The ship is lost.');
    const cfg = ctx.cfg.evade;
    const threatened = this.threats(ctx) > 0;
    if (this.burning && ctx.time >= this.burnUntil) {
      ctx.helm.setThrottle(0);
      this.burning = false;
    }
    if (threatened) this.clearSince = ctx.time;
    if (threatened && !this.burning) {
      if (ctx.self.fuel <= 0) return failed('No fuel to dodge with.');
      const o = ctx.orbit;
      const roomBelow = o ? o.periapsis - ctx.planetRadius > cfg.altitudeMargin * 2 : false;
      const mode = this.outward || !roomBelow ? Attitude.RadialOut : Attitude.RadialIn;
      this.outward = !this.outward;
      ctx.helm.setAttitude(mode);
      ctx.helm.setThrottle(cfg.throttle);
      this.burning = true;
      this.burnUntil = ctx.time + cfg.burnSeconds;
    }
    if (!threatened && !this.burning && ctx.time - this.clearSince >= cfg.clearSeconds) {
      return { state: 'done', phase: 'done', progress: 1, note: 'Clear', coast: 0 };
    }
    return {
      state: 'running',
      phase: this.burning ? 'burn' : threatened ? 'threat' : 'watch',
      progress: 0,
      note: this.burning ? 'Dodging' : threatened ? 'Threat inbound' : 'Watching for threats',
      coast: 0,
    };
  }

  abort(ctx: Ctx): void {
    ctx.helm.setThrottle(0);
  }
}
