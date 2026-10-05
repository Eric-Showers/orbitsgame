import { Game } from '../wasm-pkg/orbit_wasm.js';
import {
  Attitude,
  decodeClassStats,
  EntityKind,
  type ClassStats,
  type EntityView,
} from '../sim/bridge';
import type { FlightSession } from '../sim/session';
import { ADVERSARY_CONFIG, type AdversaryConfig } from './config';
import { decide, newMemory, type Command, type Memory, type Tier } from './decide';
import { perceive, type Perception } from './perception';

/** Mission-data description of an adversary pilot (`AiDef.pilot`). */
export interface PilotDef {
  tier: Tier;
  /** Range to hold from the quarry (m); defaults to `pursuit.standoffFraction` of the weapon range. */
  standoff?: number;
}

/** The three commands a pilot issues; the same ones the player's helm has. */
export interface Controls {
  setAttitude(mode: Attitude): void;
  setThrottle(t: number): void;
  setTarget(id: number | null): void;
}

const statCache = new Map<number, ClassStats>();
const classStats = (c: number): ClassStats => {
  let s = statCache.get(c);
  if (!s) statCache.set(c, (s = decodeClassStats(Game.class_stats(c))));
  return s;
};

/**
 * A scripted opponent pilot (no learning): each tick it perceives the sim,
 * asks `decide` for a command and flies it through the helm. Heat-limited like
 * every ship: it burns only while its drive allows.
 */
export class AdversaryPilot {
  readonly mem: Memory = newMemory();
  /** What the pilot did on its last tick, for tests and a future HUD callout. */
  last: Command = { attitude: null, throttle: 0, intent: 'idle', note: 'holding orbit' };
  private perception: Perception | null = null;
  private blast: Partial<Record<EntityKind, number>> | null = null;
  private mode: Attitude | null = null;
  private throttle = 0;

  constructor(
    readonly id: number,
    readonly def: PilotDef,
    private weaponRange: number,
    private cfg: AdversaryConfig = ADVERSARY_CONFIG,
  ) {}

  get tier(): Tier {
    return this.def.tier;
  }

  /** One decision against `quarry`, applied through `helm`. */
  act(s: FlightSession, quarry: number, helm: Controls): Command {
    const me = s.entity(this.id);
    if (!me?.alive) {
      this.throttle = 0;
      this.perception = null;
      return this.last;
    }
    const foe = s.entity(quarry);
    const p = perceive({
      time: s.time,
      planetRadius: s.planetRadius,
      me,
      stats: classStats(me.shipClass),
      orbit: s.orbit(me.id),
      entities: s.all(),
      foe: foe?.alive ? foe : undefined,
      standoff: this.def.standoff ?? this.weaponRange * this.cfg.pursuit.standoffFraction,
      senseRange: this.cfg.senseRange,
      blast: (this.blast ??= munitionBlast()),
    });
    this.perception = p;
    const cmd = decide(this.def.tier, p, this.mem, this.cfg);
    this.apply(cmd, quarry, me, foe, helm);
    this.last = cmd;
    return cmd;
  }

  private apply(
    cmd: Command,
    quarry: number,
    me: EntityView,
    foe: EntityView | undefined,
    helm: Controls,
  ): void {
    if (this.def.tier >= 3 && foe?.alive && me.target !== quarry) helm.setTarget(quarry);
    if (cmd.attitude !== null && cmd.attitude !== this.mode) {
      helm.setAttitude(cmd.attitude);
      this.mode = cmd.attitude;
    }
    if (cmd.throttle !== this.throttle) {
      helm.setThrottle(cmd.throttle);
      this.throttle = cmd.throttle;
    }
  }

  /** Highest time warp this pilot allows right now (Infinity when it is idle and nothing is near). */
  warpCap(): number {
    const w = this.cfg.warp;
    const p = this.perception;
    if (this.throttle > 0) return w.burnCap;
    const near =
      p !== null && (p.threats.length > 0 || (this.def.tier >= 3 && p.foeRange <= w.alertRange));
    return near ? w.alertCap : Infinity;
  }
}

/** Blast radius per munition kind, from the sim's published stats. */
function munitionBlast(): Partial<Record<EntityKind, number>> {
  const blast = (kind: number): number => Game.munition_stats(kind)[4] ?? 40;
  return {
    [EntityKind.Missile]: blast(1),
    [EntityKind.Mine]: blast(2),
    [EntityKind.Kv]: blast(3),
  };
}
