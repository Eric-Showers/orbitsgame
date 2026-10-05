// Unrolled-orbit math: each orbit becomes a wave r(theta) over one turn of inertial angle,
// so Ap is the crest, Pe the trough, and two waves crossing means the paths share a point.
// Pure functions of orbital elements and state vectors; no sim handle in here.

import { desiredDirection, propagate, TAU, wrapTau } from '../autopilot/orbitmath';
import type { BurnNode } from '../autopilot/types';
import type { OrbitView, Vec3 } from '../sim/bridge';

/** The conic in polar form: r(theta) = p / (1 + e cos(theta - w)). */
export interface WaveOrbit {
  /** Semi-latus rectum (m). */
  p: number;
  e: number;
  /** Inertial angle of periapsis (rad). */
  w: number;
}

export const waveOf = (o: OrbitView): WaveOrbit => ({
  p: o.semiLatusRectum,
  e: o.eccentricity,
  w: o.argPeriapsis,
});

/** Planar elements from a state vector; null for a degenerate (radial or zero) state. */
export function waveFromState(mu: number, pos: Vec3, vel: Vec3): WaveOrbit | null {
  const r = Math.hypot(pos.x, pos.y);
  const h = pos.x * vel.y - pos.y * vel.x;
  if (r === 0 || Math.abs(h) < 1e-9) return null;
  const v2 = vel.x * vel.x + vel.y * vel.y;
  const rv = pos.x * vel.x + pos.y * vel.y;
  const ex = (v2 / mu - 1 / r) * pos.x - (rv / mu) * vel.x;
  const ey = (v2 / mu - 1 / r) * pos.y - (rv / mu) * vel.y;
  const e = Math.hypot(ex, ey);
  return { p: (h * h) / mu, e, w: e < 1e-9 ? Math.atan2(pos.y, pos.x) : Math.atan2(ey, ex) };
}

/** Radius at inertial angle `theta`; null where an open orbit has no point. */
export function waveRadius(o: WaveOrbit, theta: number): number | null {
  const d = 1 + o.e * Math.cos(theta - o.w);
  return d > 1e-6 ? o.p / d : null;
}

export const periapsisOf = (o: WaveOrbit): number => o.p / (1 + o.e);
/** Null on open orbits. */
export const apoapsisOf = (o: WaveOrbit): number | null => (o.e < 1 ? o.p / (1 - o.e) : null);

/**
 * Radii at `n` evenly spaced inertial angles over [0, 2pi]. Points that are undefined
 * (open orbit's far side) or beyond `rMax` are null so the line breaks there.
 */
export function sampleWave(o: WaveOrbit, n: number, rMax = Infinity): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const r = waveRadius(o, (TAU * i) / (n - 1));
    out.push(r !== null && r <= rMax ? r : null);
  }
  return out;
}

const COINCIDENT = 25;

/** Inertial angles in [0, 2pi) where two waves have the same radius (the orbits intersect). */
export function waveCrossings(a: WaveOrbit, b: WaveOrbit, n = 360): number[] {
  const diff = (t: number): number | null => {
    const ra = waveRadius(a, t);
    const rb = waveRadius(b, t);
    return ra === null || rb === null ? null : ra - rb;
  };
  // Orbits that coincide to within a few metres cross everywhere and nowhere; report none.
  let apart = 0;
  for (let i = 0; i <= n; i++) apart = Math.max(apart, Math.abs(diff((TAU * i) / n) ?? 0));
  if (apart < COINCIDENT) return [];
  const out: number[] = [];
  let prevT = 0;
  let prev = diff(0);
  for (let i = 1; i <= n; i++) {
    const t = (TAU * i) / n;
    const d = diff(t);
    if (prev !== null && d !== null && prev !== 0 && prev * d <= 0) {
      let lo = prevT;
      let hi = t;
      let dLo = prev;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        const dm = diff(mid);
        if (dm === null) break;
        if (dLo * dm <= 0) hi = mid;
        else {
          lo = mid;
          dLo = dm;
        }
      }
      const root = wrapTau((lo + hi) / 2);
      if (!out.some((x) => Math.abs(x - root) < 1e-6)) out.push(root);
    }
    prevT = t;
    prev = d;
  }
  return out.sort((x, y) => x - y);
}

/** Inertial angle of a position. */
export const phaseOf = (pos: Vec3): number => wrapTau(Math.atan2(pos.y, pos.x));

export interface ProjectedBurn {
  /** Orbit after this burn and all before it. */
  after: WaveOrbit;
  /** Where the burn happens on the wave. */
  theta: number;
  radius: number;
  label: string;
}

/**
 * Coasts the ship's state to each planned node, applies its delta-v along the node's
 * attitude, and returns the orbit after every burn. Stops at the first node whose direction
 * cannot be worked out from the orbit alone (target-relative modes, hold).
 */
export function projectBurns(
  mu: number,
  pos: Vec3,
  vel: Vec3,
  now: number,
  nodes: readonly BurnNode[],
): ProjectedBurn[] {
  const out: ProjectedBurn[] = [];
  let state = { pos, vel };
  let t = now;
  for (const node of [...nodes].sort((a, b) => a.time - b.time)) {
    const dt = Math.max(0, node.time - t);
    state = propagate(mu, state.pos, state.vel, dt);
    t += dt;
    const dir = desiredDirection(node.mode, state.pos, state.vel);
    if (!dir) break;
    const vel2 = {
      x: state.vel.x + dir.x * node.dv,
      y: state.vel.y + dir.y * node.dv,
      z: 0,
    };
    state = { pos: state.pos, vel: vel2 };
    const after = waveFromState(mu, state.pos, vel2);
    if (!after) break;
    out.push({
      after,
      theta: phaseOf(state.pos),
      radius: Math.hypot(state.pos.x, state.pos.y),
      label: node.label,
    });
  }
  return out;
}
