import type { Game } from '../wasm-pkg/orbit_wasm.js';
import { EntityKind, len, SimEventKind, sub, type SimEvent } from '../sim/bridge';
import { FlightSession } from '../sim/session';
import { fmtDistance, fmtDuration, fmtSpeed } from '../ui/format';
import { HostileAi } from './ai';
import { SHIP_CLASS_INDEX, TEAM_INDEX } from './load';
import type { LoadoutDef, MissionDef, ObjectiveDef, OrbitDef, ShipDef } from './types';

export type ObjectiveStatus = 'waiting' | 'active' | 'done' | 'failed';
export type Outcome = 'running' | 'won' | 'lost';
type KillCause = 'missile' | 'mine' | 'crash' | 'other';

export interface ObjectiveState {
  def: ObjectiveDef;
  status: ObjectiveStatus;
  /** 0..1 for the HUD bar. */
  progress: number;
  /** Live readout, e.g. "RNG 1.2 km · REL 3 m/s". */
  detail: string;
  /** Seconds the hold condition has been met (orbit/rendezvous). */
  held: number;
  activatedAt: number;
  /** Mines laid in the zone (mineZone). */
  count: number;
}

const DEG = Math.PI / 180;

/**
 * One attempt at a mission: builds the world from its `MissionDef`, flies the
 * hostiles, and checks objectives and failure conditions after every frame.
 */
export class MissionRun {
  readonly session: FlightSession;
  readonly objectives: ObjectiveState[];
  outcome: Outcome = 'running';
  /** Why the mission ended (failure reason or "All objectives complete"). */
  reason = '';
  /** Ship id for each tag, once spawned. */
  readonly ids = new Map<string, number>();
  private names = new Map<number, string>();
  private unspawned: ShipDef[];
  private ais: HostileAi[] = [];
  private kills = new Map<number, KillCause>();
  private coachSaid = new Set<number>();
  private coachLines: string[] = [];

  constructor(
    game: Game,
    readonly def: MissionDef,
  ) {
    const p = def.player;
    this.session = new FlightSession(game, (g) => {
      const id = spawnShip(g, SHIP_CLASS_INDEX[p.class], TEAM_INDEX.player, p.orbit, 0);
      applyLoadout(g, id, p.loadout);
      return id;
    });
    this.ids.set('player', this.session.playerId);
    this.names.set(this.session.playerId, p.name ?? 'You');
    this.objectives = def.objectives.map((o) => ({
      def: o,
      status: 'waiting',
      progress: 0,
      detail: '',
      held: 0,
      activatedAt: 0,
      count: 0,
    }));
    this.unspawned = [...def.ships];
    this.spawnDue();
    this.activate();
    this.coach();
  }

  /** Coaching lines that fired since the last call; ARGUS speaks them. */
  takeCoach(): string[] {
    const lines = this.coachLines;
    this.coachLines = [];
    return lines;
  }

  /** Display name of a ship (mission name, else its tag). */
  nameOf(id: number): string | undefined {
    return this.names.get(id);
  }

  /** Advances the flight by real seconds. Returns the sim events for the view. */
  update(realDt: number): SimEvent[] {
    const s = this.session;
    if (this.outcome !== 'running') {
      s.throttleRamp = 0;
      return s.takeEvents();
    }
    for (const ai of this.ais) {
      const quarry = ai.prey === undefined ? s.playerId : (this.ids.get(ai.prey) ?? -1);
      ai.act(s, quarry);
    }
    s.refresh();
    const t0 = s.time;
    s.update(realDt);
    const events = s.takeEvents();
    this.observe(events);
    this.activate();
    this.progress(s.time - t0);
    this.spawnDue();
    this.activate();
    this.coach();
    this.checkEnd();
    return events;
  }

  /** 0 while running or lost; 1-3 once won. */
  stars(): number {
    if (this.outcome !== 'won') return 0;
    const me = this.session.player();
    const fuel = me.fuelMax > 0 ? me.fuel / me.fuelMax : 1;
    return (
      1 +
      (this.session.time <= this.def.score.parTime ? 1 : 0) +
      (fuel >= this.def.score.fuelReserve ? 1 : 0)
    );
  }

  /** Seconds left before the time limit, if there is one. */
  timeLeft(): number | null {
    const limit = this.def.fail?.timeLimit;
    return limit === undefined ? null : Math.max(0, limit - this.session.time);
  }

