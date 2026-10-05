import { Attitude, len } from '../sim/bridge';
import tuning from '../ui/highGround.json';
import type { Perception } from './perception';

/** Delta-v of the probe burn used to judge how a heading shifts the orbit (m/s). */
const PROBE_DV = 5;

/**
 * Orbital advantage of flying with `mode` now (the "high ground" of
 * docs/high-ground.md): how much a probe burn changes the drift between the
 * pilot's orbit and the foe's, as a fraction of KV delta-v. While munitions
 * are locked on us more drift is better (a KV cannot hold station); with none
 * inbound, less drift is better (we can stay matched to the foe). Radial burns
 * leave the orbit size alone and score 0. `score.advantage` in
 * `adversary.json` weights it.
 */
export function orbitalAdvantage(p: Perception, mode: Attitude): number {
  const sign =
    mode === Attitude.Prograde ? 1 : mode === Attitude.Retrograde ? -1 : 0;
  if (sign === 0 || !p.foe || !p.orbit || p.orbit.eccentricity >= 1) return 0;
  const r = len(p.me.pos);
  const v2 = p.me.vel.x ** 2 + p.me.vel.y ** 2 + p.me.vel.z ** 2;
  const a = p.orbit.semiMajorAxis;
  const mu = v2 / (2 / r - 1 / a);
  const rf = len(p.foe.pos);
  const vf2 = p.foe.vel.x ** 2 + p.foe.vel.y ** 2 + p.foe.vel.z ** 2;
  const inv = 2 / rf - vf2 / mu;
  if (!(inv > 0)) return 0;
  const aFoe = 1 / inv;
  const speedAt = (sma: number): number => Math.sqrt(mu / sma);
  const aNext = a + (sign * 2 * a * a * Math.sqrt(v2) * PROBE_DV) / mu;
  const now = Math.abs(speedAt(a) - speedAt(aFoe));
  const next = Math.abs(speedAt(aNext) - speedAt(aFoe));
  const gain = (next - now) / tuning.kvDeltaV;
  return p.threats.length > 0 ? gain : -gain;
}
