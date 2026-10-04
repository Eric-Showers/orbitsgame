import { Attitude, len, sub, type EntityView, type Vec3 } from '../../sim/bridge';
import { fmtDistance, fmtDuration, fmtSpeed } from '../../ui/format';
import { angleBetween, scale, unit } from '../orbitmath';
import type { Ctx, Plan } from '../types';

/** Direction the ship's attitude hold would point in, planar. Mirrors `World::desired_heading`. */
export function desiredHeading(ctx: Ctx, mode: Attitude): Vec3 | null {
  const me = ctx.self;
  const target = ctx.entity(me.target);
  const tgt = target?.alive ? target : undefined;
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

/** Heading error (rad) from the commanded attitude mode; Infinity if undefined. */
export function headingError(ctx: Ctx, mode: Attitude): number {
  const want = desiredHeading(ctx, mode);
  return want ? angleBetween(ctx.self.heading, want) : Infinity;
}

export const burnSeconds = (ctx: Ctx, dv: number): number =>
  ctx.self.maxAccel > 0 ? dv / ctx.self.maxAccel : Infinity;

export const usableDv = (ctx: Ctx): number =>
  ctx.self.deltaV * (1 - ctx.cfg.safety.reserveDvFraction);

export const speedOf = (e: EntityView): number => len(e.vel);

/** Plan skeleton for a ship that cannot fly at all. */
export function cannotFly(ctx: Ctx): string | null {
  if (!ctx.self.alive) return 'The ship is lost.';
  if (ctx.self.maxAccel <= 0) return 'This vessel has no main engine.';
  if (ctx.self.fuel <= 0) return 'The tanks are dry.';
  return null;
}

export function costVars(plan: Pick<Plan, 'dv' | 'eta'>): Record<string, string> {
  return { dv: fmtSpeed(plan.dv), eta: fmtDuration(plan.eta) };
}

export { fmtDistance, fmtDuration, fmtSpeed };
