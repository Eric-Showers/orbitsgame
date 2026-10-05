import {
  EntityKind,
  len,
  sub,
  type ClassStats,
  type EntityView,
  type OrbitView,
  type Vec3,
} from '../sim/bridge';
import { scale, unit } from '../autopilot/orbitmath';

/** A munition that has us locked, as the pilot's sensors see it. */
export interface Threat {
  id: number;
  kind: EntityKind;
  range: number;
  /** Closing speed along the line of sight (m/s); negative when opening. */
  closing: number;
  /** Seconds to intercept at the present closing speed; Infinity when opening. */
  tgo: number;
  /** Unit vector of the threat's velocity relative to us. */
  approach: Vec3;
  /** Main-motor delta-v the munition has left (m/s). */
  deltaV: number;
  /** Predicted miss distance if neither side steers (m). */
  miss: number;
  blastRadius: number;
}

/** Everything one decision reads. Built fresh each tick from sim state; no sim handle in here. */
export interface Perception {
  time: number;
  planetRadius: number;
  me: EntityView;
  stats: ClassStats;
  orbit: OrbitView | null;
  /** The ship this pilot hunts, if alive. */
  foe: EntityView | undefined;
  foeRange: number;
  /** Munitions locked on us, soonest intercept first. */
  threats: Threat[];
  /** Drive heat as a fraction of the thermal limit (0 when the ship has no heat model). */
  load: number;
  peAlt: number;
  apAlt: number;
  /** Range the pilot wants to hold from the foe (m). */
  standoff: number;
}

export interface PerceiveInput {
  time: number;
  planetRadius: number;
  me: EntityView;
  stats: ClassStats;
  orbit: OrbitView | null;
  entities: readonly EntityView[];
  foe: EntityView | undefined;
  standoff: number;
  senseRange: number;
  /** Blast radius by munition kind (m). */
  blast: Partial<Record<EntityKind, number>>;
}

const HUNTERS = new Set([EntityKind.Missile, EntityKind.Mine, EntityKind.Kv]);

export function perceive(i: PerceiveInput): Perception {
  const { me } = i;
  const threats: Threat[] = [];
  for (const e of i.entities) {
    if (!e.alive || !HUNTERS.has(e.kind) || e.team === me.team || e.target !== me.id) continue;
    const r = sub(e.pos, me.pos);
    const range = len(r);
    if (range > i.senseRange) continue;
    const v = sub(e.vel, me.vel);
    const speed = len(v);
    const closing = range > 0 ? -(r.x * v.x + r.y * v.y + r.z * v.z) / range : 0;
    const tgo = closing > 0 ? range / closing : Infinity;
    // Distance of the straight-line relative path from us, at closest approach.
    const along = speed > 0 ? -(r.x * v.x + r.y * v.y + r.z * v.z) / speed : 0;
    const miss = speed > 0 ? len(sub(r, scale(unit(v), -along))) : range;
    threats.push({
      id: e.id,
      kind: e.kind,
      range,
      closing,
      tgo,
      approach: unit(v),
      deltaV: e.deltaV,
      miss,
      blastRadius: i.blast[e.kind] ?? 40,
    });
  }
  threats.sort((a, b) => a.tgo - b.tgo);
  const R = i.planetRadius;
  const foeRange = i.foe ? len(sub(i.foe.pos, me.pos)) : Infinity;
  return {
    time: i.time,
    planetRadius: R,
    me,
    stats: i.stats,
    orbit: i.orbit,
    foe: i.foe,
    foeRange,
    threats,
    load: me.heatCapacity > 0 ? me.heat / me.heatCapacity : 0,
    peAlt: i.orbit ? i.orbit.periapsis - R : len(me.pos) - R,
    apAlt: i.orbit && i.orbit.eccentricity < 1 ? i.orbit.apoapsis - R : Infinity,
    standoff: i.standoff,
  };
}
