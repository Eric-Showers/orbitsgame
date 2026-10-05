import { Attitude, type Vec3 } from '../sim/bridge';
import { angleBetween, unit, scale } from '../autopilot/orbitmath';
import { modeDirection } from '../autopilot/maneuvers/common';
import type { AdversaryConfig } from './config';
import type { Perception, Threat } from './perception';
import { orbitalAdvantage } from './scoring';

/** 0 passive, 1 reacts, 2 anticipates, 3 pursues and counters. */
export type Tier = 0 | 1 | 2 | 3;

export type Intent = 'idle' | 'prepare' | 'counter' | 'recover' | 'pursue' | 'cool' | 'safety';

/** What the pilot does this tick, in the same terms as the helm: heading mode and throttle. */
export interface Command {
  /** Attitude mode to hold; null leaves the helm as it is. */
  attitude: Attitude | null;
  throttle: number;
  intent: Intent;
  /** Short label for a future HUD callout, e.g. "breaking radial out". */
  note: string;
}

/** What the pilot carries between ticks. */
export interface Memory {
  /** Patrol orbit's semi-major axis, latched on the first tick. */
  home: number | null;
  /** Heading mode of the counter burn in progress or being prepared. */
  mode: Attitude | null;
  /** Mode of the previous counter burn, so the next one goes the other way. */
  lastMode: Attitude | null;
  /** Sim time the counter burn ends; -Infinity until ignition. */
  burnUntil: number;
  lastThreatAt: number;
  /** Tier 1 reacts once per threat episode. */
  reacted: boolean;
  /** Drive was run hot; coast until it cools below `heat.resumeBelow`. */
  hot: boolean;
  recovering: boolean;
  /** Pursuit burn heading, held with hysteresis. */
  pursueMode: Attitude | null;
}

export const newMemory = (): Memory => ({
  home: null,
  mode: null,
  lastMode: null,
  burnUntil: -Infinity,
  lastThreatAt: -Infinity,
  reacted: false,
  hot: false,
  recovering: false,
  pursueMode: null,
});

const coast = (note = 'coasting'): Command => ({
  attitude: null,
  throttle: 0,
  intent: 'idle',
  note,
});

const COUNTER_MODES = [
  Attitude.Prograde,
  Attitude.Retrograde,
  Attitude.RadialOut,
  Attitude.RadialIn,
];
const OPPOSITE: Partial<Record<Attitude, Attitude>> = {
  [Attitude.Prograde]: Attitude.Retrograde,
  [Attitude.Retrograde]: Attitude.Prograde,
  [Attitude.RadialOut]: Attitude.RadialIn,
  [Attitude.RadialIn]: Attitude.RadialOut,
};

const cross2 = (a: Vec3, b: Vec3): number => a.x * b.y - a.y * b.x;
const dot2 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y;

const dirOf = (p: Perception, mode: Attitude): Vec3 | null => modeDirection(p.me, p.foe, mode);

function alignedWith(p: Perception, mode: Attitude, tol: number): boolean {
  const d = dirOf(p, mode);
  return d !== null && angleBetween(p.me.heading, d) <= tol;
}

/** True when the drive may burn: always when cool, and past the calm ceiling only in an emergency. */
function thermalOk(p: Perception, mem: Memory, cfg: AdversaryConfig, emergency: boolean): boolean {
  if (p.me.heatCapacity <= 0) return true;
  if (p.load <= cfg.heat.resumeBelow) mem.hot = false;
  if (p.load >= cfg.heat.calmCeiling) mem.hot = true;
  if (emergency) return p.load < cfg.heat.emergencyCeiling;
  return !mem.hot;
}

/** Whether a munition can still steer onto us; a dry one is ignored when it will miss wide. */
function dangerous(t: Threat, cfg: AdversaryConfig): boolean {
  if (t.closing <= 0) return false;
  const spent = t.deltaV < cfg.anticipate.spentDeltaV;
  return !spent || t.miss <= t.blastRadius * cfg.anticipate.missMargin;
}

/**
 * Picks the burn heading that best breaks the approach of `threats`: the one
 * pointing most across their lines of sight, discounted when it would push the
 * orbit toward the planet or out of bounds, plus a nudge to alternate sides and
 * the (reserved) orbital-advantage term.
 */