  private spawnDue(): void {
    const s = this.session;
    const done = new Set(this.objectives.filter((o) => o.status === 'done').map((o) => o.def.id));
    const ref = s.player().alive ? Math.atan2(s.player().pos.y, s.player().pos.x) : 0;
    let spawned = false;
    this.unspawned = this.unspawned.filter((d) => {
      const when = d.spawn;
      const due =
        (when?.afterObjective === undefined || done.has(when.afterObjective)) &&
        (when?.atTime === undefined || s.time >= when.atTime);
      if (!due) return true;
      const id = spawnShip(s.game, SHIP_CLASS_INDEX[d.class], TEAM_INDEX[d.team], d.orbit, ref);
      applyLoadout(s.game, id, d.loadout);
      this.ids.set(d.tag, id);
      this.names.set(id, d.name ?? d.tag);
      if (d.ai) this.ais.push(new HostileAi(id, d.ai, s.time));
      spawned = true;
      return false;
    });
    if (spawned) s.refresh();
  }

  /** Records how ships died and which player mines landed in a zone. */
  private observe(events: readonly SimEvent[]): void {
    const s = this.session;
    let blast: EntityKind | undefined;
    for (const ev of events) {
      const e = s.entity(ev.id);
      switch (ev.kind) {
        case SimEventKind.Detonation:
          blast = e?.kind;
          break;
        case SimEventKind.ShipDestroyed:
          this.kills.set(
            ev.id,
            blast === EntityKind.Missile ? 'missile' : blast === EntityKind.Mine ? 'mine' : 'other',
          );
          break;
        case SimEventKind.Crash:
          if (e?.kind === EntityKind.Ship) this.kills.set(ev.id, 'crash');
          break;
        case SimEventKind.MineDropped:
          if (e?.team === TEAM_INDEX.player) this.countMine(ev.id);
          break;
      }
    }
  }

  private countMine(mineId: number): void {
    const s = this.session;
    const orbit = s.orbit(mineId);
    if (!orbit) return;
    const R = s.planetRadius;
    const pe = orbit.periapsis - R;
    const ap = orbit.apoapsis - R;
    for (const o of this.objectives) {
      if (o.status !== 'active' || o.def.type !== 'mineZone') continue;
      const [lo, hi] = o.def.altitude;
      if (pe >= lo && ap <= hi && orbit.eccentricity < 1) {
        o.count++;
      } else {
        o.detail = `LAST MINE OFF BAND · PE ${fmtDistance(pe)} AP ${fmtDistance(ap)}`;
      }
    }
  }

  private coach(): void {
    (this.def.coach ?? []).forEach((c, i) => {
      if (this.coachSaid.has(i)) return;
      const w = c.when;
      const hit =
        'start' in w ||
        ('atTime' in w && this.session.time >= w.atTime) ||
        ('objective' in w &&
          this.objectives.some(
            (o) =>
              o.def.id === w.objective &&
              (w.status === 'done' ? o.status === 'done' : o.status !== 'waiting'),
          ));
      if (!hit) return;
      this.coachSaid.add(i);
      this.coachLines.push(c.text);
    });
  }

  private activate(): void {
    const done = new Set(this.objectives.filter((o) => o.status === 'done').map((o) => o.def.id));
    for (const o of this.objectives) {
      if (o.status === 'waiting' && (o.def.after === undefined || done.has(o.def.after))) {
        o.status = 'active';
        o.activatedAt = this.session.time;
      }
    }
  }

  private progress(dt: number): void {
    const s = this.session;
    const me = s.player();
    const R = s.planetRadius;
    // Destroy objectives watch kills even before they activate, so a forbidden
    // kill (wrong weapon) fails the mission whenever it happens.
    for (const o of this.objectives) {
      const d = o.def;
      if (d.type === 'destroy' && o.status !== 'done' && o.status !== 'failed') {
        this.progressDestroy(o, d);
      }
      if (o.status !== 'active') continue;
      switch (d.type) {
        case 'orbit': {
          const orbit = s.orbit(me.id);
          if (!orbit) break;
          const pe = orbit.periapsis - R;
          const ap = orbit.eccentricity < 1 ? orbit.apoapsis - R : Infinity;
          const ok = inRange(pe, d.pe) && inRange(ap, d.ap);
          this.hold(o, ok, d.hold ?? 0, dt);
          o.detail = `PE ${fmtDistance(pe)} · AP ${Number.isFinite(ap) ? fmtDistance(ap) : 'ESCAPE'}`;
          break;
        }
        case 'rendezvous': {
          const t = s.entity(this.ids.get(d.target) ?? null);
          if (!t) break;
          if (!t.alive) {
            this.failObjective(o, `${this.names.get(t.id)} was lost`);
            break;
          }
          const range = len(sub(t.pos, me.pos));
          const rel = len(sub(t.vel, me.vel));
          this.hold(o, range <= d.range && rel <= d.maxRelSpeed, d.hold ?? 0, dt);
          o.detail = `RNG ${fmtDistance(range)} · REL ${fmtSpeed(rel)}`;
          break;
        }
        case 'mineZone': {
          o.progress = Math.min(1, o.count / d.count);
          if (o.count >= d.count) {
            o.status = 'done';
            o.detail = '';
            break;
          }
          if (!o.detail.startsWith('LAST')) o.detail = `${o.count}/${d.count} LAID`;
          if (s.munitionsLeft(me.id).mines < d.count - o.count) {
            this.failObjective(o, 'Not enough mines left to finish the field');
          }
          break;
        }
        case 'survive': {
          const t = s.time - o.activatedAt;
          o.progress = Math.min(1, t / d.seconds);
          o.detail = fmtDuration(Math.max(0, d.seconds - t));
          if (t >= d.seconds) o.status = 'done';
          break;
        }
      }
    }
  }

