import type { AdvisoryEvent } from './channel';
import type { VoiceConfig } from './config';

export type PendingLine = Omit<AdvisoryEvent, 'seq' | 'timestamp' | 'duration' | 'interrupt'> & {
  /** Queue group; a newer line replaces older queued ones of the same topic. */
  topic?: string;
  /** Topics cleared from the queue when this line arrives. */
  drops?: string[];
  /** Seconds this line stays worth saying (default: its priority's). */
  ttl?: number;
  /** May be dropped to keep the backlog short (default: its priority's). */
  shed?: boolean;
};

interface Queued {
  line: PendingLine;
  at: number;
  order: number;
}

/**
 * Rate-limited speech queue. One line "speaks" at a time for an estimated
 * duration; the most urgent queued line goes next, oldest first within a
 * priority. Stale lines expire, a re-queued line id replaces its older copy,
 * and an urgent line may interrupt a less urgent one.
 */
export class SpeechQueue {
  private items: Queued[] = [];
  private order = 0;
  private busyUntil = -Infinity;
  private speakingRank = Infinity;
  private wpm: number | undefined;

  constructor(private cfg: VoiceConfig) {}

  /** Overrides the configured reading pace (a voice persona speaks faster or slower). */
  setWordsPerMinute(wpm: number | undefined): void {
    this.wpm = wpm;
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
    this.busyUntil = -Infinity;
    this.speakingRank = Infinity;
  }

  push(line: PendingLine, now: number): void {
    this.items = this.items.filter(
      (q) =>
        q.line.id !== line.id &&
        !(line.topic !== undefined && q.line.topic === line.topic) &&
        !(q.line.topic !== undefined && line.drops?.includes(q.line.topic)),
    );
    this.items.push({ line, at: now, order: this.order++ });
    this.items.sort((a, b) => a.line.rank - b.line.rank || a.order - b.order);
    const max = this.cfg.speech.maxQueue;
    if (this.items.length > max) this.items.length = max; // drops the least urgent
    this.shedBacklog();
  }

  /** Drops queued topic lines (e.g. guidance the commander already acted on). */
  dropTopics(topics: readonly string[]): void {
    this.items = this.items.filter((q) => !(q.line.topic && topics.includes(q.line.topic)));
  }

  /** Seconds of sheddable speech waiting; oldest go first when it exceeds the limit. */
  private shedBacklog(): void {
    const sheddable = (q: Queued): boolean =>
      q.line.shed ?? this.cfg.priorities[q.line.priority].shed === true;
    const cost = (q: Queued): number => speechSeconds(q.line.text, this.cfg, this.wpm);
    for (;;) {
      const shed = this.items.filter(sheddable);
      const total = shed.reduce((n, q) => n + cost(q), 0);
      // Always keep the newest sheddable line: the latest thing said is the thing that matters.
      if (total <= this.cfg.speech.maxBacklogSeconds || shed.length <= 1) return;
      const oldest = shed.reduce((a, b) => (a.order <= b.order ? a : b));
      this.items = this.items.filter((q) => q !== oldest);
    }
  }

  /** Releases the next line if the voice is free (or it may interrupt). */
  next(now: number): Omit<AdvisoryEvent, 'seq'> | null {
    this.items = this.items.filter(
      (q) => now - q.at <= (q.line.ttl ?? this.cfg.priorities[q.line.priority].ttl),
    );
    const head = this.items[0];
    if (!head) return null;
    const busy = now < this.busyUntil;
    const interrupt =
      busy &&
      this.cfg.priorities[head.line.priority].interrupt === true &&
      head.line.rank < this.speakingRank;
    if (busy && !interrupt) return null;
    this.items.shift();
    const duration = speechSeconds(head.line.text, this.cfg, this.wpm);
    this.busyUntil = now + duration + this.cfg.speech.gapSeconds;
    this.speakingRank = head.line.rank;
    return { ...head.line, timestamp: now, duration, interrupt };
  }
}

export function speechSeconds(
  text: string,
  cfg: VoiceConfig,
  wpm = cfg.speech.wordsPerMinute,
): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(cfg.speech.minSeconds, (words * 60) / wpm);
}
