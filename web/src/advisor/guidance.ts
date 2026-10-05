// Next-step guidance: after a maneuver finishes, the AI points at the helm
// button that fits the situation. Reads the snapshot only; the commander acts.

import { len, sub } from '../sim/bridge';
import { fmtDistance, fmtSpeed } from '../ui/format';
import type { Thresholds } from './config';
import { entityName, isHostile, type Cue, type VesselSnapshot } from './triggers';

const SETTLING = new Set(['circularize', 'altitude', 'evade', 'launch-missile', 'drop-mine']);

/** The guidance cue to follow a completed maneuver of `kind`, or null when there is nothing useful to add. */
export function guidanceAfter(kind: string, snap: VesselSnapshot, t: Thresholds): Cue | null {
  const { self } = snap;
  const target = snap.entities.find((e) => e.id === self.target && e.alive) ?? null;
  const vars: Record<string, string> = {};
  let hostile = false;
  let relSpeed = 0;
  if (target) {
    relSpeed = len(sub(target.vel, self.vel));
    vars.target = entityName(target);
    vars.range = fmtDistance(len(sub(target.pos, self.pos)));
    vars.relv = fmtSpeed(relSpeed);
    hostile = isHostile(self, target, t);
  }
  const cue = (id: string): Cue => ({ id, vars });

  if (target && relSpeed > t.matchVelocityRelSpeed && SETTLING.has(kind)) {
    return cue('guide.match_speed');
  }
  switch (kind) {
    case 'circularize':
    case 'altitude':
      return cue(target ? 'guide.rendezvous' : 'guide.designate');
    case 'rendezvous':
    case 'match-velocity':
      if (!target) return null;
      return cue(hostile ? 'guide.fire_or_hold' : 'guide.hold_station');
    case 'intercept':
      return target ? cue('guide.fire') : null;
    case 'evade':
      return cue('guide.recover');
    case 'launch-missile':
      return cue('guide.after_launch');
    case 'drop-mine':
      return cue('guide.after_mine');
    default:
      return null;
  }
}