  private progressDestroy(o: ObjectiveState, d: Extract<ObjectiveDef, { type: 'destroy' }>): void {
    const s = this.session;
    let dead = 0;
    for (const tag of d.targets) {
      const id = this.ids.get(tag);
      const cause = id === undefined ? undefined : this.kills.get(id);
      if (cause === undefined) continue;
      dead++;
      if (d.by && d.by !== 'any' && cause !== d.by) {
        const how = cause === 'crash' ? 'crashed' : `was destroyed by ${cause}`;
        return this.failObjective(o, `${this.names.get(id!)} ${how}, not by ${d.by}`);
      }
    }
    o.progress = dead / d.targets.length;
    o.detail = `${dead}/${d.targets.length} DOWN`;
    if (dead === d.targets.length) {
      o.status = 'done';
      return;
    }
    if (o.status !== 'active' || (d.by !== 'missile' && d.by !== 'mine')) return;
    const kind = d.by === 'missile' ? EntityKind.Missile : EntityKind.Mine;
    const left = s.munitionsLeft(s.playerId)[d.by === 'missile' ? 'missiles' : 'mines'];
    const inFlight = s
      .all()
      .some((e) => e.alive && e.kind === kind && e.team === TEAM_INDEX.player);
    if (left === 0 && !inFlight) this.failObjective(o, `Out of ${d.by}s`);
  }

  private hold(o: ObjectiveState, ok: boolean, need: number, dt: number): void {
    o.held = ok ? o.held + dt : 0;
    o.progress = need > 0 ? Math.min(1, o.held / need) : ok ? 1 : 0;
    if (ok && o.held >= need) o.status = 'done';
  }

  private failObjective(o: ObjectiveState, why: string): void {
    o.status = 'failed';
    o.detail = why;
  }

  private checkEnd(): void {
    const s = this.session;
    const me = s.player();
    const fail = this.def.fail;
    const failed = this.objectives.find((o) => o.status === 'failed');
    let why = '';
    if (!me.alive) {
      why =
        this.kills.get(me.id) === 'crash'
          ? 'You crashed into the planet'
          : 'Your vessel was destroyed';
    } else if (failed) {
      why = failed.detail;
    } else if (fail?.timeLimit !== undefined && s.time > fail.timeLimit) {
      why = 'Out of time';
    } else if (fail?.fuelOut && me.fuel <= 0) {
      why = 'Fuel exhausted';
    } else {
      for (const tag of fail?.protect ?? []) {
        const id = this.ids.get(tag);
        if (id !== undefined && s.entity(id)?.alive === false)
          why = `${this.names.get(id)} was lost`;
      }
    }
    if (why) {
      this.end('lost', why);
    } else if (this.objectives.every((o) => o.status === 'done')) {
      this.end('won', 'All objectives complete');
    }
  }

  private end(outcome: Outcome, reason: string): void {
    this.outcome = outcome;
    this.reason = reason;
    this.session.setThrottle(0);
    this.session.throttleRamp = 0;
  }
}

function inRange(v: number, [lo, hi]: [number, number]): boolean {
  return v >= lo && v <= hi;
}

/** Spawns a ship on `orbit`, with angles measured from polar angle `ref` (rad). */
export function spawnShip(game: Game, cls: number, team: number, o: OrbitDef, ref: number): number {
  const R = game.planet_radius();
  const argPe = (o.argPeDeg ?? 0) * DEG;
  const phase = o.lead !== undefined ? o.lead / (R + o.pe) : (o.phaseDeg ?? 0) * DEG;
  return game.spawn_ship(cls, team, o.pe, o.ap ?? o.pe, ref + argPe, phase - argPe);
}

function applyLoadout(game: Game, id: number, l: LoadoutDef | undefined): void {
  if (!l) return;
  const [missiles, mines] = game.munitions_left(id);
  game.set_loadout(id, l.missiles ?? missiles, l.mines ?? mines, l.fuel ?? 1);
}
