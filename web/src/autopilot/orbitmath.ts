// Planar two-body helpers the maneuver planners share. Pure functions of
// state vectors and orbital elements; no sim handle in here.

import { Attitude, type OrbitView, type Vec3 } from '../sim/bridge';

export const TAU = Math.PI * 2;

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
export const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 0 ? scale(a, 1 / l) : { x: 0, y: 0, z: 0 };
};

/** Smallest angle between two directions (rad). */
export function angleBetween(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  if (la === 0 || lb === 0) return 0;
  const c = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/** Planar unit direction of an orbit-relative attitude at a state; null for modes that need a target. */
export function desiredDirection(mode: Attitude, pos: Vec3, vel: Vec3): Vec3 | null {
  let d: Vec3;
  switch (mode) {
    case Attitude.Prograde:
      d = vel;
      break;
    case Attitude.Retrograde:
      d = scale(vel, -1);
      break;
    case Attitude.RadialOut:
      d = pos;
      break;
    case Attitude.RadialIn:
      d = scale(pos, -1);
      break;
    default:
      return null;
  }
  const u = unit({ x: d.x, y: d.y, z: 0 });
  return u.x === 0 && u.y === 0 ? null : u;
}

/** Wraps an angle into [0, 2pi). */
export const wrapTau = (a: number): number => ((a % TAU) + TAU) % TAU;

/** Angle of a position in the orbital plane (rad, counter-clockwise from +x). */
export const angleOf = (p: Vec3): number => Math.atan2(p.y, p.x);

const stumpffC = (z: number): number =>
  z > 1e-8
    ? (1 - Math.cos(Math.sqrt(z))) / z
    : z < -1e-8
      ? (Math.cosh(Math.sqrt(-z)) - 1) / -z
      : 0.5;
const stumpffS = (z: number): number => {
  if (z > 1e-8) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-8) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6;
};

/** Coasts a state `dt` seconds (either direction) along its Kepler orbit. */
export function propagate(mu: number, pos: Vec3, vel: Vec3, dt: number): { pos: Vec3; vel: Vec3 } {
  if (dt === 0) return { pos, vel };
  const r0 = Math.hypot(pos.x, pos.y, pos.z);
  const v0 = Math.hypot(vel.x, vel.y, vel.z);
  const vr0 = (pos.x * vel.x + pos.y * vel.y + pos.z * vel.z) / r0;
  const alpha = 2 / r0 - (v0 * v0) / mu;
  const sm = Math.sqrt(mu);
  let chi = sm * Math.abs(alpha) * dt;
  if (alpha <= 0) chi = Math.sign(dt) * 1e3;
  for (let i = 0; i < 60; i++) {
    const z = alpha * chi * chi;
    const C = stumpffC(z);
    const S = stumpffS(z);
    const F =
      ((r0 * vr0) / sm) * chi * chi * C + (1 - alpha * r0) * chi ** 3 * S + r0 * chi - sm * dt;
    const dF = ((r0 * vr0) / sm) * chi * (1 - z * S) + (1 - alpha * r0) * chi * chi * C + r0;
    const step = F / dF;
    chi -= step;
    if (Math.abs(step) < 1e-9 * Math.max(1, Math.abs(chi))) break;
  }
  const z = alpha * chi * chi;
  const C = stumpffC(z);
  const S = stumpffS(z);
  const f = 1 - (chi * chi * C) / r0;
  const g = dt - (chi ** 3 * S) / sm;
  const p = add(scale(pos, f), scale(vel, g));
  const rn = Math.hypot(p.x, p.y, p.z);
  const fdot = (sm / (rn * r0)) * (z * S - 1) * chi;
  const gdot = 1 - (chi * chi * C) / rn;
  return { pos: p, vel: add(scale(pos, fdot), scale(vel, gdot)) };
}

/** Seconds until the orbit next reaches true anomaly `target` (0 = now only if exactly there). */
export function timeToTrueAnomaly(o: OrbitView, target: number): number {
  const e = o.eccentricity;
  const mean = (nu: number): number => {
    const E =
      2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    return E - e * Math.sin(E);
  };
  const dM = wrapTau(mean(target) - mean(o.trueAnomaly));
  return (dM / TAU) * o.period;
}

export type Apsis = 'periapsis' | 'apoapsis';

export function timeToApsis(o: OrbitView, which: Apsis): number {
  return timeToTrueAnomaly(o, which === 'periapsis' ? 0 : Math.PI);
}

/** Speed on an ellipse with this radius as one apsis and `other` as the opposite apsis. */
export function apsisSpeed(mu: number, r: number, other: number): number {
  return Math.sqrt(mu * (2 / r - 2 / (r + other)));
}

/** Period of the orbit with semi-major axis `a`. */
export const periodOf = (mu: number, a: number): number => TAU * Math.sqrt((a * a * a) / mu);

/** Semi-major axis of the orbit with period `t`. */
export const semiMajorFor = (mu: number, t: number): number => Math.cbrt(mu * (t / TAU) ** 2);

/** Smallest separation of two coasting bodies over `horizon` seconds, sampled every `step`. */
export function closestApproach(
  mu: number,
  a: { pos: Vec3; vel: Vec3 },
  b: { pos: Vec3; vel: Vec3 },
  from: number,
  horizon: number,
  step: number,
): { time: number; distance: number } {
  let best = { time: from, distance: Infinity };
  for (let t = from; t <= horizon; t += step) {
    const pa = propagate(mu, a.pos, a.vel, t).pos;
    const pb = propagate(mu, b.pos, b.vel, t).pos;
    const d = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
    if (d < best.distance) best = { time: t, distance: d };
  }
  return best;
}
