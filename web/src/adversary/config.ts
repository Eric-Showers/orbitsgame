import data from './adversary.json';

/** Every constant the adversary pilot uses. Tune in `adversary.json`; distances m, times s, speeds m/s. */
export interface AdversaryConfig {
  /** Munitions beyond this range are not perceived (m). */
  senseRange: number;
  /** Tier 1: one fixed counter burn when a threat closes inside `warnRange`. */
  reactive: { warnRange: number; burnSeconds: number; throttle: number; clearSeconds: number };
  /** Tier 2 and up: dodge timed from predicted time to intercept. */
  anticipate: {
    /** Ignite the counter burn when a threat is this many seconds from intercept. */
    commitSeconds: number;
    /** Start slewing to the chosen burn heading this many seconds before `commitSeconds`. */
    prepareSeconds: number;
    burnSeconds: number;
    /** Threat-free seconds before the pilot returns to its patrol orbit. */
    clearSeconds: number;
    /** A munition with less main-motor delta-v than this cannot steer onto us (m/s). */
    spentDeltaV: number;
    /** A spent munition is ignored when it passes wider than this many blast radii. */
    missMargin: number;
    /** Inside this time to intercept the drive may run past `calmCeiling`. */
    emergencySeconds: number;
  };
  /** Thermal discipline, as a fraction of the drive's heat capacity. */
  heat: { calmCeiling: number; emergencyCeiling: number; resumeBelow: number };
  safety: { minAltitude: number; altitudeMargin: number; maxAltitude: number };
  /** Tier 2 and up: burn back to the patrol orbit's energy once the sky is clear. */
  recover: { smaTolerance: number; throttle: number };
  /** Tier 3: close on the quarry and hold firing range. */
  pursuit: {
    /** Standoff as a fraction of the pilot's weapon range when the mission gives none. */
    standoffFraction: number;
    /** Desired approach speed per metre of range error (1/s). */
    approachGain: number;
    maxApproachSpeed: number;
    /** Relative-velocity error under which the pilot coasts (m/s). */
    deadband: number;
    /** Stop pursuing above this heat load until `heat.resumeBelow`. */
    pursueCeiling: number;
    alignTolerance: number;
    /** Throttle tapers as remaining velocity error / (accel * taperSeconds). */
    taperSeconds: number;
    /** A new burn direction must beat the held one by this much (cosine). */
    switchMargin: number;
  };
  /** Weights of the dodge-direction score; `advantage` is reserved for the high-ground term. */
  score: { escape: number; alternate: number; unsafe: number; advantage: number };
  /** Time-warp limits (levels) while the pilot is working. */
  warp: { alertRange: number; alertCap: number; burnCap: number };
}

export const ADVERSARY_CONFIG = data as AdversaryConfig;
