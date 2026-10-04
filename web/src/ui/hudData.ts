import { closestApproach, timeToApsis } from '../autopilot/orbitmath';
import {
  decodeClassStats,
  dot,
  EntityKind,
  len,
  sub,
  type ClassStats,
  type EntityView,
  type OrbitView,
} from '../sim/bridge';
import { Game } from '../wasm-pkg/orbit_wasm.js';
import type { FlightSession } from '../sim/session';

/**
 * Stats the new ship and weapon physics will publish on entities. Every field is optional here so the HUD
 * shows today's closest stand-in until the sim exposes the real number (see docs/hud-design.md).
 */
export interface FutureStats {
  /** Remaining RCS delta-v of a missile (m/s). */
  rcsDeltaV?: number;
  /** Mine battery charge, 0..1. */
  battery?: number;
  /** Mine battery change per second (positive = charging). */
  batteryRate?: number;
}

const future = (e: EntityView): FutureStats => e as EntityView & FutureStats;

const classCache = new Map<number, ClassStats>();

/** Net heat flow in fractions of the limit per second, from the class thermal tuning. */
export function heatRateOf(e: EntityView): number | null {
  if (e.heatCapacity <= 0) return null;
  let c = classCache.get(e.shipClass);
  if (!c) {
    c = decodeClassStats(Game.class_stats(e.shipClass));
    classCache.set(e.shipClass, c);
  }
  const output = Math.min(e.throttle, e.outputCap);
  const load = e.heat / e.heatCapacity;
  return (c.heatGain * output - (c.radiateBase + c.radiateSlope * load)) / e.heatCapacity;
}

export interface OrbitStats {
  /** Apsis altitudes above the surface (m); apoapsis is null on open orbits. */
  apAlt: number | null;
  peAlt: number;
  apEta: number | null;
  peEta: number;
  ecc: number;
  period: number;
  open: boolean;
}

export function orbitStats(o: OrbitView, planetRadius: number): OrbitStats {
  const open = o.eccentricity >= 1;
  return {
    apAlt: open ? null : o.apoapsis - planetRadius,
    peAlt: o.periapsis - planetRadius,
    apEta: open ? null : timeToApsis(o, 'apoapsis'),
    peEta: open ? Math.max(0, -o.trueAnomaly) : timeToApsis(o, 'periapsis'),
    ecc: o.eccentricity,
    period: o.period,
    open,
  };
}

export interface TargetStats {
  id: number;
  shipClass: number;
  team: number;
  range: number;
  /** Positive when the range is shrinking (m/s). */
  closing: number;
  relSpeed: number;
  /** Time until closest approach and the separation then; null when the range only grows. */
  tca: number | null;
  missDistance: number | null;
  /** Velocity change to match the target's velocity right now (m/s). */
  dvMatch: number;
  orbit: OrbitStats | null;
}

/** Closest approach is searched this far ahead (s), capped by the player's own period. */
const TCA_HORIZON = 3600;
const TCA_SAMPLES = 90;

export function targetStats(
  s: FlightSession,
  me: EntityView,
  target: EntityView,
  tcaCache?: TcaCache,
): TargetStats {
  const rel = sub(target.pos, me.pos);
  const relV = sub(target.vel, me.vel);
  const range = len(rel);
  const orbit = s.orbit(target.id);
  let tca: number | null = null;
  let miss: number | null = null;
  const ca = tcaCache?.get(s, me, target) ?? coastApproach(s, me, target);
  if (ca && ca.time > 0) {
    tca = ca.time;
    miss = ca.distance;
  }
  return {
    id: target.id,
    shipClass: target.shipClass,
    team: target.team,
    range,
    closing: range > 0 ? -dot(rel, relV) / range : 0,
    relSpeed: len(relV),
    tca,
    missDistance: miss,
    dvMatch: len(relV),
    orbit: orbit ? orbitStats(orbit, s.planetRadius) : null,
  };
}

function coastApproach(
  s: FlightSession,
  me: EntityView,
  target: EntityView,
): { time: number; distance: number } | null {
  const orbit = s.orbit(me.id);
  const horizon = Math.min(
    TCA_HORIZON,
    orbit && orbit.eccentricity < 1 ? orbit.period : TCA_HORIZON,
  );
  const mu = s.game.mu();
  const ca = closestApproach(mu, me, target, 0, horizon, horizon / TCA_SAMPLES);
  return Number.isFinite(ca.distance) ? ca : null;
}

/** Closest-approach search is a few hundred Kepler solves; reuse a result for a short while. */
export class TcaCache {
  private key = '';
  private at = 0;
  private value: { time: number; distance: number } | null = null;

  constructor(private maxAgeMs = 250) {}

  get(s: FlightSession, me: EntityView, target: EntityView) {
    const now = performance.now();
    const key = `${me.id}:${target.id}`;
    if (key !== this.key || now - this.at > this.maxAgeMs) {
      this.key = key;
      this.at = now;
      this.value = coastApproach(s, me, target);
    }
    return this.value;
  }
}

export interface ResourceStats {
  /** Thermal load as a fraction of the limit, 0..1. */
  heat: number;
  heatRate: number | null;
  /** Fraction of full thrust the drive can deliver at this heat, 0..1. */
  outputCap: number;
  missiles: number;
  mines: number;
}

export function resourceStats(s: FlightSession, me: EntityView): ResourceStats {
  const { missiles, mines } = s.munitionsLeft(me.id);
  return {
    heat: me.heatCapacity > 0 ? me.heat / me.heatCapacity : 0,
    heatRate: heatRateOf(me),
    outputCap: me.outputCap,
    missiles,
    mines,
  };
}

export interface MunitionStats {
  id: number;
  kind: EntityKind.Missile | EntityKind.Mine;
  team: number;
  /** Main-motor delta-v remaining (m/s) for missiles; battery (0..1) for mines. */
  mainDv: number;
  mainFraction: number;
  /** RCS delta-v remaining (m/s); null until published. */
  rcsDv: number | null;
  /** Mine battery charge per second; null until published. */
  chargeRate: number | null;
  targetId: number | null;
  range: number | null;
  closing: number | null;
  /** Seconds to impact at the current closing speed. */
  tti: number | null;
}

export function munitionStats(s: FlightSession): MunitionStats[] {
  const out: MunitionStats[] = [];
  for (const e of s.all()) {
    if (!e.alive || (e.kind !== EntityKind.Missile && e.kind !== EntityKind.Mine)) continue;
    const t = s.entity(e.target);
    let range: number | null = null;
    let closing: number | null = null;
    let tti: number | null = null;
    if (t?.alive) {
      const rel = sub(t.pos, e.pos);
      range = len(rel);
      closing = range > 0 ? -dot(rel, sub(t.vel, e.vel)) / range : 0;
      tti = closing > 0.1 ? range / closing : null;
    }
    const f = future(e);
    const base = 0;
    out.push({
      id: e.id,
      kind: e.kind,
      team: e.team,
      mainDv: e.deltaV,
      mainFraction: e.kind === EntityKind.Mine ? (f.battery ?? base) : base,
      rcsDv: f.rcsDeltaV ?? null,
      chargeRate: f.batteryRate ?? null,
      targetId: t?.alive ? t.id : null,
      range,
      closing,
      tti,
    });
  }
  return out.sort((a, b) => (a.range ?? Infinity) - (b.range ?? Infinity));
}
