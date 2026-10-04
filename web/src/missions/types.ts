// Mission data model. Missions live in `missions.json`; everything a designer
// tunes (orbits, loadouts, ranges, timers, par scores) is a field here, never a
// constant in the runtime. Distances in metres, times in seconds, speeds in m/s.

export type ShipClassName = 'corvette' | 'drone' | 'gunboat' | 'minelayer' | 'beacon';
export type TeamName = 'player' | 'enemy' | 'neutral';

/**
 * A planar prograde orbit, placed relative to the player's polar angle at the
 * moment the ship spawns (at mission start the player sits at angle 0).
 */
export interface OrbitDef {
  /** Periapsis altitude above the surface. */
  pe: number;
  /** Apoapsis altitude; defaults to `pe` (circular). */
  ap?: number;
  /** Direction of periapsis, degrees from the player's polar angle. */
  argPeDeg?: number;
  /** Where on the orbit the ship starts, degrees ahead of the player (negative = behind). */
  phaseDeg?: number;
  /** Alternative to `phaseDeg`: metres of arc ahead of the player, measured at radius R + pe. */
  lead?: number;
}

export interface LoadoutDef {
  missiles?: number;
  mines?: number;
  /** Fraction of a full tank, 0..1. Defaults to 1. */
  fuel?: number;
}

/** Hostile behaviours, driven client-side against the player. Combine freely. */
export interface AiDef {
  /** Tag of the ship this AI hunts and shoots at; defaults to the player. */
  prey?: string;
  /** Fires missiles at the player when in range. */
  gunner?: {
    range: number;
    /** Seconds between launches. */
    cooldown: number;
    /** Seconds after spawn before the first launch is allowed. */
    firstShotDelay?: number;
  };
  /** Drops mines when the player is within range. */
  miner?: { range: number; cooldown: number; firstDropDelay?: number };
  /** Burns radially when a hostile missile closes inside `warnRange`. */
  evade?: { warnRange: number; burnSeconds: number; throttle: number };
}

export interface ShipDef {
  /** Name objectives refer to. */
  tag: string;
  class: ShipClassName;
  team: TeamName;
  /** Display name in the HUD and target readout; defaults to the class name. */
  name?: string;
  orbit: OrbitDef;
  loadout?: LoadoutDef;
  ai?: AiDef;
  /** Spawn later instead of at mission start. */
  spawn?: { afterObjective?: string; atTime?: number };
}

interface ObjectiveBase {
  id: string;
  /** One-line instruction shown in the briefing and HUD. */
  label: string;
  /** Only starts counting once this objective is complete. */
  after?: string;
}

/** Reach an orbit with periapsis and apoapsis altitudes inside the ranges. */
export interface OrbitObjective extends ObjectiveBase {
  type: 'orbit';
  pe: [number, number];
  ap: [number, number];
  /** Seconds the orbit must be held. */
  hold?: number;
}

/** Stay within `range` of a ship, slower than `maxRelSpeed` relative to it, for `hold` seconds. */
export interface RendezvousObjective extends ObjectiveBase {
  type: 'rendezvous';
  target: string;
  range: number;
  maxRelSpeed: number;
  hold?: number;
}

/** Destroy every tagged ship. With `by`, any other cause of death fails the mission. */
export interface DestroyObjective extends ObjectiveBase {
  type: 'destroy';
  targets: string[];
  by?: 'missile' | 'mine' | 'any';
}

/** Lay `count` mines whose orbits stay entirely inside the altitude band. */
export interface MineZoneObjective extends ObjectiveBase {
  type: 'mineZone';
  count: number;
  altitude: [number, number];
}

/** Stay alive for `seconds` after the objective activates. */
export interface SurviveObjective extends ObjectiveBase {
  type: 'survive';
  seconds: number;
}

export type ObjectiveDef =
  OrbitObjective | RendezvousObjective | DestroyObjective | MineZoneObjective | SurviveObjective;

export interface FailDef {
  /** Tags of ships that must survive. */
  protect?: string[];
  /** Fail when the player's tank runs dry. */
  fuelOut?: boolean;
}

/** Stars: 1 for completing, +1 within `parTime` of mission time, +1 with at least `fuelReserve` of the tank left. Time never ends a mission. */
export interface ScoreDef {
  parTime: number;
  fuelReserve: number;
}

/** A line ARGUS speaks during a mission, at the moment its trigger fires. */
export interface CoachDef {
  when: { start: true } | { objective: string; status: 'active' | 'done' } | { atTime: number };
  /** Plain-language line; keep it a sentence or two. */
  text: string;
}

/** The idea a mission teaches, shown on the briefing. */
export interface LessonDef {
  concept: string;
  points: string[];
}

export interface MissionDef {
  id: string;
  title: string;
  /** Short tag line on the mission list. */
  summary: string;
  /** Briefing paragraphs. */
  briefing: string[];
  lesson?: LessonDef;
  coach?: CoachDef[];
  player: { class: ShipClassName; orbit: OrbitDef; loadout?: LoadoutDef; name?: string };
  ships: ShipDef[];
  objectives: ObjectiveDef[];
  fail?: FailDef;
  score: ScoreDef;
}

export interface MissionFile {
  version: 1;
  /**
   * When true, each mission unlocks only after the previous one is won.
   * Off (everything open) during development.
   */
  lockProgression?: boolean;
  missions: MissionDef[];
}
