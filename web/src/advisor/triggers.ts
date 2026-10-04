// What the vessel AI notices. Everything here is a pure function of sim
// snapshots: it reads state and proposes lines, and never touches controls.

import {
  dot,
  EntityKind,
  len,
  SHIP_CLASS_NAMES,
  SimEventKind,
  sub,
  type EntityView,
  type OrbitView,
  type SimEvent,
  type Vec3,
} from '../sim/bridge';
import { fmtDistance, fmtPercent, fmtSpeed } from '../ui/format';
import type { Thresholds } from './config';

/** Read-only view of the sim as one vessel's AI sees it. */
export interface VesselSnapshot {
  simTime: number;
  planetRadius: number;
  self: EntityView;
  orbit: OrbitView | null;
  entities: readonly EntityView[];
  /** Sim events since the previous snapshot. */
  events: readonly SimEvent[];
}

/**
 * A level-triggered hazard. The AI speaks when `on` first becomes true and
 * stays latched while `hold` is true (defaults to `on`), which gives each
 * warning hysteresis so it does not chatter at a threshold.
 */
export interface Condition {
  id: string;
  on: boolean;
  hold?: boolean;
  vars?: Record<string, string>;
}

/** A one-shot line: something just happened. */
export interface Cue {
  id: string;
  /** Line to use when `id` has none in the voice file. */
  fallback?: string;
  vars?: Record<string, string>;
  /** Literal text to speak instead of a voice-file line (mission coaching). */
  text?: string;
}

export function isHostile(self: EntityView, other: EntityView, t: Thresholds): boolean {
  return other.team !== self.team && !t.neutralTeams.includes(other.team);
}

export function entityName(e: EntityView): string {
  return `${SHIP_CLASS_NAMES[e.shipClass] ?? 'Contact'} ${e.id}`;
}

/** Level conditions for the current snapshot. */
export function evaluateConditions(snap: VesselSnapshot, t: Thresholds): Condition[] {
  const { self, orbit, planetRadius: R } = snap;
  if (!self.alive) return [];
  const out: Condition[] = [];

  // Drive heat: rising, then near the limit. The limit supersedes the early warning.
  const load = self.heatCapacity > 0 ? self.heat / self.heatCapacity : 0;
  const heatVars = { pct: fmtPercent(load), cap: fmtPercent(self.outputCap) };
  const limit = load >= t.heatLimitFraction;
  out.push({
    id: 'heat.limit',
    on: limit,
    hold: load >= t.heatLimitFraction - t.heatHysteresis,
    vars: heatVars,
  });
  out.push({
    id: 'heat.high',
    on: !limit && load >= t.heatHighFraction,
    hold: load >= t.heatHighFraction - t.heatHysteresis,
    vars: heatVars,
  });

  // Trajectory: impact, imminent impact, or merely a low periapsis.
  if (orbit) {
    const peAlt = orbit.periapsis - R;
    const tImpact = peAlt < 0 ? timeToRadius(orbit, R, mu(self, orbit)) : null;
    const impact = tImpact !== null;
    const imminent = impact && tImpact <= t.impactImminentSeconds;
    const tVars = { t: impact ? fmtSeconds(tImpact) : '', pe: fmtDistance(peAlt) };
    out.push({ id: 'hazard.impact', on: impact && !imminent, hold: impact, vars: tVars });
    out.push({ id: 'hazard.impact_imminent', on: imminent, vars: tVars });
    out.push({
      id: 'hazard.low_periapsis',
      on: peAlt >= 0 && peAlt < t.lowPeriapsisAlt,
      hold: peAlt >= 0 && peAlt < t.lowPeriapsisClearAlt,
      vars: tVars,
    });
  }

  // Threats: hostile munitions homing on us, and sleeping mines nearby.
  let missile: { range: number; closing: number } | null = null;
  let hunter: number | null = null;
  let mine: number | null = null;
  for (const e of snap.entities) {
    if (!e.alive || e.kind === EntityKind.Ship || !isHostile(self, e, t)) continue;
    const range = len(sub(e.pos, self.pos));
    if (e.kind === EntityKind.Missile && e.target === self.id && range <= t.missileThreatRange) {
      if (!missile || range < missile.range) missile = { range, closing: closing(self, e) };
    } else if (e.kind === EntityKind.Mine && e.target === self.id) {
      hunter = Math.min(hunter ?? Infinity, range);
    } else if (e.kind === EntityKind.Mine && e.target === null) {
      mine = Math.min(mine ?? Infinity, range);
    }
  }
  out.push({
    id: 'threat.missile',
    on: missile !== null,
    vars: missile
      ? {
          range: fmtDistance(missile.range),
          closing: fmtSpeed(missile.closing),
          t: missile.closing > 0 ? fmtSeconds(missile.range / missile.closing) : 'unknown',
        }
      : {},
  });
  out.push({
    id: 'threat.mine_active',
    on: hunter !== null,
    vars: { range: fmtDistance(hunter ?? 0) },
  });
  out.push({
    id: 'threat.mine_near',
    on: mine !== null && mine <= t.mineNearRange,
    hold: mine !== null && mine <= t.mineNearClearRange,
    vars: { range: fmtDistance(mine ?? 0) },
  });

  // Commander's designated target: advice only, never a decision.
  const target = snap.entities.find((e) => e.id === self.target && e.alive);
  if (target && isHostile(self, target, t)) {
    const range = len(sub(target.pos, self.pos));
    const relSpeed = len(sub(target.vel, self.vel));
    const vars = {
      target: entityName(target),
      range: fmtDistance(range),
      relv: fmtSpeed(relSpeed),
    };
    out.push({
      id: 'advise.target_in_range',
      on: range <= t.missileEnvelope,
      hold: range <= t.missileEnvelopeClear,
      vars,
    });
    out.push({
      id: 'advise.match_velocity',
      on: range <= t.matchVelocityRange && relSpeed >= t.matchVelocityRelSpeed,
      hold: range <= t.matchVelocityRange && relSpeed >= t.matchVelocityClearRelSpeed,
      vars,
    });
  }
  return out;
}

