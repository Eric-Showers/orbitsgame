// Altitude-vs-time math for the orbit wave panel: each ship's height over the next few hours.
// Pure functions of state vectors; no sim handle in here.

import { desiredDirection, propagate } from '../autopilot/orbitmath';
import type { BurnNode } from '../autopilot/types';
import type { Vec3 } from '../sim/bridge';

/** How far ahead the panel looks (s) and how finely it samples that span. */
export const WAVE_HORIZON = 3 * 3600;
export const WAVE_SAMPLES = 361;

/** Height of a position above the surface (m); negative once a coasting orbit has dipped underground. */
export const altitudeOf = (pos: Vec3, planetRadius: number): number =>
  Math.hypot(pos.x, pos.y, pos.z) - planetRadius;

/**
 * Altitude above the surface at `n` evenly spaced moments from now to `horizon` seconds ahead, coasting along
 * the Kepler orbit (the ground is ignored, so a doomed orbit reads negative). Burns whose time falls inside the span are applied on the way; stops using them
 * at the first node whose direction cannot be worked out from the orbit alone (target-relative modes).
 */
export function altitudeTrack(
  mu: number,
  planetRadius: number,
  pos: Vec3,
  vel: Vec3,
  n: number,
  horizon: number,
  burns: { now: number; nodes: readonly BurnNode[] } | null = null,
): number[] {
  const queue = burns ? [...burns.nodes].sort((a, b) => a.time - b.time) : [];
  const out: number[] = [];
  let state = { pos, vel };
  let t = 0;
  let usable = true;
  for (let i = 0; i < n; i++) {
    const at = (horizon * i) / (n - 1);
    while (usable && burns && queue.length > 0 && queue[0].time - burns.now <= at) {
      const node = queue.shift()!;
      const when = Math.max(t, node.time - burns.now);
      state = propagate(mu, state.pos, state.vel, when - t);
      t = when;
      const dir = desiredDirection(node.mode, state.pos, state.vel);
      if (!dir) {
        usable = false;
        break;
      }
      state = {
        pos: state.pos,
        vel: { x: state.vel.x + dir.x * node.dv, y: state.vel.y + dir.y * node.dv, z: 0 },
      };
    }
    state = propagate(mu, state.pos, state.vel, at - t);
    t = at;
    out.push(altitudeOf(state.pos, planetRadius));
  }
  return out;
}

/** Whether any of the nodes can be placed from the orbit alone (so an after-burn track differs from the coast). */
export function plannedBurnsUsable(pos: Vec3, vel: Vec3, nodes: readonly BurnNode[]): boolean {
  const first = [...nodes].sort((a, b) => a.time - b.time)[0];
  return first !== undefined && desiredDirection(first.mode, pos, vel) !== null;
}
