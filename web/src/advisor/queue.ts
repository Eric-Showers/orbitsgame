import type { AdvisoryEvent } from './channel';
import type { VoiceConfig } from './config';

export type PendingLine = Omit<AdvisoryEvent, 'seq' | 'timestamp' | 'duration' | 'interrupt'>;

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
    this.items = this.items.filter((q) => q.line.id !== line.id);
    this.items.push({ line, at: now, order: this.order++ });
    this.items.sort((a, b) => a.line.rank - b.line.rank || a.order - b.order);
    const max = this.cfg.speech.maxQueue;
    if (this.items.length > max) this.items.length = max; // drops the least urgent
  }

  /** Releases the next line if the voice is free (or it may interrupt). */
  next(now: number): Omit<AdvisoryEvent, 'seq'> | null {
    this.items = this.items.filter((q) => now - q.at <= this.cfg.priorities[q.line.priority].ttl);
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