/** One-shot cues from sim events and changes since `prev`. */
export function evaluateCues(
  snap: VesselSnapshot,
  prev: VesselSnapshot | null,
  t: Thresholds,
  memory: { burnSeconds: number; hullMax: number },
): Cue[] {
  const { self } = snap;
  const out: Cue[] = [];
  const byId = new Map(snap.entities.map((e) => [e.id, e]));

  for (const ev of snap.events) {
    const e = byId.get(ev.id);
    switch (ev.kind) {
      case SimEventKind.Overheat:
        if (ev.id === self.id) out.push({ id: 'heat.derate' });
        break;
      case SimEventKind.ShipDestroyed:
        if (ev.id === self.id) out.push({ id: 'status.lost' });
        else if (e && isHostile(self, e, t))
          out.push({ id: 'status.splash', vars: { target: entityName(e) } });
        break;
      case SimEventKind.Expired:
        if (e?.kind === EntityKind.Missile && e.team === self.team)
          out.push({ id: 'status.missile_lost' });
        break;
      case SimEventKind.MineTriggered:
        if (e && e.team === self.team) out.push({ id: 'status.mine_hunting' });
        break;
      case SimEventKind.MissileLaunched:
        if (e && isHostile(self, e, t)) {
          out.push({
            id: 'status.hostile_launch',
            vars: { range: fmtDistance(len(sub(e.pos, self.pos))) },
          });
        }
        break;
    }
  }

  if (prev && prev.self.id === self.id) {
    if (self.alive && self.hp < prev.self.hp) {
      out.push({ id: 'damage.hull', vars: { hp: fmtPercent(self.hp / memory.hullMax) } });
    }
    // Report the resulting orbit when a real burn ends.
    if (prev.self.throttle > 0 && self.throttle === 0 && self.alive && snap.orbit) {
      if (
        memory.burnSeconds >= t.burnReportMinSeconds &&
        snap.orbit.periapsis > snap.planetRadius
      ) {
        out.push({
          id: 'status.orbit',
          vars: {
            pe: fmtDistance(snap.orbit.periapsis - snap.planetRadius),
            ap: fmtDistance(snap.orbit.apoapsis - snap.planetRadius),
          },
        });
      }
    }
  }
  return out;
}

function closing(self: EntityView, other: EntityView): number {
  const rel = sub(other.pos, self.pos);
  const r = len(rel);
  return r > 0 ? -dot(rel, sub(other.vel, self.vel)) / r : 0;
}

/** Gravitational parameter recovered from h² = μp. */
function mu(self: EntityView, orbit: OrbitView): number {
  const h = cross(self.pos, self.vel);
  return (h * h) / orbit.semiLatusRectum;
}

function cross(a: Vec3, b: Vec3): number {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  return Math.hypot(x, y, z);
}

/**
 * Seconds until the orbit next descends through radius `r`, or null if it
 * never does. Kepler's equation on the conic from `orbit`.
 */
export function timeToRadius(orbit: OrbitView, r: number, gm: number): number | null {
  const { eccentricity: e, semiLatusRectum: p } = orbit;
  if (e < 1e-9) return null; // circular: constant radius
  const c = (p / r - 1) / e;
  if (c < -1 || c > 1) return null;
  const nuHit = -Math.acos(c); // descending crossing, in (-π, 0]
  const nu = orbit.trueAnomaly;
  if (e < 1) {
    const n = (2 * Math.PI) / orbit.period;
    const dM = meanAnomalyEllipse(nuHit, e) - meanAnomalyEllipse(nu, e);
    return (((dM % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / n;
  }
  if (nu >= nuHit) return null; // escaping: already past the crossing
  const a = p / (e * e - 1);
  const n = Math.sqrt(gm / (a * a * a));
  return (meanAnomalyHyperbola(nuHit, e) - meanAnomalyHyperbola(nu, e)) / n;
}

function meanAnomalyEllipse(nu: number, e: number): number {
  const E =
    2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
  return E - e * Math.sin(E);
}

function meanAnomalyHyperbola(nu: number, e: number): number {
  const F = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
  return e * Math.sinh(F) - F;
}

/** Durations as a person would say them: "45 seconds", "3 minutes 10". */
export function fmtSeconds(s: number): string {
  const t = Math.max(0, Math.round(s));
  if (t < 90) return `${t} second${t === 1 ? '' : 's'}`;
  const m = Math.floor(t / 60);
  const sec = t % 60;
  if (m >= 60) return `${(m / 60).toFixed(1)} hours`;
  return sec === 0 || m >= 10 ? `${m} minutes` : `${m} minutes ${sec}`;
}
