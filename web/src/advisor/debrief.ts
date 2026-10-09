// After a burn: what it did and what follows from it. Reads the new orbit and
// looks ahead along the coast for the next close approach to the designated
// target. Pure functions of the snapshot; the AI describes, the commander flies.

import { propagate, timeToTrueAnomaly as timeToTrueAnomalyOf } from '../autopilot/orbitmath';
import { len, sub, type Vec3 } from '../sim/bridge';
import { fmtDistance, fmtSpan, fmtSpeed } from '../ui/format';
import type { DebriefSpec, Thresholds } from './config';
import { entityName, isHostile, mu, type Cue, type VesselSnapshot } from './triggers';

export interface Approach {
  /** Sim seconds from now. */
  time: number;
  distance: number;
  relSpeed: number;
}

interface Body {
  pos: Vec3;
  vel: Vec3;
}

const separation = (g: number, a: Body, b: Body, t: number): number => {
  const pa = propagate(g, a.pos, a.vel, t).pos;
  const pb = propagate(g, b.pos, b.vel, t).pos;
  return len(sub(pa, pb));
};

/**
 * Coasting approaches between two bodies over `horizon` seconds: the first
 * local minimum of their separation, and the closest of all. Sampled, then
 * each minimum is refined by ternary search.
 */
export function coastApproaches(
  g: number,
  a: Body,
  b: Body,
  horizon: number,
  samples = 720,
): { first: Approach | null; best: Approach | null } {
  const step = horizon / samples;
  const d: number[] = [];
  for (let i = 0; i <= samples; i++) d.push(separation(g, a, b, i * step));
  const found: Approach[] = [];
  for (let i = 1; i < samples; i++) {
    if (!(d[i] <= d[i - 1] && d[i] < d[i + 1])) continue;
    let lo = (i - 1) * step;
    let hi = (i + 1) * step;
    for (let k = 0; k < 40; k++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      if (separation(g, a, b, m1) < separation(g, a, b, m2)) hi = m2;
      else lo = m1;
    }
    const time = (lo + hi) / 2;
    const va = propagate(g, a.pos, a.vel, time).vel;
    const vb = propagate(g, b.pos, b.vel, time).vel;
    found.push({ time, distance: separation(g, a, b, time), relSpeed: len(sub(va, vb)) });
  }
  if (found.length === 0) return { first: null, best: null };
  const best = found.reduce((x, y) => (y.distance < x.distance ? y : x));
  return { first: found[0], best };
}

const FRACTIONS = ['', ' and a quarter', ' and a half', ' and three quarters'];
const WHOLE = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** A wait as a count of orbits, in words a speech engine reads cleanly: "two and a half orbits". */
export function fmtOrbits(seconds: number, period: number): string {
  if (!(period > 0) || !Number.isFinite(period)) return fmtSpan(seconds);
  const quarters = Math.round((seconds / period) * 4);
  if (quarters < 2) return 'less than half an orbit';
  const whole = Math.floor(quarters / 4);
  const frac = quarters % 4;
  if (whole === 0)
    return frac === 2
      ? 'half an orbit'
      : frac === 1
        ? 'a quarter of an orbit'
        : 'three quarters of an orbit';
  const n = whole < WHOLE.length ? WHOLE[whole] : String(whole);
  return `${n}${FRACTIONS[frac]} ${whole === 1 && frac === 0 ? 'orbit' : 'orbits'}`;
}

/**
 * Lines that describe a finished burn: the new orbit, the next apsis, and the
 * next close approach to the target with what it means for the commander.
 */
export function evaluateDebrief(
  snap: VesselSnapshot,
  d: DebriefSpec,
  t: Thresholds,
  circularEccentricity: number,
): Cue[] {
  const { self, orbit, planetRadius: R } = snap;
  if (!self.alive || !orbit || orbit.periapsis - R < 0) return [];
  const out: Cue[] = [];
  if (orbit.eccentricity >= 1) return []; // an escape orbit has its own status line
  const orbitVars = {
    pe: fmtDistance(orbit.periapsis - R),
    ap: fmtDistance(orbit.apoapsis - R),
    period: fmtSpan(orbit.period),
  };
  out.push({
    id: orbit.eccentricity < circularEccentricity ? 'debrief.orbit_circular' : 'debrief.orbit',
    vars: { ...orbitVars, alt: fmtDistance(orbit.periapsis - R) },
  });

  if (orbit.eccentricity >= circularEccentricity) {
    const toPe = timeToTrueAnomalyOf(orbit, 0);
    const toAp = timeToTrueAnomalyOf(orbit, Math.PI);
    const peNext = toPe < toAp;
    out.push({
      id: peNext ? 'debrief.next_periapsis' : 'debrief.next_apoapsis',
      vars: { when: fmtSpan(peNext ? toPe : toAp) },
    });
  }

  const target = snap.entities.find((e) => e.id === self.target && e.alive);
  if (!target) return out;
  const g = mu(self, orbit);
  const horizon = Math.min(d.orbitsAhead * orbit.period, d.maxHorizon);
  const { first, best } = coastApproaches(g, self, target, horizon);
  const name = entityName(target);
  if (!first || !best) {
    out.push({ id: 'debrief.approach.none', vars: { target: name } });
    return out;
  }
  const hostile = isHostile(self, target, t);
  const kind =
    first.distance <= d.rendezvousRange
      ? 'close'
      : first.distance <= t.missileEnvelope
        ? hostile
          ? 'weapons'
          : 'near'
        : 'wide';
  const vars = (a: Approach): Record<string, string> => ({
    target: name,
    miss: fmtDistance(a.distance),
    orbits: fmtOrbits(a.time, orbit.period),
    span: fmtSpan(a.time),
    relv: fmtSpeed(a.relSpeed),
  });
  out.push({ id: `debrief.approach.${kind}`, vars: vars(first) });
  if (kind !== 'wide') {
    out.push({
      id: first.relSpeed <= d.gentleRelSpeed ? 'debrief.relspeed.gentle' : 'debrief.relspeed.fast',
      vars: vars(first),
    });
  }
  if (best.time !== first.time && best.distance < 0.5 * first.distance) {
    out.push({ id: 'debrief.approach.better', vars: vars(best) });
  }
  return out;
}