export function chooseCounter(
  p: Perception,
  threats: readonly Threat[],
  mem: Pick<Memory, 'lastMode'>,
  cfg: AdversaryConfig,
): Attitude {
  const w = cfg.score;
  const low = p.peAlt < cfg.safety.minAltitude + cfg.safety.altitudeMargin;
  const high = p.apAlt > cfg.safety.maxAltitude;
  let best = COUNTER_MODES[0];
  let bestScore = -Infinity;
  for (const mode of COUNTER_MODES) {
    const d = dirOf(p, mode);
    if (!d) continue;
    let escape = 0;
    for (const t of threats) escape += Math.abs(cross2(d, t.approach)) / Math.max(t.tgo, 1);
    let score = w.escape * escape;
    if (mem.lastMode !== null && OPPOSITE[mem.lastMode] === mode) score += w.alternate;
    const lowers = mode === Attitude.Retrograde || mode === Attitude.RadialIn;
    const raises = mode === Attitude.Prograde || mode === Attitude.RadialOut;
    if ((low && lowers) || (high && raises)) score -= w.unsafe;
    score += w.advantage * orbitalAdvantage(p, mode);
    if (score > bestScore) {
      bestScore = score;
      best = mode;
    }
  }
  return best;
}

/** Tier 1: one fixed radial burn per threat episode once a munition is inside warn range. */
function reactive(p: Perception, mem: Memory, cfg: AdversaryConfig): Command {
  const c = cfg.reactive;
  if (mem.burnUntil > -Infinity && p.time >= mem.burnUntil) {
    mem.burnUntil = -Infinity;
    mem.mode = null;
  }
  const inbound = p.threats.some((t) => t.closing > 0 && t.range <= c.warnRange);
  if (inbound) mem.lastThreatAt = p.time;
  else if (p.time - mem.lastThreatAt >= c.clearSeconds) mem.reacted = false;

  if (mem.mode === null && inbound && !mem.reacted && thermalOk(p, mem, cfg, true)) {
    const roomBelow = p.peAlt > cfg.safety.minAltitude + cfg.safety.altitudeMargin;
    const out = mem.lastMode !== Attitude.RadialOut || !roomBelow;
    mem.mode = out ? Attitude.RadialOut : Attitude.RadialIn;
    mem.lastMode = mem.mode;
    mem.burnUntil = p.time + c.burnSeconds;
    mem.reacted = true;
  }
  if (mem.mode === null) return coast();
  return {
    attitude: mem.mode,
    throttle: alignedWith(p, mem.mode, 0.5) ? c.throttle : 0,
    intent: 'counter',
    note: mem.mode === Attitude.RadialOut ? 'breaking high' : 'breaking low',
  };
}

/** Tier 2: slews early, ignites on predicted time to intercept, alternates sides, manages heat. */
function anticipate(p: Perception, mem: Memory, cfg: AdversaryConfig): Command | null {
  const a = cfg.anticipate;
  const live = p.threats.filter((t) => dangerous(t, cfg));
  if (live.length === 0) {
    if (mem.mode !== null && p.time >= mem.burnUntil) mem.mode = null;
    if (mem.mode === null) return null;
  } else {
    mem.lastThreatAt = p.time;
  }
  if (mem.mode !== null && mem.burnUntil > -Infinity && p.time >= mem.burnUntil) {
    mem.lastMode = mem.mode;
    mem.mode = null;
    mem.burnUntil = -Infinity;
  }
  const soon = live[0]?.tgo ?? Infinity;
  if (soon > a.commitSeconds + a.prepareSeconds && mem.burnUntil === -Infinity) {
    mem.mode = null;
    return null;
  }
  if (mem.mode === null) mem.mode = chooseCounter(p, live, mem, cfg);
  const emergency = soon <= a.emergencySeconds;
  const burning = mem.burnUntil > -Infinity;
  const ready = soon <= a.commitSeconds || burning;
  const ok = ready && thermalOk(p, mem, cfg, emergency || burning);
  if (!ok) {
    return {
      attitude: mem.mode,
      throttle: 0,
      intent: ready ? 'cool' : 'prepare',
      note: ready ? 'drive hot, holding' : 'coming round',
    };
  }
  const aligned = alignedWith(p, mem.mode, cfg.pursuit.alignTolerance * 2);
  if (aligned && !burning) mem.burnUntil = p.time + a.burnSeconds;
  return {
    attitude: mem.mode,
    throttle: aligned ? 1 : 0,
    intent: 'counter',
    note: aligned ? 'burning to break lock' : 'coming round',
  };
}

