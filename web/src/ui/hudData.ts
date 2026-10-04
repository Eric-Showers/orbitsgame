import { closestApproach, timeToApsis } from '../autopilot/orbitmath';
import { dot, EntityKind, len, sub, type EntityView, type OrbitView } from '../sim/bridge';
import type { FlightSession } from '../sim/session';

/**
 * Stats the new ship and weapon physics will publish on entities. Every field is optional here so the HUD
 * shows today's closest stand-in until the sim exposes the real number (see docs/hud-design.md).
 */
export interface FutureStats {
  /** Thermal load as a fraction of the limit, 0..1. */
  heat?: number;
  /** Heat change in fractions of the limit per second (positive = warming). */
  heatRate?: number;
  /** Remaining RCS delta-v of a missile (m/s). */
  rcsDeltaV?: number;
  /** Mine battery charge, 0..1. */
  battery?: number;
  /** Mine battery change per second (positive = charging). */
  batteryRate?: number;
}

const future = (e: EntityView): FutureStats => e as EntityView & FutureStats;

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
  /** 0..1; `estimated` is true while the sim publishes no heat and throttle stands in. */
  heat: number;
  heatRate: number | null;
  estimated: boolean;
  missiles: number;
  mines: number;
}

export function resourceStats(s: FlightSession, me: EntityView): ResourceStats {
  const f = future(me);
  const { missiles, mines } = s.munitionsLeft(me.id);
  return {
    heat: f.heat ?? me.throttle,
    heatRate: f.heatRate ?? null,
    estimated: f.heat === undefined,
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
    const base = e.fuelMax > 0 ? e.fuel / e.fuelMax : 0;
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
