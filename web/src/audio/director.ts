import type { AdvisoryEvent } from '../advisor/channel';
import type { PilotEvent } from '../autopilot/pilot';
import type { Status } from '../autopilot/types';
import { SimEventKind, len, sub, type SimEvent, type Vec3 } from '../sim/bridge';
import { SFX, type SfxConfig } from './config';
import type { SfxSink } from './mixer';

/** What the director needs of the flight each frame. */
export interface FlightFrame {
  /** Real seconds since the previous frame. */
  dt: number;
  /** Sim clock (s). */
  simTime: number;
  paused: boolean;
  alive: boolean;
  warp: number;
  throttle: number;
  heading: Vec3;
  pos: Vec3;
  /** Running autopilot maneuver status, if any. */
  pilotStatus: Status | null;
}

/**
 * Turns flight, sim, advisory and autopilot activity into sound requests on a
 * sink. Pure logic with no audio dependency, so it is testable headlessly.
 * It only listens; it never touches the sim.
 */
export class SoundDirector {
  private lastPlayed = new Map<string, number>();
  private clock = 0;
  private prevHeading: Vec3 | null = null;
  private prevSim = 0;
  private playerPos: Vec3 = { x: 0, y: 0, z: 0 };
  private lastTick = Infinity;

  constructor(
    private sink: SfxSink,
    private cfg: SfxConfig = SFX,
  ) {}

  /** A new flight starts silent. */
  reset(): void {
    this.prevHeading = null;
    this.lastTick = Infinity;
    this.lastPlayed.clear();
    this.sink.setLoop('engine', 0);
    this.sink.setLoop('rcs', 0);
  }

  private play(id: string | undefined, gain = 1): void {
    if (!id) return;
    const gap = this.cfg.cooldown[id] ?? this.cfg.cooldown.default ?? 0;
    const last = this.lastPlayed.get(id);
    if (last !== undefined && this.clock - last < gap) return;
    this.lastPlayed.set(id, this.clock);
    this.sink.play(id, gain);
  }

  /** Shipboard sounds for sim events, quieter the farther from the player. */
  onSimEvents(events: readonly SimEvent[]): void {
    const { refMeters, minGain } = this.cfg.distance;
    for (const ev of events) {
      const id = this.cfg.simEvents[SimEventKind[ev.kind]];
      const d = len(sub(ev.pos, this.playerPos));
      this.play(id, Math.max(minGain, Math.min(1, refMeters / Math.max(d, 1))));
    }
  }

  /** Cockpit alarms and acknowledgement blips for lines the ship AI speaks. */
  onAdvisory(ev: AdvisoryEvent): void {
    const a = this.cfg.advisory;
    if (a.ignorePrefixes.some((p) => ev.id.startsWith(p))) return;
    const id =
      a.lines[ev.id] ??
      a.priorities[ev.priority] ??
      (ev.id.startsWith(a.ackPrefix) ? a.ackSound : undefined);
    this.play(id);
  }

  onPilot(ev: PilotEvent): void {
    const p = this.cfg.pilot;
    switch (ev.kind) {
      case 'assist':
        return this.play(ev.on ? p.assistOn : p.assistOff);
      case 'phase':
        return ev.phase === 'burn' ? this.play(p.burnPhase) : undefined;
      case 'aborted':
        return ev.cause === 'assist-off' ? undefined : this.play(p.aborted);
      default:
        return this.play(p[ev.kind]);
    }
  }

  /** Continuous engine and thruster sound, plus maneuver countdown ticks. Call every frame. */
  onFrame(f: FlightFrame): void {
    this.clock += f.dt;
    this.playerPos = f.pos;
    const { engine, rcs } = this.cfg.loops;

    const live = f.alive && !f.paused;
    const engineOn = live && f.warp <= engine.maxWarp;
    this.sink.setLoop('engine', engineOn ? f.throttle : 0, f.throttle);

    let rate = 0;
    const dSim = f.simTime - this.prevSim;
    if (this.prevHeading && dSim > 0) {
      const h = this.prevHeading;
      const dot = h.x * f.heading.x + h.y * f.heading.y + h.z * f.heading.z;
      const norm = Math.hypot(h.x, h.y, h.z) * Math.hypot(f.heading.x, f.heading.y, f.heading.z);
      rate = norm > 0 ? Math.acos(Math.max(-1, Math.min(1, dot / norm))) / dSim : 0;
    }
    this.prevHeading = f.heading;
    this.prevSim = f.simTime;
    const rcsOn = live && f.warp <= rcs.maxWarp && rate > rcs.deadRadPerSec;
    this.sink.setLoop('rcs', rcsOn ? Math.min(1, rate / rcs.fullRateRadPerSec) : 0);

    this.countdown(f);
  }

  /** Ticks each second over the last seconds of a coast before the ship AI lights the burn. */
  private countdown(f: FlightFrame): void {
    const t = this.cfg.timer;
    const st = f.pilotStatus;
    const counting =
      st &&
      st.state === 'running' &&
      st.phase.endsWith('coast') &&
      f.warp <= t.maxWarp &&
      !f.paused;
    if (!counting || st.coast > t.countdownSeconds) {
      this.lastTick = Infinity;
      return;
    }
    const n = Math.ceil(st.coast / t.tickEverySeconds);
    if (n < this.lastTick && n > 0) {
      this.play(st.coast <= t.urgentBelowSeconds ? t.urgentTick : t.tick);
    }
    this.lastTick = n;
  }
}
