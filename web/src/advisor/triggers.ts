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
import type { LullSpec, Thresholds } from './config';
import type { ObjectiveView } from './objectives';

/** Read-only view of the sim as one vessel's AI sees it. */
export interface VesselSnapshot {
  simTime: number;
  planetRadius: number;
  self: EntityView;
  orbit: OrbitView | null;
  entities: readonly EntityView[];
  /** Sim events since the previous snapshot. */
  events: readonly SimEvent[];
  /** Time warp in effect (1 when unknown). */
  warp?: number;
  /** The mission objective being worked on, if flying a mission. */
  objective?: ObjectiveView | null;
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

  // Drive heat near the limit. Lower readings are status, reported in a lull.
  const load = heatLoad(self);
  out.push({
    id: 'heat.limit',
    on: load >= t.heatLimitFraction,
    hold: load >= t.heatLimitFraction - t.heatHysteresis,
    vars: { pct: fmtPercent(load), cap: fmtPercent(self.outputCap) },
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
  memory: { hullMax: number },
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
  }
  return out;
}

function heatLoad(e: EntityView): number {
  return e.heatCapacity > 0 ? e.heat / e.heatCapacity : 0;
}

/** Readings last spoken in a status report, so the next one only says what changed. */
export interface Reported {
  pe: number;
  ap: number;
  heat: number;
  target: number | null;
  targetRange: number;
}

export function currentReadings(snap: VesselSnapshot): Reported {
  const { self, orbit } = snap;
  const target = snap.entities.find((e) => e.id === self.target && e.alive);
  return {
    pe: orbit?.periapsis ?? NaN,
    ap: orbit?.apoapsis ?? NaN,
    heat: heatLoad(self),
    target: target?.id ?? null,
    targetRange: target ? len(sub(target.pos, self.pos)) : NaN,
  };
}

/**
 * Status lines for a lull: whatever changed since the last report. Returns
 * the cues and the readings they cover; readings nobody needs to hear about
 * (e.g. an impact orbit, which is an alarm) are absorbed without a line.
 */
export function evaluateStatus(
  snap: VesselSnapshot,
  last: Reported,
  l: LullSpec,
): { cues: Cue[]; reported: Reported } {
  const now = currentReadings(snap);
  const R = snap.planetRadius;
  const cues: Cue[] = [];
  const reported = { ...last };

  const moved = (a: number, b: number): boolean =>
    !Number.isFinite(b) ||
    Math.abs(a - b) > Math.max(l.orbitChangeMeters, l.orbitChangeFraction * Math.abs(b - R));
  if (snap.orbit && (moved(now.pe, last.pe) || moved(now.ap, last.ap))) {
    reported.pe = now.pe;
    reported.ap = now.ap;
    if (now.pe > R) {
      const escape = !Number.isFinite(now.ap);
      cues.push({
        id: escape ? 'status.escape' : 'status.orbit',
        vars: { pe: fmtDistance(now.pe - R), ap: fmtDistance(now.ap - R) },
      });
    }
  }

  if (now.heat >= l.heatReportFraction && Math.abs(now.heat - last.heat) >= l.heatReportStep) {
    reported.heat = now.heat;
    cues.push({ id: 'status.heat', vars: { pct: fmtPercent(now.heat) } });
  } else if (now.heat < l.heatReportFraction && last.heat >= l.heatReportFraction) {
    reported.heat = now.heat;
    cues.push({ id: 'status.heat_nominal' });
  }

  const target = snap.entities.find((e) => e.id === now.target);
  if (target && snap.self.alive) {
    const changed =
      now.target !== last.target ||
      Math.abs(now.targetRange - last.targetRange) > l.targetRangeChange * last.targetRange;
    if (changed) {
      reported.target = now.target;
      reported.targetRange = now.targetRange;
      const c = closing(snap.self, target);
      cues.push({
        id:
          Math.abs(c) < 1
            ? 'status.target_holding'
            : c > 0
              ? 'status.target'
              : 'status.target_opening',
        vars: {
          target: entityName(target),
          range: fmtDistance(now.targetRange),
          closing: fmtSpeed(Math.abs(c)),
        },
      });
    }
  } else {
    reported.target = null;
  }
  return { cues, reported };
}

/** Per-contact burn tracking for maneuver call-outs. */
export interface BurnTrack {
  dv: number;
  called: boolean;
}

/**
 * Event cues for contacts making significant burns: the designated target,
 * and hostile ships within range. Each burn is called once, after it has
 * spent `maneuverDv`. `tracks` carries burn progress between snapshots.
 */
export function evaluateManeuvers(
  snap: VesselSnapshot,
  prev: VesselSnapshot | null,
  tracks: Map<number, BurnTrack>,
  t: Thresholds,
): Cue[] {
  const { self } = snap;
  const dt = prev ? Math.max(0, snap.simTime - prev.simTime) : 0;
  const out: Cue[] = [];
  for (const e of snap.entities) {
    if (e.kind !== EntityKind.Ship || e.id === self.id || !e.alive) continue;
    const rel = sub(self.pos, e.pos);
    const range = len(rel);
    const watched = e.id === self.target || (isHostile(self, e, t) && range <= t.maneuverRange);
    if (!watched || e.throttle <= 0) {
      tracks.delete(e.id);
      continue;
    }
    const track = tracks.get(e.id) ?? { dv: 0, called: false };
    track.dv += e.throttle * e.maxAccel * dt;
    tracks.set(e.id, track);
    if (track.called || track.dv < t.maneuverDv) continue;
    track.called = true;
    const speed = len(e.vel);
    const along = speed > 0 ? dot(e.heading, e.vel) / speed : 0;
    const toward = range > 0 ? dot(e.heading, rel) / range : 0;
    const kind =
      toward > 0.7
        ? 'toward'
        : toward < -0.7
          ? 'away'
          : along > 0.7
            ? 'prograde'
            : along < -0.7
              ? 'retrograde'
              : 'turn';
    out.push({
      id: `event.maneuver.${kind}`,
      vars: { target: entityName(e), range: fmtDistance(range) },
    });
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
