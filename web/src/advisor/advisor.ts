import { len, SHIP_CLASS_NAMES, sub } from '../sim/bridge';
import { fmtDistance } from '../ui/format';
import type { AdvisoryChannel } from './channel';
import { fillTemplate, VOICE, type VoiceConfig } from './config';
import { DEFAULT_PERSONA, type Persona } from './personas';
import { SpeechQueue } from './queue';
import {
  entityName,
  evaluateConditions,
  evaluateCues,
  type Cue,
  type VesselSnapshot,
} from './triggers';

interface Latch {
  latched: boolean;
  lastSaid: number;
}

/** Result of a commander action, as the AI hears it. */
export interface CommanderAction {
  /** Control action id (see `ui/controls.ts`). */
  id: string;
  /** Whether the ship accepted it. */
  ok: boolean;
}

/**
 * A vessel's built-in AI. It watches snapshots of the sim, warns, advises and
 * acknowledges orders on an `AdvisoryChannel`. It has no handle on the ship's
 * controls: tactics and strategy stay with the commander.
 */
export class VesselAdvisor {
  private queue: SpeechQueue;
  private latches = new Map<string, Latch>();
  private rotation = new Map<string, number>();
  private prev: VesselSnapshot | null = null;
  private burnSeconds = 0;
  private hullMax = 0;
  private greeted = false;
  private persona: Persona = DEFAULT_PERSONA;

  constructor(
    private channel: AdvisoryChannel,
    private cfg: VoiceConfig = VOICE,
  ) {
    this.queue = new SpeechQueue(cfg);
  }

  /** Forget everything (new flight). Queued lines are dropped. */
  reset(): void {
    this.queue.clear();
    this.latches.clear();
    this.prev = null;
    this.burnSeconds = 0;
    this.hullMax = 0;
    this.greeted = false;
  }

  /** Switches the wording and reading pace to a voice persona. Lines already queued keep their text. */
  setPersona(persona: Persona): void {
    this.persona = persona;
    this.queue.setWordsPerMinute(persona.speech.wordsPerMinute);
  }

  /** Feeds one snapshot; `now` is real time in seconds. Speaks if the voice is free. */
  observe(snap: VesselSnapshot, now: number): void {
    const self = snap.self;
    if (this.prev && this.prev.self.id !== self.id) this.reset();
    if (!this.greeted) {
      this.greeted = true;
      this.say({ id: 'status.online' }, snap, now);
    }
    this.hullMax = Math.max(this.hullMax, self.hp);
    const dt = this.prev ? Math.max(0, snap.simTime - this.prev.simTime) : 0;
    const burning = this.prev !== null && this.prev.self.throttle > 0;

    for (const c of evaluateConditions(snap, this.cfg.thresholds)) {
      const latch = this.latches.get(c.id) ?? { latched: false, lastSaid: -Infinity };
      const spec = this.cfg.lines[c.id];
      if (!latch.latched && c.on) {
        latch.latched = true;
        if (now - latch.lastSaid >= (spec?.cooldown ?? 0)) this.sayLatched(latch, c, snap, now);
      } else if (latch.latched && (c.hold ?? c.on)) {
        if (spec?.repeat && now - latch.lastSaid >= spec.repeat)
          this.sayLatched(latch, c, snap, now);
      } else {
        latch.latched = false;
      }
      this.latches.set(c.id, latch);
    }

    const memory = { burnSeconds: this.burnSeconds + (burning ? dt : 0), hullMax: this.hullMax };
    for (const cue of evaluateCues(snap, this.prev, this.cfg.thresholds, memory)) {
      this.say(cue, snap, now);
    }
    this.burnSeconds = self.throttle > 0 ? memory.burnSeconds : 0;
    this.prev = snap;
    this.flush(now);
  }

  /** Acknowledges an order the commander just gave. Call after `observe` has seen the ship. */
  acknowledge(action: CommanderAction, snap: VesselSnapshot, now: number): void {
    const self = snap.self;
    if (action.id === 'restart')
      this.greeted = true; // the reset line doubles as the greeting
    else if (!self.alive) return;
    let id = `ack.${action.id}`;
    const vars: Record<string, string> = {};
    if (action.id === 'fire-missile' && !action.ok) {
      id += self.target === null ? '.no_target' : '.fail';
    } else if (action.id === 'drop-mine' && !action.ok) {
      id += '.fail';
    } else if (!action.ok) {
      id =
        action.id === 'normal' || action.id === 'anti-normal'
          ? 'ack.attitude.planar'
          : 'ack.attitude.fail';
    }
    if (action.id === 'target-next') {
      const t = snap.entities.find((e) => e.id === self.target);
      if (!t) return;
      vars.target = entityName(t);
      vars.range = fmtDistance(len(sub(t.pos, self.pos)));
    }
    if (!this.cfg.lines[id]) return;
    this.say({ id, vars }, snap, now);
    this.flush(now);
  }

  /** Speaks a line on the commander-assist channel (the pilot's proposals and progress). */
  announce(cue: Cue, snap: VesselSnapshot, now: number): void {
    if (!snap.self.alive) return;
    this.say(cue, snap, now);
    this.flush(now);
  }

  /** Releases queued speech when the voice is free. Call every frame. */
  flush(now: number): void {
    for (let ev = this.queue.next(now); ev; ev = this.queue.next(now)) this.channel.publish(ev);
  }

  callsign(shipClass: number): string {
    return this.cfg.callsigns[SHIP_CLASS_NAMES[shipClass] ?? ''] ?? this.cfg.defaultCallsign;
  }

  private sayLatched(latch: Latch, cue: Cue, snap: VesselSnapshot, now: number): void {
    latch.lastSaid = now;
    this.say(cue, snap, now);
  }

  private say(requested: Cue, snap: VesselSnapshot, now: number): void {
    let cue = requested;
    if (!this.cfg.lines[cue.id] && cue.fallback) cue = { ...cue, id: cue.fallback };
    const spec = cue.text
      ? { priority: 'advise' as const, text: [cue.text] }
      : this.cfg.lines[cue.id];
    if (!spec || spec.text.length === 0) return;
    const variants = this.persona.lines[cue.id] ?? spec.text;
    const turn = this.rotation.get(cue.id) ?? 0;
    this.rotation.set(cue.id, turn + 1);
    const speaker = this.callsign(snap.self.shipClass);
    const text = fillTemplate(variants[turn % variants.length], {
      callsign: speaker,
      ...cue.vars,
    });
    this.queue.push(
      {
        id: cue.id,
        priority: spec.priority,
        rank: this.cfg.priorities[spec.priority].rank,
        text,
        vessel: snap.self.id,
        speaker,
        simTime: snap.simTime,
      },
      now,
    );
  }
}
