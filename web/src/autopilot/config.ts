import data from './autopilot.json';

/** Every gain, margin and limit the maneuver scripts use. Tune in `autopilot.json`. */
export interface PilotConfig {
  attitude: {
    /** Heading error (rad) that counts as aligned. */
    alignTolerance: number;
    /** Seconds the heading must stay aligned before ignition. */
    settleSeconds: number;
  };
  burn: {
    /** Throttle tapers as remaining dv / (accel * taper); smaller is harsher. */
    taperSeconds: number;
    minThrottle: number;
    /** Cut the engine when the remaining dv drops under this (m/s). */
    dvTolerance: number;
    /** Plans needing less than this skip the burn (m/s). */
    minDvToBurn: number;
    maxBurnSeconds: number;
    /** Seconds before ignition at which the ship must already be aligned. */
    ignitionAlignSeconds: number;
  };
  safety: {
    /** Never plan an orbit with a periapsis below this altitude (m). */
    minAltitude: number;
    maxAltitude: number;
    /** Fraction of the tank held back from any plan. */
    reserveDvFraction: number;
    /** Below this eccentricity an orbit is "circular": any point is an apsis. */
    circularEcc: number;
  };
  altitude: { tolerance: number };
  rendezvous: {
    standoff: number;
    interceptStandoff: number;
    maxEccentricity: number;
    /** Altitude mismatch (m) that triggers a Hohmann first. */
    altitudeTolerance: number;
    /** Range (m) at which phasing is skipped and speed is simply matched. */
    closeRange: number;
    /** Allowed miss (m) around the standoff before another phasing pass. */
    rangeTolerance: number;
    maxRevolutions: number;
    maxAttempts: number;
    finalRelSpeed: number;
  };
  matchVelocity: { tolerance: number };
  stationKeep: { deadband: number; holdRange: number; recaptureStandoff: number };
  evade: {
    warnRange: number;
    burnSeconds: number;
    throttle: number;
    clearSeconds: number;
    /** Stay this far above the planet's surface after an inward burn (m). */
    altitudeMargin: number;
  };
  weapons: {
    /** Farthest target a missile launch is cleared for (m). */
    missileRange: number;
    /** Missile delta-v must beat the estimated need by this factor. */
    missileDvMargin: number;
    /** Seconds ahead a mine drop looks for a hostile crossing its orbit. */
    mineHorizon: number;
    mineSampleSeconds: number;
    /** A hostile must pass within this fraction of the mine's trigger range. */
    mineRangeFraction: number;
  };
  autoWarp: { enabled: boolean; minRealSeconds: number; levels: number[] };
}

export const PILOT_CONFIG = data as PilotConfig;