/** Tier 2 and up: once the sky is clear, burn back to the patrol orbit's energy. */
function recover(p: Perception, mem: Memory, cfg: AdversaryConfig): Command | null {
  if (!p.orbit) return null;
  if (mem.home === null) mem.home = p.orbit.semiMajorAxis;
  if (p.time - mem.lastThreatAt < cfg.anticipate.clearSeconds) return null;
  const err = p.orbit.semiMajorAxis - mem.home;
  const tol = cfg.recover.smaTolerance;
  if (Math.abs(err) > tol) mem.recovering = true;
  if (Math.abs(err) < tol * 0.3) mem.recovering = false;
  if (!mem.recovering || !thermalOk(p, mem, cfg, false)) return null;
  const mode = err > 0 ? Attitude.Retrograde : Attitude.Prograde;
  return {
    attitude: mode,
    throttle: alignedWith(p, mode, cfg.pursuit.alignTolerance * 2) ? cfg.recover.throttle : 0,
    intent: 'recover',
    note: 'returning to patrol orbit',
  };
}

const PURSUIT_MODES = [
  Attitude.Target,
  Attitude.AntiTarget,
  Attitude.TargetPrograde,
  Attitude.TargetRetrograde,
  Attitude.Prograde,
  Attitude.Retrograde,
  Attitude.RadialOut,
  Attitude.RadialIn,
];

/** Tier 3: guide the relative velocity to a closing speed that settles at the standoff range. */
function pursue(p: Perception, mem: Memory, cfg: AdversaryConfig): Command | null {
  const c = cfg.pursuit;
  const foe = p.foe;
  if (!foe || p.me.maxAccel <= 0) return null;
  const toFoe = unit({ x: foe.pos.x - p.me.pos.x, y: foe.pos.y - p.me.pos.y, z: 0 });
  const along = Math.max(
    -c.maxApproachSpeed,
    Math.min(c.maxApproachSpeed, c.approachGain * (p.foeRange - p.standoff)),
  );
  const vMe: Vec3 = {
    x: p.me.vel.x - foe.vel.x,
    y: p.me.vel.y - foe.vel.y,
    z: 0,
  };
  const want = scale(toFoe, along);
  const err = { x: want.x - vMe.x, y: want.y - vMe.y, z: 0 };
  const mag = Math.hypot(err.x, err.y);

  const low = p.peAlt < cfg.safety.minAltitude + cfg.safety.altitudeMargin;
  if (low && p.orbit) {
    return {
      attitude: Attitude.Prograde,
      throttle: alignedWith(p, Attitude.Prograde, c.alignTolerance * 2) ? 1 : 0,
      intent: 'safety',
      note: 'raising periapsis',
    };
  }

  if (p.me.heatCapacity > 0) {
    if (p.load >= c.pursueCeiling) mem.hot = true;
    if (p.load <= cfg.heat.resumeBelow) mem.hot = false;
    if (mem.hot) return { ...coast('venting heat'), intent: 'cool' };
  }
  if (mag < c.deadband) return coast('on station');

  const e = scale(err, 1 / mag);
  const score = (mode: Attitude): number => {
    const d = dirOf(p, mode);
    return d ? dot2(d, e) + cfg.score.advantage * orbitalAdvantage(p, mode) : -Infinity;
  };
  let best = PURSUIT_MODES[0];
  let bestScore = -Infinity;
  for (const m of PURSUIT_MODES) {
    const s = score(m);
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }
  const held = mem.pursueMode;
  const mode = held !== null && score(held) >= bestScore - c.switchMargin ? held : best;
  mem.pursueMode = mode;
  const aligned = alignedWith(p, mode, c.alignTolerance) && score(mode) > 0.5;
  const accel = p.me.maxAccel * p.me.outputCap;
  const throttle = aligned ? Math.min(1, mag / (accel * c.taperSeconds)) : 0;
  return { attitude: mode, throttle, intent: 'pursue', note: 'closing on contact' };
}

/**
 * The adversary's decision for one tick. Pure apart from `mem`: the same
 * perception and memory always give the same command.
 *
 * Tier 0 holds its orbit. Tier 1 flies one fixed radial counter-burn per
 * threat. Tier 2 times a chosen counter from predicted intercept, manages
 * heat, and returns to its patrol orbit. Tier 3 also hunts its quarry,
 * counter-maneuvering whenever a threat is close enough to matter.
 */
export function decide(tier: Tier, p: Perception, mem: Memory, cfg: AdversaryConfig): Command {
  if (!p.me.alive || tier === 0) return coast('holding orbit');
  if (tier === 1) return reactive(p, mem, cfg);
  const counter = anticipate(p, mem, cfg);
  if (counter) return counter;
  if (tier === 3) {
    const chase = pursue(p, mem, cfg);
    if (chase) return chase;
  }
  return recover(p, mem, cfg) ?? coast();
}
