import type { Cue } from '../advisor/triggers';
import type { PilotEvent } from './pilot';

/**
 * Turns pilot events into ARGUS lines. The ids resolve against `voice.json`
 * (`ap.*`); `vars` are values to fill in. Returns null when nothing should be said.
 */
export function pilotCue(ev: PilotEvent, world: Record<string, string>): Cue | null {
  switch (ev.kind) {
    case 'proposed':
      return {
        id: `ap.propose.${ev.maneuver.kind}`,
        fallback: 'ap.propose',
        vars: { ...world, ...ev.plan.vars, label: ev.maneuver.label },
      };
    case 'refused':
      return { id: 'ap.refused', vars: { reason: ev.reason, label: ev.label } };
    case 'cancelled':
      return { id: 'ap.cancelled' };
    case 'started':
      return { id: 'ap.start', vars: { label: ev.maneuver.label } };
    case 'phase':
      return null; // engine and heading changes are not called out; the HUD shows them
    case 'done':
      return {
        id: `ap.done.${ev.maneuver.kind}`,
        fallback: 'ap.done',
        vars: { ...world, label: ev.maneuver.label },
      };
    case 'failed':
      return { id: 'ap.failed', vars: { reason: ev.reason, label: ev.maneuver.label } };
    case 'aborted':
      return ev.cause === 'assist-off'
        ? null
        : { id: `ap.aborted.${ev.cause}`, vars: { label: ev.maneuver.label } };
    case 'assist':
      return { id: ev.on ? 'ap.assist.on' : 'ap.assist.off' };
  }
}
