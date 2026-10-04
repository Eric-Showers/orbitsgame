import { EntityKind, SHIP_CLASS_NAMES, type Vec3 } from '../sim/bridge';
import type { FlightSession } from '../sim/session';
import { fmtDistance } from '../ui/format';

export type FocusRef =
  { kind: 'ship' } | { kind: 'planet' } | { kind: 'entity'; id: number } | { kind: 'free' };

/** Fraction of the view height the camera pans per second while a pan key is held. */
const PAN_RATE = 0.6;
const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Where the camera looks: a focus (your ship, the planet, any other ship or beacon, or a
 * free-floating point) plus an offset from it. Around a ship the offset is stored in that
 * ship's radial frame (a = away from the planet, b = along-track), so a look-ahead or
 * look-down stays put as the ship goes round. Around the planet or a free point it is plain
 * world x/y.
 */
export class CameraRig {
  focus: FocusRef = { kind: 'ship' };
  private offset = { a: 0, b: 0 };
  private freePos: Vec3 = { ...ORIGIN };
  /** Held pan direction in screen axes: x right, y up. */
  readonly pan = { x: 0, y: 0 };

  /** The focus actually in effect: a vanished entity falls back to the player's ship. */
  private resolved(session: FlightSession): FocusRef {
    const f = this.focus;
    if (f.kind === 'entity' && !session.entity(f.id)?.alive) return { kind: 'ship' };
    return f;
  }

  private base(session: FlightSession, f: FocusRef): Vec3 {
    switch (f.kind) {
      case 'planet':
        return ORIGIN;
      case 'free':
        return this.freePos;
      case 'entity':
        return session.entity(f.id)?.pos ?? session.player().pos;
      default:
        return session.player().pos;
    }
  }

  /** Unit radial and tangential vectors at `p`; fixed axes at the planet's centre. */
  private frame(p: Vec3): { r: [number, number]; t: [number, number] } {
    const n = Math.hypot(p.x, p.y);
    if (n < 1) return { r: [1, 0], t: [0, 1] };
    const r: [number, number] = [p.x / n, p.y / n];
    return { r, t: [-r[1], r[0]] };
  }

  private bodyFocus(f: FocusRef): boolean {
    return f.kind === 'ship' || f.kind === 'entity';
  }

  /** World point at the centre of the view. */
  center(session: FlightSession): Vec3 {
    const f = this.resolved(session);
    const base = this.base(session, f);
    const { a, b } = this.offset;
    if (!this.bodyFocus(f)) return { x: base.x + a, y: base.y + b, z: 0 };
    const { r, t } = this.frame(base);
    return { x: base.x + a * r[0] + b * t[0], y: base.y + a * r[1] + b * t[1], z: 0 };
  }

  /** Applies held pan keys / drags: `dx`, `dy` are screen-axis world metres. */
  panBy(session: FlightSession, dx: number, dy: number): void {
    const f = this.resolved(session);
    if (f.kind === 'free') {
      this.freePos = { x: this.freePos.x + dx, y: this.freePos.y + dy, z: 0 };
    } else if (this.bodyFocus(f)) {
      const { r, t } = this.frame(this.base(session, f));
      this.offset.a += dx * r[0] + dy * r[1];
      this.offset.b += dx * t[0] + dy * t[1];
    } else {
      this.offset.a += dx;
      this.offset.b += dy;
    }
  }

  step(session: FlightSession, dt: number, viewHeight: number): void {
    if (this.pan.x === 0 && this.pan.y === 0) return;
    const d = viewHeight * PAN_RATE * Math.min(dt, 0.1);
    this.panBy(session, this.pan.x * d, this.pan.y * d);
  }

  /** Drops the offset so the view sits on the focus again. */
  recentre(session: FlightSession): void {
    this.offset = { a: 0, b: 0 };
    if (this.resolved(session).kind === 'free') this.freePos = { ...ORIGIN };
  }

  set(focus: FocusRef): void {
    this.focus = focus;
    this.offset = { a: 0, b: 0 };
  }

  /** Free-floating camera: detaches at the current view centre, or returns to the ship. */
  toggleFree(session: FlightSession): void {
    if (this.resolved(session).kind === 'free') return this.set({ kind: 'ship' });
    this.freePos = this.center(session);
    this.set({ kind: 'free' });
  }

  /** Ship, planet, then every other live ship or beacon in a stable order. */
  private ring(session: FlightSession): FocusRef[] {
    const me = session.player().id;
    const others = session
      .all()
      .filter((e) => e.alive && e.kind === EntityKind.Ship && e.id !== me)
      .sort((a, b) => a.id - b.id);
    return [
      { kind: 'ship' },
      { kind: 'planet' },
      ...others.map((e): FocusRef => ({ kind: 'entity', id: e.id })),
    ];
  }

  /** Steps through the ring; from a free camera `dir` 1 starts at the ship. */
  cycle(session: FlightSession, dir: 1 | -1): void {
    const ring = this.ring(session);
    const cur = this.resolved(session);
    const i = ring.findIndex((f) => sameFocus(f, cur));
    const next = i < 0 ? 0 : (i + dir + ring.length) % ring.length;
    this.set(ring[next]);
  }

  /** Follows the player's current target, if there is one. */
  focusTarget(session: FlightSession): boolean {
    const t = session.entity(session.player().target);
    if (!t?.alive) return false;
    this.set({ kind: 'entity', id: t.id });
    return true;
  }

  describe(session: FlightSession): string {
    const f = this.resolved(session);
    let name: string;
    if (f.kind === 'planet') name = 'PLANET';
    else if (f.kind === 'free') name = 'FREE';
    else if (f.kind === 'entity') {
      const e = session.entity(f.id);
      name = `${SHIP_CLASS_NAMES[e?.shipClass ?? 0] ?? 'SHIP'} #${f.id}`.toUpperCase();
    } else name = 'SHIP';
    const { a, b } = this.offset;
    if (f.kind === 'free' || (a === 0 && b === 0)) return name;
    return this.bodyFocus(f)
      ? `${name} · RAD ${fmtSigned(a)} · TAN ${fmtSigned(b)}`
      : `${name} · X ${fmtSigned(a)} · Y ${fmtSigned(b)}`;
  }
}

function sameFocus(a: FocusRef, b: FocusRef): boolean {
  return a.kind === b.kind && (a.kind !== 'entity' || a.id === (b as typeof a).id);
}

function fmtSigned(m: number): string {
  return `${m < 0 ? '−' : '+'}${fmtDistance(Math.abs(m))}`;
}
