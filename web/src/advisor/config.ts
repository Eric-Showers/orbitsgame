import voiceData from './voice.json';

/** Speech priority classes, most urgent first. Ranks and TTLs live in `voice.json`. */
export type Priority =
  'critical' | 'warning' | 'order' | 'ack' | 'advise' | 'status' | 'guide' | 'quip' | 'debrief';

/**
 * What kind of line it is, which decides when it may be said. Each category
 * has its own pacing in `voice.json` so their rates tune separately:
 * alarms (danger), events (something just happened), status (readings, held
 * for a lull), objective (what to do next for the mission, lulls only, ahead
 * of quips), quips (banter, lulls only) and helm (the autopilot dialogue).
 */
export type Category = 'alarm' | 'event' | 'status' | 'objective' | 'quip' | 'helm';

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

/** Tag test against the situation: every `all`, at least one `any` (if given), and no `none`. */
export interface TagExpr {
  all?: string[];
  any?: string[];
  none?: string[];
}

/** A line variant that only fits some situations. Plain strings in `text` fit any. */
export interface TextVariant {
  t: string;
  when?: TagExpr;
  /** Base preference, default 1. */
  weight?: number;
  /** Real seconds before this exact variant may be chosen again. */
  cooldown?: number;
  /** Said at most once per flight. */
  once?: boolean;
  /** Only these personas say it (ids from `personas.json`). */
  persona?: string[];
}

/** Situation thresholds for tagging; see `situation.ts`. */
export interface SituationSpec {
  circularEccentricity: number;
  lowAltitude: number;
  highAltitude: number;
  heatHigh: number;
  heatCool: number;
  hullCritical: number;
  /** Real seconds without a ship action before the player counts as idle for a long time. */
  idleLongSeconds: number;
  /** Real seconds that count as "just now" for kills, misses, damage and burns. */
  recentSeconds: number;
  killStreak: number;
  /** Variants used within this many real seconds are passed over for fresh ones. */
  repeatWindow: number;
  /** The selector draws at random among this many best-fitting variants. */
  topChoices: number;
  /** Tags that mean something is happening; lines that use them outrank background banter. */
  salientTags: string[];
}

/** Wording and thresholds for the post-burn debrief. */
export interface DebriefSpec {
  /** Longest look-ahead for the next close approach, in orbits of our own. */
  orbitsAhead: number;
  /** Look-ahead cap in sim seconds. */
  maxHorizon: number;
  /** An approach this close counts as inside rendezvous range (m). */
  rendezvousRange: number;
  /** Relative speed (m/s) under which an approach is gentle enough to rendezvous. */
  gentleRelSpeed: number;
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
  /** Variants that fit only some situations (tagged), chosen by `select.ts`. */
  variants?: TextVariant[];
  /** Tags the whole line needs; applies to every variant of the line. */
  when?: TagExpr;
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

/** Distances and speeds for mission-objective advice. */
export interface ObjectiveSpec {
  /** Inside this range the advice turns to matching speed and easing in. */
  closeRange: number;
  /** Inside this range, closing from below (or above), the advice is to climb (or drop) back. */
  approachRange: number;
  /** Relative speed (m/s) above which the advice inside `closeRange` is to match velocity. */
  matchRelSpeed: number;
  /** Semi-major axis difference (m) that counts as being on a lower or higher orbit. */
  phasingMargin: number;
  /** Range at which a destroy objective's tracked target counts as within missile reach. */
  fireRange: number;
  /** Targets on orbits more eccentric than this that cross our altitude are waited for, not chased. */
  crossingEccentricity: number;
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
  situation: SituationSpec;
  debrief: DebriefSpec;
  objective: ObjectiveSpec;
  thresholds: Thresholds;
  lines: Record<string, LineSpec>;
}

/** The shipped voice: every line, threshold and cooldown the vessel AI uses. */
export const VOICE = voiceData as VoiceConfig;

/** Fills `{name}` placeholders; unknown names are left as written. */
export function fillTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/** Variables that name things rather than measure them; their digits are never rounded. */
const NAMES = new Set(['target', 'name', 'callsign', 'label']);

/** Rounds a number to two significant figures, the precision speech needs. */
export function twoSig(n: number): string {
  if (!Number.isFinite(n) || n === 0) return String(n);
  const mag = Math.floor(Math.log10(Math.abs(n)));
  const step = 10 ** (mag - 1);
  const rounded = Math.round(n / step) * step;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: Math.max(0, 1 - mag) });
}

/** Rounds every measurement in a line's variables to two significant figures ("25.4 km" says "25 km"). */
export function speakableVars(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    out[k] =
      NAMES.has(k) || v.includes(':')
        ? v
        : v.replace(/\d[\d,]*(?:\.\d+)?/g, (m) => twoSig(Number(m.replace(/,/g, ''))));
  }
  return out;
}
