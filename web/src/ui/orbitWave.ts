// Phase-vs-time math for the orbit wave panel: each ship's inertial angle over the next few hours.
// Pure functions of state vectors; no sim handle in here.

import { desiredDirection, propagate, TAU, wrapTau } from '../autopilot/orbitmath';
import type { BurnNode } from '../autopilot/types';
import type { Vec3 } from '../sim/bridge';

/** How far ahead the panel looks (s) and how finely it samples that span. */
export const WAVE_HORIZON = 3 * 3600;
export const WAVE_SAMPLES = 361;

/** Inertial angle of a position, in [0, 2pi). */
export const phaseOf = (pos: Vec3): number => wrapTau(Math.atan2(pos.y, pos.x));

/** Signed angle a - b folded into (-pi, pi]. */
export function phaseGap(a: number, b: number): number {
  const d = wrapTau(a - b);
  return d > Math.PI ? d - TAU : d;
}

/**
 * Inertial angle at `n` evenly spaced moments from now to `horizon` seconds ahead, coasting along
 * the Kepler orbit. Burns whose time falls inside the span are applied on the way; stops using them
 * at the first node whose direction cannot be worked out from the orbit alone (target-relative modes).
 */
export function phaseTrack(
  mu: number,
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
    out.push(phaseOf(state.pos));
  }
  return out;
}

/** Whether any of the nodes can be placed from the orbit alone (so an after-burn track differs from the coast). */
export function plannedBurnsUsable(pos: Vec3, vel: Vec3, nodes: readonly BurnNode[]): boolean {
  const first = [...nodes].sort((a, b) => a.time - b.time)[0];
  return first !== undefined && desiredDirection(first.mode, pos, vel) !== null;
}

/**
 * Moments (seconds from now) where two tracks sit at the same angle, i.e. the ships line up
 * along the same bearing from the planet. Found by sign changes of the wrapped gap.
 */
export function alignments(a: readonly number[], b: readonly number[], horizon: number): number[] {
  const out: number[] = [];
  const step = horizon / (a.length - 1);
  let prev = phaseGap(b[0], a[0]);
  for (let i = 1; i < a.length; i++) {
    const d = phaseGap(b[i], a[i]);
    // A jump of more than half a turn is the fold at +-pi, not a crossing.
    if (prev !== 0 && prev * d <= 0 && Math.abs(d - prev) < Math.PI)
      out.push((i - 1 + prev / (prev - d)) * step);
    prev = d;
  }
  return out;
}
