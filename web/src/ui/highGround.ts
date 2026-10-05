import tuning from './highGround.json';

export type GroundSide = 'high' | 'low' | 'even';

export interface HighGround {
  /** Own radius minus the other's (m); positive means own ship is higher. */
  altDiff: number;
  side: GroundSide;
  /** Mean drift rate between the two orbits (m/s): difference of circular speeds at each semi-major axis. */
  drift: number;
  /** KV delta-v minus drift (m/s); below zero a KV cannot hold station with the target. */
  kvMargin: number;
}

export interface GroundInput {
  /** Current distance from the planet centre (m). */
  radius: number;
  /** Semi-major axis (m); null on open orbits, where the current radius stands in. */
  semiMajorAxis: number | null;
}

export function highGround(mu: number, me: GroundInput, other: GroundInput): HighGround {
  const altDiff = me.radius - other.radius;
  const side: GroundSide =
    Math.abs(altDiff) <= tuning.evenBandM ? 'even' : altDiff > 0 ? 'high' : 'low';
  const speedAt = (g: GroundInput): number => Math.sqrt(mu / (g.semiMajorAxis ?? g.radius));
  const drift = Math.abs(speedAt(me) - speedAt(other));
  return { altDiff, side, drift, kvMargin: tuning.kvDeltaV - drift };
}
