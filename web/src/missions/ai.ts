import { Attitude, EntityKind, len, sub } from '../sim/bridge';
import type { FlightSession } from '../sim/session';
import type { AiDef } from './types';

/**
 * Drives one hostile ship from its mission `AiDef`, issuing the same commands
 * the player can (target, launch, drop, attitude, throttle). Runs once per
 * frame against the player; every number it uses comes from the data.
 */
export class HostileAi {
  private nextShot: number;
  private nextDrop: number;
  private evadeUntil = -Infinity;
  private evading = false;
  private evadeOut = true;

  constructor(
    readonly id: number,
    private def: AiDef,
    spawnTime: number,
  ) {
    this.nextShot = spawnTime + (def.gunner?.firstShotDelay ?? 0);
    this.nextDrop = spawnTime + (def.miner?.firstDropDelay ?? 0);
  }

  act(s: FlightSession, quarry: number): void {
    const me = s.entity(this.id);
    if (!me?.alive) return;
    const now = s.time;
    const prey = s.entity(quarry);
    const range = prey?.alive ? len(sub(prey.pos, me.pos)) : Infinity;
    const g = s.game;

    const { gunner, miner, evade } = this.def;
    if (gunner && prey?.alive && now >= this.nextShot && range <= gunner.range) {
      g.set_target(this.id, quarry);
      if (g.launch_missile(this.id) >= 0) this.nextShot = now + gunner.cooldown;
    }
    if (miner && now >= this.nextDrop && range <= miner.range) {
      if (g.drop_mine(this.id) >= 0) this.nextDrop = now + miner.cooldown;
    }
    if (evade) {
      const threatened = s
        .all()
        .some(
          (e) =>
            e.alive &&
            e.kind === EntityKind.Missile &&
            e.target === this.id &&
            len(sub(e.pos, me.pos)) <= evade.warnRange,
        );
      if (threatened && !this.evading) {
        // Alternate sides so repeated dodges do not walk the orbit one way.
        g.set_attitude(this.id, this.evadeOut ? Attitude.RadialOut : Attitude.RadialIn);
        g.set_throttle(this.id, evade.throttle);
        this.evadeOut = !this.evadeOut;
        this.evading = true;
        this.evadeUntil = now + evade.burnSeconds;
      } else if (this.evading && now >= this.evadeUntil) {
        g.set_throttle(this.id, 0);
        this.evading = false;
      }
    }
  }
}
