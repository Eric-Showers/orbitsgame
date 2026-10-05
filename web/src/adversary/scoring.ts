import { Attitude } from '../sim/bridge';
import type { Perception } from './perception';

/**
 * Orbital advantage of flying with `mode` now, positive when it improves the
 * pilot's tactical position (the "high ground" of docs/high-ground.md).
 * Reserved: returns 0 until that design lands. `score.advantage` in
 * `adversary.json` weights it, so switching it on needs no change to the
 * decision code; replace the body and set the weight.
 */
export function orbitalAdvantage(p: Perception, mode: Attitude): number {
  void p;
  void mode;
  return 0;
}
