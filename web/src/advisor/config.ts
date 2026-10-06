import voiceData from './voice.json';

/** Speech priority classes, most urgent first. Ranks and TTLs live in `voice.json`. */
export type Priority =
  'critical' | 'warning' | 'order' | 'ack' | 'advise' | 'status' | 'guide' | 'quip';

/**
 * What kind of line it is, which decides when it may be said. Each category
 * has its own pacing in `voice.json` so their rates tune separately:
 * alarms (danger), events (something just happened), status (readings, held
 * for a lull), quips (banter, lulls only) and helm (the autopilot dialogue).
 */
export type Category = 'alarm' | 'event' | 'status' | 'quip' | 'helm';

export interface CategorySpec {
  /** Real seconds between two lines of this category. */
  minGap: number;
  /** Held until the action dies down (no burn, maneuver, alarm or event for a while). */
  lull?: boolean;
}

/** When the action counts as having died down, and what a status report covers. */
export interface LullSpec {
  /** Real seconds without action before status lines are released. */
  quietSeconds: number;
  /** Real seconds without action before a quip may follow. */
  quipQuietSeconds: number;
  /** Chance a quip comes from a pool that fits the moment rather than general banter. */
  contextualQuipChance: number;
  /** An apsis must move this many metres (or this fraction of its altitude) to be re-reported. */
  orbitChangeMeters: number;
  orbitChangeFraction: number;
  /** Drive heat reported at a lull once at least this fraction, and again after moving by `heatReportStep`. */
  heatReportFraction: number;
  heatReportStep: number;
  /** Target range is re-reported after changing by this fraction. */
  targetRangeChange: number;
  /** Time warp at or above which warp quips fit. */
  quipWarp: number;
  /** Hull fraction under which damage quips fit. */
  quipHullFraction: number;
  /** Real seconds after a kill during which victory quips fit. */
  quipVictorySeconds: number;
}

export interface PrioritySpec {
  /** Lower speaks first. */
  rank: number;
  /** Real seconds a queued line stays worth saying. */
  ttl: number;
  /** May cut off a lower-ranked line already being spoken. */
  interrupt?: boolean;
  /** Dropped from the queue, oldest first, when the backlog runs too long. */
  shed?: boolean;
}

export interface LineSpec {
  priority: Priority;
  category: Category;
  /** Real seconds before this line may be said again after a fresh trigger. */
  cooldown?: number;
  /** While the condition holds, say it again every `repeat` real seconds. */
  repeat?: number;
  /** Queue group: a newer line in the same topic replaces older queued ones. */
  topic?: string;
  /** Topics wiped from the queue when this line is queued (it supersedes them). */
  drops?: string[];
  /** Overrides the priority's `ttl` for this line. */
  ttl?: number;
  /** Overrides the priority's `shed` for this line. */
  shed?: boolean;
  /** Variants, used in rotation. `{name}` placeholders are filled from the cue. */
  text: string[];
}

export interface Thresholds {
  heatLimitFraction: number;
  heatHysteresis: number;
  lowPeriapsisAlt: number;
  lowPeriapsisClearAlt: number;
  impactImminentSeconds: number;
  missileThreatRange: number;
  mineNearRange: number;
  mineNearClearRange: number;
  missileEnvelope: number;
  missileEnvelopeClear: number;
  matchVelocityRange: number;
  matchVelocityRelSpeed: number;
  matchVelocityClearRelSpeed: number;
  /** Delta-v (m/s) a contact must spend in one burn before its maneuver is called out. */
  maneuverDv: number;
  /** Hostile ships inside this range have their maneuvers called out, besides the designated target. */
  maneuverRange: number;
  neutralTeams: number[];
}

export interface VoiceConfig {
  callsigns: Record<string, string>;
  defaultCallsign: string;
  speech: {
    wordsPerMinute: number;
    gapSeconds: number;
    minSeconds: number;
    maxQueue: number;
    /** Most seconds of sheddable speech allowed to wait; older sheddable lines are dropped beyond it. */
    maxBacklogSeconds: number;
  };
  priorities: Record<Priority, PrioritySpec>;
  categories: Record<Category, CategorySpec>;
  lull: LullSpec;
  thresholds: Thresholds;
  lines: Record<string, LineSpec>;
}

/** The shipped voice: every line, threshold and cooldown the vessel AI uses. */
export const VOICE = voiceData as VoiceConfig;

/** Fills `{name}` placeholders; unknown names are left as written. */
export function fillTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}
