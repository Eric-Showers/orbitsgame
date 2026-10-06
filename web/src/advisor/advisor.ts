import { len, SHIP_CLASS_NAMES, sub } from '../sim/bridge';
import { DEFAULT_COMMANDER, addressCommander, appendName, stripCommander } from '../commander';
import { fmtDistance } from '../ui/format';
import type { AdvisoryChannel } from './channel';
import { guidanceAfter } from './guidance';
import {
  fillTemplate,
  VOICE,
  type Category,
  type LineSpec,
  type Priority,
  type VoiceConfig,
} from './config';
import { objectiveAdvice } from './objectives';
import { DEFAULT_PERSONA, type Persona } from './personas';
import { SpeechQueue } from './queue';
import {
  currentReadings,
  entityName,
  evaluateConditions,
  evaluateCues,
  evaluateManeuvers,
  evaluateStatus,
  isHostile,
  type BurnTrack,
  type Cue,
  type Reported,
  type VesselSnapshot,
} from './triggers';

const PLAYER_HULL = 'Corvette';

/** Lines between uses of the player's name. */
const NAME_GAP = 2;
const NAMEABLE = new Set<string>(['ack', 'advise', 'order', 'status', 'guide']);
/** Categories that mean something is happening; status and quips wait for them to clear. */
const ACTION: Category[] = ['alarm', 'event', 'helm'];
/** Client actions that are not flying the ship (time, camera). */
const NOT_HELM = /^(pause|warp|zoom|focus|camera|recentre|pan|free|restart)/;
/** Situational quip pools, tried before general banter when they fit. */
const QUIP_POOLS = ['quip.damaged', 'quip.victory', 'quip.hunting', 'quip.warp'] as const;

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
  private hullMax = 0;
  private tracks = new Map<number, BurnTrack>();
  private reported: Reported | null = null;
  /** Real time of the last burn, maneuver, alarm or event; lulls are measured from it. */
  private lastAction = -Infinity;
  /** Real time of the last lull line (objective advice or quip); they share one slot. */
  private lastSlot = -Infinity;
  private lastObjectiveLine: string | null = null;
  private lastKill = -Infinity;
  private statusNow = false;
  private maneuvering = false;
  private bags = new Map<string, number[]>();
  private greeted = false;
  private persona: Persona = DEFAULT_PERSONA;
  private commander = DEFAULT_COMMANDER;
  private linesSinceName = Infinity;

  constructor(
    private channel: AdvisoryChannel,
    private cfg: VoiceConfig = VOICE,
    private random: () => number = Math.random,
  ) {
    this.queue = new SpeechQueue(cfg);
  }

  /** Forget everything (new flight). Queued lines are dropped. */
  reset(): void {
    this.queue.clear();
    this.latches.clear();
    this.prev = null;
    this.hullMax = 0;
    this.tracks.clear();
    this.reported = null;
    this.lastAction = this.lastSlot = this.lastKill = -Infinity;
    this.statusNow = false;
    this.lastObjectiveLine = null;
    this.maneuvering = false;
    this.greeted = false;
    this.linesSinceName = Infinity;
  }

  /** Switches the wording and reading pace to a voice persona. Lines already queued keep their text. */
  setPersona(persona: Persona): void {
    this.persona = persona;
    this.queue.setWordsPerMinute(persona.speech.wordsPerMinute);
  }

  /** Whether the autopilot is flying a maneuver; status and quips wait until it is done. */
  setManeuvering(busy: boolean): void {
    this.maneuvering = busy;
  }

  /** What the AI calls the player in place of "Commander". */
  setCommander(name: string): void {
    this.commander = name;
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
    this.reported ??= currentReadings(snap); // the starting orbit needs no report

    let alarmLatched = false;
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
      if (latch.latched && spec?.category === 'alarm') alarmLatched = true;
      this.latches.set(c.id, latch);
    }

    const cues = [
      ...evaluateCues(snap, this.prev, this.cfg.thresholds, { hullMax: this.hullMax }),
      ...evaluateManeuvers(snap, this.prev, this.tracks, this.cfg.thresholds),
    ];
    for (const cue of cues) {
      if (cue.id === 'status.splash') this.lastKill = now;
      this.say(cue, snap, now);
    }
    this.prev = snap;

    const steady = self.alive && self.throttle === 0 && !this.maneuvering;
    if (!steady || alarmLatched || this.queue.has(...ACTION)) this.lastAction = now;
    this.flush(now);
    if (steady) this.speakInLull(snap, now);
  }

  /**
   * Status once the action has died down (or at once when the commander
   * warps after changing orbit), then a quip if the quiet lasts.
   */
  private speakInLull(snap: VesselSnapshot, now: number): void {
    const l = this.cfg.lull;
    const quiet = now - this.lastAction;
    if (this.statusNow || quiet >= l.quietSeconds) {
      this.statusNow = false;
      const { cues, reported } = evaluateStatus(snap, this.reported ?? currentReadings(snap), l);
      this.reported = reported;
      for (const cue of cues) this.say(cue, snap, now);
    }
    if (
      quiet >= l.quipQuietSeconds &&
      this.queue.size === 0 &&
      now - this.lastSlot >= this.cfg.categories.quip.minGap
    ) {
      this.lastSlot = now;
      // Mission advice takes the slot ahead of banter, but never the same line twice running.
      const advice = snap.objective
        ? objectiveAdvice(snap, snap.objective, this.cfg.objective)
        : null;
      if (advice && advice.id !== this.lastObjectiveLine && this.cfg.lines[advice.id]) {
        this.lastObjectiveLine = advice.id;
        this.say(advice, snap, now);
        this.flush(now);
        return;
      }
      const target = snap.entities.find((e) => e.id === snap.self.target);
      const vars = target ? { target: entityName(target) } : undefined;
      this.say({ id: this.quipPool(snap, now), vars }, snap, now);
    }
    this.flush(now);
  }

  private quipPool(snap: VesselSnapshot, now: number): string {
    const { self } = snap;
    const l = this.cfg.lull;
    const target = snap.entities.find((e) => e.id === self.target && e.alive);
    const fits: Record<(typeof QUIP_POOLS)[number], boolean> = {
      'quip.damaged': this.hullMax > 0 && self.hp / this.hullMax < l.quipHullFraction,
      'quip.victory': now - this.lastKill < l.quipVictorySeconds,
      'quip.hunting': !!target && isHostile(self, target, this.cfg.thresholds),
      'quip.warp': (snap.warp ?? 1) >= l.quipWarp,
    };
    const pools = QUIP_POOLS.filter((p) => fits[p] && this.variants(p).length > 0);
    if (pools.length > 0 && this.random() < l.contextualQuipChance) {
      return pools[Math.floor(this.random() * pools.length)];
    }
    return 'quip.idle';
  }

  /** Acknowledges an order the commander just gave. Call after `observe` has seen the ship. */
  acknowledge(action: CommanderAction, snap: VesselSnapshot, now: number): void {
    const self = snap.self;
    if (action.id === 'restart')
      this.greeted = true; // the reset line doubles as the greeting
    else if (!self.alive) return;
    // Flying the ship answers any pending next-step suggestion.
    if (!NOT_HELM.test(action.id)) this.queue.dropTopics(['guide']);
    if (action.id === 'warp-up' && action.ok && this.reported && snap.orbit) {
      // Warping on after a burn: the commander wants the new orbit now, not after a lull.
      this.statusNow = evaluateStatus(snap, this.reported, this.cfg.lull).cues.length > 0;
    }
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

  /** Points the commander at the next sensible step after a finished maneuver. */
  guide(kind: string, snap: VesselSnapshot, now: number): void {
    if (!snap.self.alive) return;
    const cue = guidanceAfter(kind, snap, this.cfg.thresholds);
    if (cue) this.announce(cue, snap, now);
  }

  /** Releases queued speech when the voice is free. Call every frame. */
  flush(now: number): void {
    for (let ev = this.queue.next(now); ev; ev = this.queue.next(now)) {
      if (ACTION.includes(ev.category)) this.lastAction = now;
      this.channel.publish(ev);
    }
  }

  callsign(shipClass: number): string {
    const hull = SHIP_CLASS_NAMES[shipClass] ?? '';
    if (hull === PLAYER_HULL) return this.persona.callsign;
    return this.cfg.callsigns[hull] ?? this.cfg.defaultCallsign;
  }

  /** The persona's wording for a line, or the shipped text. */
  private variants(id: string): string[] {
    return this.persona.lines[id] ?? this.cfg.lines[id]?.text ?? [];
  }

  /** Variant index: quips draw from a shuffled bag so none repeats until all are used; others rotate. */
  private pick(id: string, n: number, category: Category): number {
    if (category !== 'quip') {
      const turn = this.rotation.get(id) ?? 0;
      this.rotation.set(id, turn + 1);
      return turn % n;
    }
    let bag = this.bags.get(id);
    if (!bag || bag.length === 0 || bag.some((i) => i >= n)) {
      bag = [...Array(n).keys()];
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      this.bags.set(id, bag);
    }
    return bag.pop() ?? 0;
  }

  private sayLatched(latch: Latch, cue: Cue, snap: VesselSnapshot, now: number): void {
    latch.lastSaid = now;
    this.say(cue, snap, now);
  }

  private say(requested: Cue, snap: VesselSnapshot, now: number): void {
    let cue = requested;
    if (!this.cfg.lines[cue.id] && cue.fallback) cue = { ...cue, id: cue.fallback };
    const spec: LineSpec | undefined = cue.text
      ? { priority: 'guide', category: 'helm', text: [cue.text] }
      : this.cfg.lines[cue.id];
    if (!spec) return;
    const variants = cue.text ? spec.text : this.variants(cue.id);
    if (variants.length === 0) return;
    const speaker = this.callsign(snap.self.shipClass);
    const text = this.addressPlayer(
      fillTemplate(variants[this.pick(cue.id, variants.length, spec.category)], {
        callsign: speaker,
        name: this.commander,
        ...cue.vars,
      }),
      spec.priority,
    );
    this.queue.push(
      {
        id: cue.id,
        priority: spec.priority,
        category: spec.category,
        topic: spec.topic,
        drops: spec.drops,
        ttl: spec.ttl,
        shed: spec.shed,
        rank: this.cfg.priorities[spec.priority].rank,
        text,
        vessel: snap.self.id,
        speaker,
        simTime: snap.simTime,
      },
      now,
    );
  }

  /**
   * Works the player's name into speech. A chosen name replaces "Commander" and
   * is added to short routine lines every few lines; the default title is kept
   * rare so it never becomes a tic.
   */
  private addressPlayer(text: string, priority: Priority): string {
    const custom = this.commander !== DEFAULT_COMMANDER;
    const spaced = this.linesSinceName >= NAME_GAP;
    this.linesSinceName++;
    if (/\bCommander\b/.test(text)) {
      if (!custom && !spaced) return stripCommander(text);
      this.linesSinceName = 0;
      return addressCommander(text, this.commander);
    }
    if (custom && spaced && NAMEABLE.has(priority) && !text.includes(this.commander)) {
      const named = appendName(text, this.commander);
      if (named !== text) this.linesSinceName = 0;
      return named;
    }
    return text;
  }
}
