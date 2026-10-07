import type { PilotDef } from '../adversary/pilot';

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
}

/** Hostile behaviours, driven client-side against the player. Combine freely. */
export interface AiDef {
  /**
   * Scripted pilot that flies the hull itself (tier 0 passive, 1 reacts, 2
   * anticipates, 3 pursues). Replaces `evade`; combine with `gunner`/`miner`
   * for the weapons it fires.
   */
  pilot?: PilotDef;
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
}

/** Stars: 1 for completing, +1 within `parTime` of mission time, +1 if the drive never climbs above `heatCeiling` of its thermal limit. Time never ends a mission. */
export interface ScoreDef {
  parTime: number;
  /** Peak drive heat the run may reach, as a fraction of the thermal limit (0..1). */
  heatCeiling: number;
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

/** Inclusive altitude bounds in metres; either side may be left open. */
export interface AltRange {
  min?: number;
  max?: number;
}

/**
 * A test on the flight that a tutorial step waits for (or is skipped by). Pure
 * data: `tutorial.ts` evaluates it against a snapshot of the world.
 */
export type TutorialCond =
  /** The commander pressed this control action (button or key) during the step. */
  | { action: string | string[] }
  /** The ship is pointed in this attitude mode, named by its control action id (e.g. `prograde`). */
  | { mode: string }
  | { throttle: 'on' | 'off' }
  | { ap?: AltRange; pe?: AltRange }
  /** Seconds until apoapsis (or periapsis) is at most this. */
  | { apEtaBelow: number }
  | { peEtaBelow: number }
  /** A live target is locked; with a tag, that particular ship. */
  | { target: true | string }
  /** Range to the locked target, in metres. */
  | { range: { below?: number; above?: number } }
  /** Closing speed on the locked target (m/s, positive = closing). */
  | { closing: { above?: number; below?: number } }
  /** Speed relative to the locked target (m/s). */
  | { relSpeed: { above?: number; below?: number } }
  | { warp: true }
  | { assist: boolean }
  /** The ARGUS plan card is showing. */
  | { proposal: true }
  /** The helm is (or is not) flying a maneuver. */
  | { helmBusy: boolean }
  | { objective: string; status: 'active' | 'done' }
  /** This many objectives are done. */
  | { done: number }
  /** Real seconds since the step began. */
  | { seconds: number }
  | { all: TutorialCond[] }
  | { any: TutorialCond[] };

/** Keeps the flight from skipping past something the step is waiting for. */
/** `stop` drops the flight to normal speed for steps flown by hand. */
export type WarpGuard = 'apoapsis' | 'periapsis' | 'target' | 'stop';

export interface TutorialStep {
  /** What ARGUS says, and the caption on screen. Plain language, one or two sentences. */
  say: string;
  /** CSS selectors of interface parts to outline. Missing or hidden ones are ignored. */
  highlight?: string[];
  /** Selectors of buttons to flash. The first of `flash` (else `highlight`) also gets the arrow. */
  flash?: string[];
  /** When the step is complete. Omitted: it advances on its own after a reading pause. */
  until?: TutorialCond;
  /** The step is skipped if this already holds when it begins. */
  skipIf?: TutorialCond;
  /** Repeated if the step lingers, e.g. when the player undid something. */
  hint?: string;
  /** Cuts the engine when the orbit reaches these altitudes (m): a safety net for fast burns. */
  cutAt?: { ap?: number; pe?: number };
  warpGuard?: WarpGuard;
  /** The ship AI locks this ship (by mission tag) as the player's target when the step begins. */
  lock?: string;
  /** Fills the helm's altitude box (km) when the step begins. */
  prefill?: { altitudeKm: number };
}

/** A guided walkthrough: ordered steps, each teaching one control or idea. */
export interface TutorialDef {
  steps: TutorialStep[];
}

export interface MissionDef {
  id: string;
  title: string;
  /** Short tag line on the mission list. */
  summary: string;
  /** Briefing paragraphs. Empty for tutorials: they launch straight into flight. */
  briefing: string[];
  /** Present on tutorial levels. The ship AI offers this script when the level starts. */
  tutorial?: TutorialDef;
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
