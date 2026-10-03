import type { Game } from '../wasm-pkg/orbit_wasm.js';
import {
  Attitude,
  BEACON,
  CORVETTE,
  decodeEntities,
  decodeEvents,
  decodeOrbit,
  type EntityView,
  type OrbitView,
  type SimEvent,
} from './bridge';

/** Fixed sim timestep (design doc sec. 2.3). Never feed frame dt into the sim. */
export const SIM_DT = 1 / 60;
export const WARP_LEVELS = [1, 2, 4, 10, 50, 100];
/** Physics warp cap while an engine is firing. */
export const MAX_WARP_UNDER_THRUST = 4;
/** Throttle change per real second while a throttle key is held. */
const THROTTLE_RAMP = 0.5;

export const LOW_ORBIT_ALT = 80_000;

/**
 * One flight: the WASM world, the player's ship, and the client-side time
 * controls (pause, warp, fixed-step accumulator).
 */
export class FlightSession {
  readonly playerId: number;
  paused = false;
  warpIndex = 0;
  throttleRamp = 0;
  private acc = 0;
  private entities: EntityView[] = [];
  private pendingEvents: SimEvent[] = [];

  constructor(readonly game: Game) {
    this.playerId = game.spawn_ship(CORVETTE, 0, LOW_ORBIT_ALT, LOW_ORBIT_ALT, 0, 0);
    // A navigation beacon ~25 km ahead in the same orbit, to practise target modes.
    const r = game.planet_radius() + LOW_ORBIT_ALT;
    game.spawn_ship(BEACON, 2, LOW_ORBIT_ALT, LOW_ORBIT_ALT, 0, 25_000 / r);
    this.refresh();
  }

  get planetRadius(): number {
    return this.game.planet_radius();
  }

  get time(): number {
    return this.game.time();
  }

  player(): EntityView {
    const p = this.entities.find((e) => e.id === this.playerId);
    if (!p) throw new Error('player missing');
    return p;
  }

  entity(id: number | null): EntityView | undefined {
    return id === null ? undefined : this.entities.find((e) => e.id === id);
  }

  all(): readonly EntityView[] {
    return this.entities;
  }

  orbit(id: number): OrbitView | null {
    return decodeOrbit(this.game.orbit(id));
  }

  /** Warp actually applied: requested level, capped while thrusting. */
  effectiveWarp(): number {
    const requested = WARP_LEVELS[this.warpIndex];
    return this.player().throttle > 0 ? Math.min(requested, MAX_WARP_UNDER_THRUST) : requested;
  }

  setWarp(index: number): void {
    this.warpIndex = Math.max(0, Math.min(WARP_LEVELS.length - 1, index));
  }

  setThrottle(t: number): void {
    this.game.set_throttle(this.playerId, Math.max(0, Math.min(1, t)));
    this.refresh();
  }

  setAttitude(mode: Attitude): boolean {
    const ok = this.game.set_attitude(this.playerId, mode);
    this.refresh();
    return ok;
  }

  setRotate(input: number): void {
    this.game.set_rotate(this.playerId, input);
    this.refresh();
  }

  setTarget(id: number | null): void {
    this.game.set_target(this.playerId, id ?? -1);
    this.refresh();
  }

  /** Cycles the player's target through other live ships, nearest first. */
  cycleTarget(): void {
    const me = this.player();
    const others = this.entities
      .filter((e) => e.alive && e.id !== me.id)
      .sort((a, b) => dist2(a, me) - dist2(b, me));
    if (others.length === 0) return this.setTarget(null);
    const i = others.findIndex((e) => e.id === me.target);
    this.setTarget(others[(i + 1) % others.length].id);
  }

  /** Advances by real elapsed seconds; returns sim steps taken. */
  update(realDt: number): number {
    if (this.throttleRamp !== 0 && this.player().alive) {
      this.setThrottle(this.player().throttle + this.throttleRamp * THROTTLE_RAMP * realDt);
    }
    if (this.paused) return 0;
    this.acc += Math.min(realDt, 0.25) * this.effectiveWarp();
    const steps = Math.floor(this.acc / SIM_DT);
    if (steps > 0) {
      this.acc -= steps * SIM_DT;
      this.game.step(steps, SIM_DT);
      this.pendingEvents.push(...decodeEvents(this.game.take_events()));
      this.refresh();
    }
    return steps;
  }

  takeEvents(): SimEvent[] {
    const ev = this.pendingEvents;
    this.pendingEvents = [];
    return ev;
  }

  private refresh(): void {
    this.entities = decodeEntities(this.game.entities());
  }
}

function dist2(a: EntityView, b: EntityView): number {
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;
  const dz = a.pos.z - b.pos.z;
  return dx * dx + dy * dy + dz * dz;
}
