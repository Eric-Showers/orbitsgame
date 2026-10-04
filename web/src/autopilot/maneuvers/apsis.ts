import { Attitude } from '../../sim/bridge';
import {
  apsisSpeed,
  propagate,
  timeToApsis,
  timeToTrueAnomaly,
  periodOf,
  type Apsis,
} from '../orbitmath';
import { infeasible, resolve, type Ctx, type Lazy, type Maneuver, type Plan } from '../types';
import { BurnManeuver, type BurnSolution } from './burn';
import { burnSeconds, cannotFly, costVars, fmtDistance, usableDv } from './common';
import { Sequence } from './sequence';

export type Where = 'now' | Apsis | { time: Lazy<number> };
/** Radius (m) of the apsis opposite the burn point; `circular` means "same as here". */
export type Other = 'circular' | Lazy<number>;

/** Seconds until the orbit dips under the surface radius, or Infinity if it never does. */
export function timeToImpact(ctx: Ctx): number {
  const o = ctx.orbit;
  if (!o || o.periapsis >= ctx.planetRadius) return Infinity;
  const cosNu = (o.semiLatusRectum / ctx.planetRadius - 1) / o.eccentricity;
  const nu = 2 * Math.PI - Math.acos(Math.max(-1, Math.min(1, cosNu)));
  return timeToTrueAnomaly(o, nu);
}

/**
 * Burns prograde or retrograde at an apsis (or right now) to put the opposite
 * apsis at a chosen radius. The building block of circularize and Hohmann.
 */
export class ApsisBurn extends BurnManeuver {
  private otherRadius = 0;

  constructor(
    kind: string,
    label: string,
    protected where: Where,
    private other: Other,
  ) {
    super(kind, label);
  }

  protected solve(ctx: Ctx, latch: boolean): BurnSolution | string {
    const o = ctx.orbit;
    if (!o) return 'No orbit solution.';
    let time = ctx.time;
    if (this.where !== 'now') {
      if (typeof this.where === 'object') time = resolve(this.where.time, ctx);
      else if (!Number.isFinite(o.period)) return 'This orbit never comes back to an apsis.';
      else time = ctx.time + timeToApsis(o, this.where);
    }
    if (time - ctx.time > timeToImpact(ctx)) return 'We would hit the surface before that burn.';
    const st = propagate(ctx.mu, ctx.self.pos, ctx.self.vel, time - ctx.time);
    const r = Math.hypot(st.pos.x, st.pos.y);
    const v = Math.hypot(st.vel.x, st.vel.y);
    const other = this.other === 'circular' ? r : resolve(this.other, ctx);
    if (other < ctx.planetRadius + ctx.cfg.safety.minAltitude && other < r) {
      return `That orbit would dip below ${fmtDistance(ctx.cfg.safety.minAltitude)}.`;
    }
    if (latch) this.otherRadius = other;
    const vReq = apsisSpeed(ctx.mu, r, other);
    return {
      time,
      mode: vReq > v ? Attitude.Prograde : Attitude.Retrograde,
      dv: Math.abs(vReq - v),
    };
  }

  protected remaining(ctx: Ctx): number {
    const me = ctx.self;
    const r = Math.hypot(me.pos.x, me.pos.y);
    const v = Math.hypot(me.vel.x, me.vel.y);
    const sign = this.node?.mode === Attitude.Prograde ? 1 : -1;
    return sign * (apsisSpeed(ctx.mu, r, this.otherRadius) - v);
  }
}

/** Make the orbit round at an apsis. Apoapsis (raising periapsis) is the default and cheaper. */
export function circularize(at: 'auto' | Apsis = 'auto'): Maneuver {
  return new CircularizeBurn(at);
}

class CircularizeBurn extends ApsisBurn {
  constructor(private at: 'auto' | Apsis) {
    super('circularize', 'Circularize', 'apoapsis', 'circular');
  }

  private pick(ctx: Ctx): Apsis {
    if (this.at !== 'auto') return this.at;
    return ctx.orbit && Number.isFinite(ctx.orbit.apoapsis) ? 'apoapsis' : 'periapsis';
  }

  private bind(ctx: Ctx): void {
    this.where = this.pick(ctx);
  }

  plan(ctx: Ctx): Plan {
    this.bind(ctx);
    if (ctx.orbit && ctx.orbit.eccentricity < ctx.cfg.safety.circularEcc / 4) {
      return {
        feasible: true,
        nodes: [],
        dv: 0,
        eta: 0,
        vars: { ...costVars({ dv: 0, eta: 0 }), note: 'already circular' },
      };
    }
    return super.plan(ctx);
  }

