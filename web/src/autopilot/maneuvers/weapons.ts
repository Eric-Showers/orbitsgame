import { EntityKind, len, sub, dot } from '../../sim/bridge';
import { closestApproach } from '../orbitmath';
import { failed, infeasible, type Ctx, type Maneuver, type Plan, type Status } from '../types';
import { fmtDistance, fmtSpeed } from './common';

export interface InterceptCheck {
  ok: boolean;
  reason: string;
  range: number;
  /** Relative speed (m/s). */
  relSpeed: number;
  closing: number;
  /** Delta-v the missile needs, with margin (m/s). */
  need: number;
}

/** Can a missile fired now plausibly reach `targetId`? Pure. */
export function missileCheck(ctx: Ctx, targetId: number): InterceptCheck {
  const me = ctx.self;
  const t = ctx.entity(targetId);
  const w = ctx.cfg.weapons;
  const base = { range: 0, relSpeed: 0, closing: 0, need: 0 };
  if (!t?.alive || t.kind !== EntityKind.Ship)
    return { ...base, ok: false, reason: 'No live target.' };
  if (t.team === me.team) return { ...base, ok: false, reason: 'That is a friendly.' };
  const rel = sub(t.pos, me.pos);
  const relV = sub(t.vel, me.vel);
  const range = len(rel);
  const relSpeed = len(relV);
  const closing = range > 0 ? -dot(rel, relV) / range : 0;
  const need = (ctx.missile.closingSpeed + relSpeed) * w.missileDvMargin;
  const out = { range, relSpeed, closing, need };
  if (range > w.missileRange) {
    return {
      ...out,
      ok: false,
      reason: `Target is ${fmtDistance(range)} out. Missiles are cleared inside ${fmtDistance(w.missileRange)}.`,
    };
  }
  if (need > ctx.missile.deltaV) {
    return {
      ...out,
      ok: false,
      reason: `Relative speed ${fmtSpeed(relSpeed)} is too high for the missile's fuel. Match velocity first.`,
    };
  }
  if (range / ctx.missile.closingSpeed > ctx.missile.lifetime) {
    return { ...out, ok: false, reason: 'The missile would expire before it arrived.' };
  }
  return { ...out, ok: true, reason: '' };
}

/** Fires one missile at `targetId` once the intercept check passes. */
export class LaunchMissile implements Maneuver {
  readonly kind = 'launch-missile';
  readonly label = 'Launch missile';

  constructor(private targetId: number) {}

  plan(ctx: Ctx): Plan {
    if (!ctx.self.alive) return infeasible('The ship is lost.');
    if (ctx.munitionsLeft('missiles') <= 0) return infeasible('No missiles left.');
    const c = missileCheck(ctx, this.targetId);
    if (!c.ok) return infeasible(c.reason);
    const eta = c.range / Math.max(1, ctx.missile.closingSpeed);
    return {
      feasible: true,
      nodes: [],
      dv: 0,
      eta,
      vars: {
        range: fmtDistance(c.range),
        relv: fmtSpeed(c.relSpeed),
        eta: `${Math.round(eta)} s`,
      },
    };
  }

  start(ctx: Ctx): void {
    if (ctx.self.target !== this.targetId) ctx.helm.setTarget(this.targetId);
  }

  execute(ctx: Ctx): Status {
    if (!ctx.helm.fireMissile()) return failed('The launcher refused. No lock or no missiles.');
    return { state: 'done', phase: 'done', progress: 1, note: 'Missile away', coast: 0 };
  }

  abort(): void {}
}

/** Mines wake for hostiles passing close to where they are laid. Looks ahead for one. */
export function mineCheck(ctx: Ctx): {
  ok: boolean;
  reason: string;
  who?: number;
  distance: number;
} {
  const me = ctx.self;
  const w = ctx.cfg.weapons;
  const reach = ctx.mine.triggerRange * w.mineRangeFraction;
  let best: { id: number; distance: number } | null = null;
  for (const e of ctx.entities) {
    if (!e.alive || e.kind !== EntityKind.Ship || e.team === me.team || e.team === 2) continue;
    const c = closestApproach(
      ctx.mu,
      { pos: me.pos, vel: me.vel },
      { pos: e.pos, vel: e.vel },
      ctx.mine.armTime,
      w.mineHorizon,
      w.mineSampleSeconds,
    );
    if (!best || c.distance < best.distance) best = { id: e.id, distance: c.distance };
  }
  if (!best) return { ok: false, reason: 'There is no hostile to catch.', distance: Infinity };
  if (best.distance > reach) {
    return {
      ok: false,
      reason: `Nearest hostile only comes within ${fmtDistance(best.distance)} of this orbit. The mine would sleep through it.`,
      who: best.id,
      distance: best.distance,
    };
  }
  return { ok: true, reason: '', who: best.id, distance: best.distance };
}

export class DropMine implements Maneuver {
  readonly kind = 'drop-mine';
  readonly label = 'Lay mine';

  plan(ctx: Ctx): Plan {
    if (!ctx.self.alive) return infeasible('The ship is lost.');
    if (ctx.munitionsLeft('mines') <= 0) return infeasible('No mines left.');
    const c = mineCheck(ctx);
    if (!c.ok) return infeasible(c.reason);
    return { feasible: true, nodes: [], dv: 0, eta: 0, vars: { range: fmtDistance(c.distance) } };
  }

  start(): void {}

  execute(ctx: Ctx): Status {
    if (!ctx.helm.dropMine()) return failed('Mine release refused.');
    return { state: 'done', phase: 'done', progress: 1, note: 'Mine laid', coast: 0 };
  }

  abort(): void {}
}
