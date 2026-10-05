// Typed views over the flat arrays the WASM `Game` returns. Field order must
// match `crates/orbit-wasm/src/lib.rs`.

import { CELESTIAL } from '../render/celestial';

export const ENTITY_STRIDE = 25;

export enum Attitude {
  Hold = 0,
  Prograde = 1,
  Retrograde = 2,
  RadialOut = 3,
  RadialIn = 4,
  Normal = 5,
  AntiNormal = 6,
  Target = 7,
  AntiTarget = 8,
  TargetPrograde = 9,
  TargetRetrograde = 10,
}

export enum EntityKind {
  Ship = 0,
  Missile = 1,
  Mine = 2,
}

/** Mirrors the class indices of `SHIP_CLASSES` in `orbit-sim`. */
export const SHIP_CLASS_NAMES = ['Corvette', 'Drone', 'Gunboat', 'Minelayer', 'Beacon'];
export const CORVETTE = 0;
export const DRONE = 1;
export const BEACON = 4;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface EntityView {
  id: number;
  kind: EntityKind;
  team: number;
  shipClass: number;
  alive: boolean;
  pos: Vec3;
  vel: Vec3;
  heading: Vec3;
  throttle: number;
  /** Stored drive heat (MJ); 0 for munitions. */
  heat: number;
  /** Thermal limit of the drive (MJ); 0 for munitions. */
  heatCapacity: number;
  /** Fraction of full thrust the drive can deliver at the current heat, 0..1. */
  outputCap: number;
  mode: Attitude;
  target: number | null;
  hp: number;
  mass: number;
  maxAccel: number;
  /** Motor delta-v remaining for munitions (m/s); ships have an unlimited drive and report 0. */
  deltaV: number;
  /** Battery state of charge, 0..1; 0 for ships and munitions without a battery. */
  charge: number;
}

export function decodeEntities(flat: Float64Array): EntityView[] {
  const out: EntityView[] = [];
  for (let o = 0; o + ENTITY_STRIDE <= flat.length; o += ENTITY_STRIDE) {
    const v = (i: number): number => flat[o + i];
    out.push({
      id: v(0),
      kind: v(1),
      team: v(2),
      shipClass: v(3),
      alive: v(4) === 1,
      pos: { x: v(5), y: v(6), z: v(7) },
      vel: { x: v(8), y: v(9), z: v(10) },
      heading: { x: v(11), y: v(12), z: v(13) },
      throttle: v(14),
      heat: v(15),
      heatCapacity: v(16),
      outputCap: v(17),
      mode: v(18),
      target: v(19) < 0 ? null : v(19),
      hp: v(20),
      mass: v(21),
      maxAccel: v(22),
      deltaV: v(23),
      charge: v(24),
    });
  }
  return out;
}

/** Static ship-class stats as published by `Game.class_stats`. */
export interface ClassStats {
  dryMass: number;
  thrust: number;
  /** Attitude slew rate (rad/s). */
  slewRate: number;
  hp: number;
  /** Thermal limit of the drive (MJ); 0 means no heat model. */
  heatCapacity: number;
  /** Waste heat at full output (MW). */
  heatGain: number;
  /** Radiator dissipation when cold (MW). */
  radiateBase: number;
  /** Extra dissipation at the thermal limit (MW). */
  radiateSlope: number;
  /** Load fraction above which output derates. */
  derateStart: number;
  /** Output fraction held at the thermal limit. */
  minOutput: number;
}

export function decodeClassStats(f: ArrayLike<number>): ClassStats {
  const v = (i: number): number => f[i] ?? 0;
  return {
    dryMass: v(0),
    thrust: v(1),
    slewRate: v(2),
    hp: v(3),
    heatCapacity: v(6),
    heatGain: v(7),
    radiateBase: v(8),
    radiateSlope: v(9),
    derateStart: f[10] ?? 1,
    minOutput: f[11] ?? 1,
  };
}

/** Output fraction the drive can deliver at `load` (heat / capacity). Mirrors the sim. */
export function outputCapAt(c: ClassStats, load: number): number {
  if (c.heatCapacity <= 0 || load <= c.derateStart) return 1;
  return 1 - ((1 - c.minOutput) * (Math.min(load, 1) - c.derateStart)) / (1 - c.derateStart);
}

export interface OrbitView {
  semiMajorAxis: number;
  eccentricity: number;
  semiLatusRectum: number;
  periapsis: number;
  apoapsis: number;
  period: number;
  argPeriapsis: number;
  trueAnomaly: number;
}

export function decodeOrbit(flat: Float64Array): OrbitView | null {
  if (flat.length < 8) return null;
  return {
    semiMajorAxis: flat[0],
    eccentricity: flat[1],
    semiLatusRectum: flat[2],
    periapsis: flat[3],
    apoapsis: flat[4],
    period: flat[5],
    argPeriapsis: flat[6],
    trueAnomaly: flat[7],
  };
}

export enum SimEventKind {
  Crash = 0,
  Overheat = 1,
  MissileLaunched = 2,
  MineDropped = 3,
  MineTriggered = 4,
  Detonation = 5,
  ShipDestroyed = 6,
  Expired = 7,
}

export interface SimEvent {
  kind: SimEventKind;
  id: number;
  pos: Vec3;
}

export function decodeEvents(flat: Float64Array): SimEvent[] {
  const out: SimEvent[] = [];
  for (let o = 0; o + 5 <= flat.length; o += 5) {
    out.push({
      kind: flat[o],
      id: flat[o + 1],
      pos: { x: flat[o + 2], y: flat[o + 3], z: flat[o + 4] },
    });
  }
  return out;
}

export const len = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Points the sim's sun at the sun in `celestial.json`, so eclipses match the render. */
export function withSunFromConfig<G extends { set_sun_angle_deg(deg: number): void }>(game: G): G {
  game.set_sun_angle_deg(CELESTIAL.sun.angleDeg);
  return game;
}
