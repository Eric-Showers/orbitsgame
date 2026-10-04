import type { SimEvent } from '../sim/bridge';
import type { FlightSession } from '../sim/session';
import type { VesselSnapshot } from './triggers';

/** Copies what the player's AI may see out of a session. Read-only by construction. */
export function playerSnapshot(
  session: FlightSession,
  events: readonly SimEvent[],
): VesselSnapshot {
  const self = session.player();
  return {
    simTime: session.time,
    planetRadius: session.planetRadius,
    self,
    orbit: self.alive ? session.orbit(self.id) : null,
    entities: session.all(),
    events,
  };
}