  start(ctx: Ctx): void {
    this.bind(ctx);
    super.start(ctx);
  }
}

/** Two-burn Hohmann transfer to a circular orbit at `targetAlt` (m above the surface). */
export function changeAltitude(targetAlt: number): Maneuver {
  const R = (ctx: Ctx): number => ctx.planetRadius + targetAlt;
  interface Geometry {
    first: { where: Where; rBurn: number };
    second: Apsis;
    skip: boolean;
  }
  const geometry = (ctx: Ctx): Geometry | string => {
    const o = ctx.orbit;
    const cfg = ctx.cfg;
    if (!o || !Number.isFinite(o.period)) return 'I have no closed orbit to transfer from.';
    if (targetAlt < cfg.safety.minAltitude) {
      return `Orbits below ${fmtDistance(cfg.safety.minAltitude)} are too close to the ground.`;
    }
    if (targetAlt > cfg.safety.maxAltitude) {
      return `Orbits above ${fmtDistance(cfg.safety.maxAltitude)} are out of range.`;
    }
    const r = ctx.planetRadius + targetAlt;
    if (o.periapsis < ctx.planetRadius + cfg.safety.minAltitude / 2) {
      return 'Our current orbit is too low to maneuver safely. Raise periapsis first.';
    }
    const circ = o.eccentricity < cfg.safety.circularEcc;
    const here = Math.hypot(ctx.self.pos.x, ctx.self.pos.y);
    if (circ && Math.abs(r - here) < cfg.altitude.tolerance) {
      return { first: { where: 'now', rBurn: here }, second: 'apoapsis', skip: true };
    }
    let first: Geometry['first'];
    if (circ) first = { where: 'now', rBurn: here };
    else if (r >= o.periapsis) first = { where: 'periapsis', rBurn: o.periapsis };
    else first = { where: 'apoapsis', rBurn: o.apoapsis };
    return { first, second: r > first.rBurn ? 'apoapsis' : 'periapsis', skip: false };
  };

  const planner = (ctx: Ctx): Plan => {
    const g = geometry(ctx);
    if (typeof g === 'string') return infeasible(g);
    const blocked = cannotFly(ctx);
    if (blocked) return infeasible(blocked);
    const r = R(ctx);
    const vars = { alt: fmtDistance(targetAlt) };
    if (g.skip)
      return {
        feasible: true,
        nodes: [],
        dv: 0,
        eta: 0,
        vars: { ...costVars({ dv: 0, eta: 0 }), ...vars },
      };
    const o = ctx.orbit!;
    const t1 =
      g.first.where === 'now' ? ctx.time : ctx.time + timeToApsis(o, g.first.where as Apsis);
    const a = o.semiMajorAxis;
    const vHere = Math.sqrt(ctx.mu * (2 / g.first.rBurn - 1 / a));
    const vTransfer1 = apsisSpeed(ctx.mu, g.first.rBurn, r);
    const dv1 = Math.abs(vTransfer1 - vHere);
    const aT = (g.first.rBurn + r) / 2;
    const dv2 = Math.abs(Math.sqrt(ctx.mu / r) - apsisSpeed(ctx.mu, r, g.first.rBurn));
    const t2 = t1 + periodOf(ctx.mu, aT) / 2;
    const dv = dv1 + dv2;
    if (dv > usableDv(ctx)) return infeasible('Not enough fuel for that transfer.');
    const eta = t2 - ctx.time + burnSeconds(ctx, dv2) / 2;
    const mode1 = vTransfer1 > vHere ? Attitude.Prograde : Attitude.Retrograde;
    const mode2 = r > g.first.rBurn ? Attitude.Prograde : Attitude.Retrograde;
    return {
      feasible: true,
      nodes: [
        { time: t1, mode: mode1, dv: dv1, label: 'Transfer burn' },
        { time: t2, mode: mode2, dv: dv2, label: 'Circularize' },
      ],
      dv,
      eta,
      vars: { ...costVars({ dv, eta }), ...vars },
    };
  };

  return new Sequence(
    'altitude',
    'Change altitude',
    [
      (ctx) => {
        const g = geometry(ctx);
        const where: Where = typeof g === 'string' ? 'now' : g.first.where;
        return new ApsisBurn('altitude.1', 'Transfer burn', where, R);
      },
      (ctx) => {
        // After burn 1 the orbit's far side is at R; circularize there.
        const o = ctx.orbit;
        const at: Apsis =
          o && Math.abs(o.apoapsis - R(ctx)) < Math.abs(o.periapsis - R(ctx))
            ? 'apoapsis'
            : 'periapsis';
        return new ApsisBurn('altitude.2', 'Circularize', at, 'circular');
      },
    ],
    planner,
  );
}
