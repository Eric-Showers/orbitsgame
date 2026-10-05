import { Attitude, len, outputCapAt, sub, type EntityView, type Vec3 } from '../../sim/bridge';
import { fmtDistance, fmtDuration, fmtSpan, fmtSpeed } from '../../ui/format';
import { angleBetween, scale, unit } from '../orbitmath';
import type { Ctx, Plan } from '../types';

/** Planar direction an attitude hold points `me` along, given its target (if any). Mirrors `World::desired_heading`. */
export function modeDirection(
  me: EntityView,
  tgt: EntityView | undefined,
  mode: Attitude,
): Vec3 | null {
  let dir: Vec3 | null;
  switch (mode) {
    case Attitude.Hold:
      return null;
    case Attitude.Prograde:
      dir = me.vel;
      break;
    case Attitude.Retrograde:
      dir = scale(me.vel, -1);
      break;
    case Attitude.RadialOut:
      dir = me.pos;
      break;
    case Attitude.RadialIn:
      dir = scale(me.pos, -1);
      break;
    case Attitude.Target:
      dir = tgt ? sub(tgt.pos, me.pos) : null;
      break;
    case Attitude.AntiTarget:
      dir = tgt ? sub(me.pos, tgt.pos) : null;
      break;
    case Attitude.TargetPrograde:
      dir = tgt ? sub(me.vel, tgt.vel) : null;
      break;
    case Attitude.TargetRetrograde:
      dir = tgt ? sub(tgt.vel, me.vel) : null;
      break;
    default:
      return null;
  }
  if (!dir) return null;
  const flat = unit({ x: dir.x, y: dir.y, z: 0 });
  return flat.x === 0 && flat.y === 0 ? null : flat;
}

/** Direction the ship's attitude hold would point in, planar. */
export function desiredHeading(ctx: Ctx, mode: Attitude): Vec3 | null {
  const target = ctx.entity(ctx.self.target);
  return modeDirection(ctx.self, target?.alive ? target : undefined, mode);
}

/** Heading error (rad) from the commanded attitude mode; Infinity if undefined. */
export function headingError(ctx: Ctx, mode: Attitude): number {
  const want = desiredHeading(ctx, mode);
  return want ? angleBetween(ctx.self.heading, want) : Infinity;
}

const THERMAL_STEP = 0.5;

/**
 * Seconds a full-throttle burn of `dv` takes from the ship's present heat,
 * stepping the same thermal model the sim runs (heat builds, output derates).
 */
export function burnSeconds(ctx: Ctx, dv: number): number {
  const me = ctx.self;
  if (me.maxAccel <= 0) return Infinity;
  if (me.heatCapacity <= 0) return dv / me.maxAccel;
  const c = ctx.classStats(me.shipClass);
  const limit = ctx.cfg.burn.maxBurnSeconds;
  let heat = me.heat;
  let left = dv;
  let t = 0;
  while (left > 0 && t < limit * 2) {
    const load = heat / c.heatCapacity;
    const out = outputCapAt(c, load);
    const step = Math.min(THERMAL_STEP, left / (me.maxAccel * out));
    left -= me.maxAccel * out * step;
    heat = Math.min(
      c.heatCapacity,
      Math.max(0, heat + (c.heatGain * out - (c.radiateBase + c.radiateSlope * load)) * step),
    );
    t += step;
  }
  return left > 0 ? Infinity : t;
}

/** True when the drive could not deliver `dv` inside the longest burn the autopilot will fly. */
export const burnTooLong = (ctx: Ctx, dv: number): boolean =>
  burnSeconds(ctx, dv) > ctx.cfg.burn.maxBurnSeconds;

export const speedOf = (e: EntityView): number => len(e.vel);

/** Plan skeleton for a ship that cannot fly at all. */
export function cannotFly(ctx: Ctx): string | null {
  if (!ctx.self.alive) return 'The ship is lost.';
  if (ctx.self.maxAccel <= 0) return 'This vessel has no main engine.';
  return null;
}

export function costVars(plan: Pick<Plan, 'dv' | 'eta'>): Record<string, string> {
  return { dv: fmtSpeed(plan.dv), eta: fmtSpan(plan.eta) };
}

export { fmtDistance, fmtDuration, fmtSpeed };
