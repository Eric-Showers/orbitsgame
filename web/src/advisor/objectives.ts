// Mission-objective advice: what the commander could do next for the active
// objective, read off the live situation ("lower our orbit to catch up").
// Pure functions of the snapshot; the AI suggests, the commander flies.

import { len, sub, type EntityView, type Vec3 } from '../sim/bridge';
import { fmtDistance, fmtSpeed } from '../ui/format';
import type { ObjectiveSpec } from './config';
import { fmtSeconds, type Cue, type VesselSnapshot } from './triggers';

/** The active mission objective, as the AI is told about it. Ids are entity ids. */
export type ObjectiveView =
  | { kind: 'orbit'; pe: [number, number]; ap: [number, number]; hold: number; held: number }
  | { kind: 'rendezvous'; target: number; name: string; range: number; maxRelSpeed: number }
  | {
      kind: 'destroy';
      targets: { id: number; name: string }[];
      by: 'missile' | 'mine' | 'any';
    }
  | { kind: 'mineZone'; altitude: [number, number]; left: number }
  | { kind: 'survive'; remaining: number };

/** Shape of a two-body orbit from a state vector. */
interface Conic {
  a: number;
  e: number;
  pe: number;
  ap: number;
}

function conic(e: EntityView, gm: number): Conic {
  const r = len(e.pos);
  const v2 = e.vel.x ** 2 + e.vel.y ** 2 + e.vel.z ** 2;
  const a = 1 / (2 / r - v2 / gm);
  const h2 = crossLen(e.pos, e.vel) ** 2;
  const ecc = Math.sqrt(Math.max(0, 1 - h2 / (gm * a)));
  return { a, e: ecc, pe: a * (1 - ecc), ap: ecc < 1 ? a * (1 + ecc) : Infinity };
}

