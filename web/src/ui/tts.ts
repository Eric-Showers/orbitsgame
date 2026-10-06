import type { AdvisoryChannel, AdvisoryEvent } from '../advisor/channel';
import { DEFAULT_PERSONA, findPersona, type Persona } from '../advisor/personas';

const ENABLED_KEY = 'orbits.tts';
const PERSONA_KEY = 'orbits.voicePersona';
/** Lines this unimportant (advise, status) are skipped while speech is backed up. */
const BACKLOG_RANK = 3;

/** The slice of `speechSynthesis` this player uses, so tests can stand in a fake. */
export interface Synth {
  speak(u: SpeechSynthesisUtterance): void;
  cancel(): void;
  getVoices(): SpeechSynthesisVoice[];
  /** True while lines are queued behind the one being spoken. */
  readonly pending?: boolean;
  addEventListener?(type: 'voiceschanged', fn: () => void): void;
}

function load(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function save(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Private mode: the setting lasts for this page only.
  }
}

/**
 * Picks the installed voice that best matches a persona's hints, or null for
 * the browser default. A voice in `avoid` (another persona's) is passed over
 * while any other hinted or same-language voice is available, so personas do
 * not all collapse onto the one voice a browser offers first.
 */
export function pickVoice(
  voices: SpeechSynthesisVoice[],
  persona: Persona,
  avoid: SpeechSynthesisVoice | null = null,
): SpeechSynthesisVoice | null {
  const lang = persona.voice.lang.toLowerCase();
  const pool = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const candidates = pool.length > 0 ? pool : voices;
  const hinted = (allow: (v: SpeechSynthesisVoice) => boolean): SpeechSynthesisVoice | null => {
    for (const hint of persona.voice.hints) {
      const h = hint.toLowerCase();
      const found = candidates.find((v) => allow(v) && v.name.toLowerCase().includes(h));
      if (found) return found;
    }
    return null;
  };
  const fresh = (v: SpeechSynthesisVoice): boolean => v !== avoid;
  return hinted(fresh) ?? pool.find(fresh) ?? hinted(() => true) ?? pool[0] ?? null;
}

/**
 * Reads the vessel AI's lines aloud with the browser's speech synthesis, in the
 * selected persona's voice. Listens on the advisory channel like the comms log.
 * The enabled flag and chosen persona are remembered in `localStorage`.
 */
export class TtsPlayer {
  private on: boolean;
  private current: Persona;
  private onChange: (() => void)[] = [];

  constructor(
    channel: AdvisoryChannel,
    private synth: Synth | null = globalThis.speechSynthesis ?? null,
    private makeUtterance: (text: string) => SpeechSynthesisUtterance = (t) =>
      new SpeechSynthesisUtterance(t),
  ) {
    this.on = this.supported && load(ENABLED_KEY) === 'on';
    this.current = findPersona(load(PERSONA_KEY));
    channel.subscribe((ev) => this.hear(ev));
  }

  get supported(): boolean {
    return this.synth !== null;
  }

  get enabled(): boolean {
    return this.on;
  }

  get persona(): Persona {
    return this.current;
  }

  /** Called after the enabled flag or persona changes, so a UI can redraw. */
  subscribe(fn: () => void): void {
    this.onChange.push(fn);
  }

  setEnabled(on: boolean): void {
    on = on && this.supported;
    if (on === this.on) return;
    this.on = on;
    save(ENABLED_KEY, on ? 'on' : 'off');
    if (!on) this.synth?.cancel();
    this.onChange.forEach((f) => f());
  }

  setPersona(persona: Persona): void {
    this.current = persona;
    save(PERSONA_KEY, persona.id);
    this.onChange.forEach((f) => f());
  }

  /** Speaks `text` in the current persona's voice right away, cutting off anything in progress. */
  say(text: string): void {
    if (!this.synth) return;
    this.synth.cancel();
    this.utter(text);
  }

  private hear(ev: AdvisoryEvent): void {
    if (!this.on || !this.synth) return;
    if (ev.interrupt) this.synth.cancel();
    else if (this.synth.pending && ev.rank >= BACKLOG_RANK) return; // the voice is behind: drop chatter, keep warnings
    this.utter(ev.text);
  }

  private utter(text: string): void {
    if (!this.synth) return;
    const u = this.makeUtterance(text);
    const s = this.current.speech;
    u.rate = s.rate;
    u.pitch = s.pitch;
    u.volume = s.volume;
    const voices = this.synth.getVoices();
    // Alternate personas keep clear of the default persona's voice where they can.
    const base = this.current.id === DEFAULT_PERSONA.id ? null : pickVoice(voices, DEFAULT_PERSONA);
    const voice = pickVoice(voices, this.current, base);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    this.synth.speak(u);
  }
}
