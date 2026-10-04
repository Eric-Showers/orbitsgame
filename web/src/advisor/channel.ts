import type { Priority } from './config';

/**
 * One spoken line from a vessel AI. Everything a listener needs is here, so a
 * text log and a future TTS backend can consume the same stream.
 */
export interface AdvisoryEvent {
  /** Unique, increasing per channel. */
  seq: number;
  /** Line id from `voice.json`, e.g. `threat.missile`. */
  id: string;
  priority: Priority;
  /** Rank of `priority` (0 = most urgent). */
  rank: number;
  text: string;
  /** Entity id of the vessel whose AI is speaking. */
  vessel: number;
  /** The AI's callsign, e.g. ARGUS. */
  speaker: string;
  /** Sim time (s) when the line was triggered. */
  simTime: number;
  /** Real time (s, caller's clock) when the line was released to listeners. */
  timestamp: number;
  /** Speech estimate in seconds; the queue holds the next line until it ends. */
  duration: number;
  /** Cut off whatever is being spoken (urgent lines only). */
  interrupt: boolean;
}

export type AdvisoryListener = (event: AdvisoryEvent) => void;

/** The single bus that vessel AIs speak on. Subscribe to show or voice lines. */
export class AdvisoryChannel {
  private listeners = new Set<AdvisoryListener>();
  private seq = 0;

  subscribe(listener: AdvisoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: Omit<AdvisoryEvent, 'seq'>): AdvisoryEvent {
    const full = { ...event, seq: ++this.seq };
    for (const l of this.listeners) l(full);
    return full;
  }
}