function crossLen(a: Vec3, b: Vec3): number {
  return Math.hypot(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

/** Angle (rad) from us to `other` around the planet, positive when it is ahead in our direction of travel. */
function leadAngle(self: EntityView, other: EntityView): number {
  const spin = Math.sign(self.pos.x * self.vel.y - self.pos.y * self.vel.x) || 1;
  const cross = self.pos.x * other.pos.y - self.pos.y * other.pos.x;
  const dot = self.pos.x * other.pos.x + self.pos.y * other.pos.y;
  return Math.atan2(spin * cross, dot);
}

/**
 * The advice line for the active objective, or null when there is nothing
 * useful to say. Line ids are `obj.*` in `voice.json`.
 */
export function objectiveAdvice(
  snap: VesselSnapshot,
  obj: ObjectiveView,
  o: ObjectiveSpec,
): Cue | null {
  const { self, orbit, planetRadius: R } = snap;
  if (!self.alive || !orbit) return null;
  const gm = crossLen(self.pos, self.vel) ** 2 / orbit.semiLatusRectum;
  const alt = (x: number): string => fmtDistance(x - R);
  const band = ([lo, hi]: [number, number]): string => `${fmtDistance(lo)} to ${fmtDistance(hi)}`;

  switch (obj.kind) {
    case 'orbit': {
      const pe = orbit.periapsis - R;
      const ap = orbit.apoapsis - R;
      const inPe = pe >= obj.pe[0] && pe <= obj.pe[1];
      const inAp = ap >= obj.ap[0] && ap <= obj.ap[1];
      const vars = { alt: fmtDistance((obj.ap[0] + obj.ap[1]) / 2) };
      if (inPe && inAp) {
        return {
          id: 'obj.orbit.hold',
          vars: { t: fmtSeconds(Math.max(1, obj.hold - obj.held)) },
        };
      }
      if (ap < obj.ap[0]) return { id: 'obj.orbit.raise', vars };
      if (pe > obj.pe[1]) return { id: 'obj.orbit.lower', vars };
      if (inAp && pe < obj.pe[0]) return { id: 'obj.orbit.circularize_up', vars };
      if (inPe && ap > obj.ap[1]) return { id: 'obj.orbit.circularize_down', vars };
      // Straddling the band: the far side went past it.
      if (pe < obj.pe[0] && ap > obj.ap[1]) return { id: 'obj.orbit.overshoot_high', vars };
      if (pe > obj.pe[1] || ap < obj.ap[0]) return null;
      return { id: 'obj.orbit.overshoot_low', vars };
    }
    case 'rendezvous': {
      const t = snap.entities.find((e) => e.id === obj.target && e.alive);
      return t ? chase(self, t, obj.name, gm, o, obj.range, obj.maxRelSpeed) : null;
    }
    case 'destroy': {
      const alive = obj.targets
        .map((t) => ({ ...t, e: snap.entities.find((e) => e.id === t.id && e.alive) }))
        .filter((t): t is { id: number; name: string; e: EntityView } => !!t.e);
      if (alive.length === 0) return null;
      if (obj.by === 'mine') return { id: 'obj.mine.wait' };
      const tracked = alive.find((t) => t.id === self.target);
      if (!tracked) {
        const nearest = alive.reduce((a, b) =>
          len(sub(a.e.pos, self.pos)) <= len(sub(b.e.pos, self.pos)) ? a : b,
        );
        return { id: 'obj.destroy.designate', vars: { target: nearest.name } };
      }
      const range = len(sub(tracked.e.pos, self.pos));
      const vars = { target: tracked.name, range: fmtDistance(range) };
      if (range <= o.fireRange) return { id: 'obj.destroy.fire', vars };
      const theirs = conic(tracked.e, gm);
      const r = len(self.pos);
      if (
        theirs.e > o.crossingEccentricity &&
        theirs.pe <= r + o.phasingMargin &&
        r <= theirs.ap + o.phasingMargin
      ) {
        return { id: 'obj.destroy.crossing', vars };
      }
      return chase(self, tracked.e, tracked.name, gm, o, o.fireRange, Infinity);
    }
    case 'mineZone': {
      const pe = orbit.periapsis - R;
      const ap = orbit.apoapsis - R;
      const [lo, hi] = obj.altitude;
      const vars = {
        band: band(obj.altitude),
        pe: alt(orbit.periapsis),
        ap: alt(orbit.apoapsis),
        left: `${obj.left} mine${obj.left === 1 ? '' : 's'}`,
      };
      if (pe >= lo && ap <= hi) return { id: 'obj.mine.lay', vars };
      if (ap < lo) return { id: 'obj.mine.raise', vars };
      if (pe > hi) return { id: 'obj.mine.lower', vars };
      return { id: 'obj.mine.circularize', vars };
    }
    case 'survive':
      return { id: 'obj.survive', vars: { t: fmtSeconds(obj.remaining) } };
  }
}

/**
 * Phasing advice toward `target`: a lower orbit is faster, a higher one
 * slower. Close in, it switches to matching speed and holding position.
 */
function chase(
  self: EntityView,
  target: EntityView,
  name: string,
  gm: number,
  o: ObjectiveSpec,
  arriveRange: number,
  maxRelSpeed: number,
): Cue {
  const range = len(sub(target.pos, self.pos));
  const relSpeed = len(sub(target.vel, self.vel));
  const vars = { target: name, range: fmtDistance(range), relv: fmtSpeed(relSpeed) };
  if (range <= arriveRange) {
    return { id: relSpeed > maxRelSpeed ? 'obj.chase.match' : 'obj.chase.hold', vars };
  }
  if (range <= o.closeRange) {
    return { id: relSpeed > o.matchRelSpeed ? 'obj.chase.match' : 'obj.chase.ease', vars };
  }
  const ours = conic(self, gm).a;
  const theirs = conic(target, gm).a;
  const lead = leadAngle(self, target);
  const ahead = lead > 0;
  // Along-track gap: on different orbits the straight-line range never gets small.
  const near = Math.abs(lead) * len(self.pos) <= o.approachRange;
  if (ahead) {
    // Below it and gaining: coast, then climb back before we run past.
    if (ours < theirs - o.phasingMargin)
      return { id: near ? 'obj.chase.overtake' : 'obj.chase.gaining', vars };
    return { id: 'obj.chase.lower', vars };
  }
  // Above it and it is gaining on us: coast, then drop back to meet it.
  if (ours > theirs + o.phasingMargin)
    return { id: near ? 'obj.chase.drop_back' : 'obj.chase.waiting', vars };
  return { id: 'obj.chase.raise', vars };
}
