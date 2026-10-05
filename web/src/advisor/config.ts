import voiceData from './voice.json';

/** Speech priority classes, most urgent first. Ranks and TTLs live in `voice.json`. */
export type Priority = 'critical' | 'warning' | 'order' | 'ack' | 'advise' | 'status' | 'guide';

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
  heatHighFraction: number;
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
  burnReportMinSeconds: number;
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
  thresholds: Thresholds;
  lines: Record<string, LineSpec>;
}

/** The shipped voice: every line, threshold and cooldown the vessel AI uses. */
export const VOICE = voiceData as VoiceConfig;

/** Fills `{name}` placeholders; unknown names are left as written. */
export function fillTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}
