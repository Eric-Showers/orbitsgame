import * as THREE from 'three';
import { Game } from '../wasm-pkg/orbit_wasm.js';
import { EntityKind, SimEventKind, type EntityView, type SimEvent, type Vec3 } from '../sim/bridge';
import type { FlightSession } from '../sim/session';
import { fmtDistance } from '../ui/format';
import type { ViewLayer } from './view';

const AMBER = 0xffb547;
const PUFF = 0xffe9a8;
const Z = 1.35;
/** Wall-clock seconds a launch burst and an RCS puff stay visible. */
const BURST_SECONDS = 1.1;
const PUFF_SECONDS = 0.55;
const MAX_PUFFS = 64;
/** RCS delta-v spent in one frame (m/s) that counts as a thruster firing. */
const RCS_EPS = 1e-4;
/** Braking shows once closing speed exceeds the cap by this fraction. */
const BRAKE_MARGIN = 1.05;
const CHEVRONS = 3;
const KV_STATS = 3;
const MINE_STATS = 2;

interface KvMark {
  /** Where the mine converted into the vehicle: a small cross that stays put. */
  launch: THREE.LineSegments;
  launchPos: Vec3;
  brake: THREE.LineSegments;
  rcs: number;
  vel: Vec3;
  flip: number;
}

interface Burst {
  ring: THREE.LineLoop;
  spokes: THREE.LineSegments;
  pos: Vec3;
  born: number;
}

interface Puff {
  pos: Vec3;
  dir: [number, number];
  born: number;
}

/**
 * Kinetic-vehicle effects on top of the intercept lines: the 2.2 km launch range around
 * an awake mine, a burst where the mine converts, a launch-point cross, braking chevrons
 * while the vehicle sheds closing speed, RCS puffs when its thrusters fire, and a
 * closing-speed and miss-distance tag. Everything is read from the entity snapshot.
 */
export class KvLayer implements ViewLayer {
  private ranges = new Map<number, THREE.LineSegments>();
  private marks = new Map<number, KvMark>();
  private bursts: Burst[] = [];
  private puffs: Puff[] = [];
  private mineIds = new Set<number>();
  private pending: SimEvent[] = [];
  private tags = new Set<string>();
  private readonly puffLines: THREE.LineSegments;
  private stats: { range: number; cap: number } | null = null;

  constructor(
    private scene: THREE.Scene,
    private placeLabel: (key: string, x: number, y: number, text: string | null) => void,
  ) {
    this.puffLines = new THREE.LineSegments(
      new THREE.BufferGeometry()
        .setAttribute(
          'position',
          new THREE.Float32BufferAttribute(new Float32Array(MAX_PUFFS * 2 * 3), 3),
        )
        .setAttribute(
          'color',
          new THREE.Float32BufferAttribute(new Float32Array(MAX_PUFFS * 2 * 3), 3),
        ),
      new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending }),
    );
    this.puffLines.frustumCulled = false;
    scene.add(this.puffLines);
  }

  /** Queues launch bursts; the entity kinds are resolved on the next update. */
  showEvents(events: readonly SimEvent[]): void {
    for (const ev of events) if (ev.kind === SimEventKind.MissileLaunched) this.pending.push(ev);
  }

  update(session: FlightSession, local: (p: Vec3) => [number, number], mpp: number): void {
    const now = performance.now() / 1000;
    this.stats ??= {
      range: Game.munition_stats(MINE_STATS)[17] ?? 0,
      cap: Game.munition_stats(KV_STATS)[3] ?? 0,
    };
    const { range, cap } = this.stats;
    const liveMines = new Set<number>();
    const liveKvs = new Set<number>();
    const tags = new Set<string>();

    for (const e of session.all()) {
      if (!e.alive) continue;
      if (e.kind === EntityKind.Mine) {
        liveMines.add(e.id);
        this.drawRange(e, range, local);
      } else if (e.kind === EntityKind.Kv) {
        liveKvs.add(e.id);
        this.drawKv(e, session, local, mpp, now, cap, tags);
      }
    }

    // A launch event's entity is already a vehicle by the time the view sees it.
    for (const ev of this.pending) {
      if (this.marks.has(ev.id) || this.mineIds.has(ev.id)) this.burst(ev.pos, now);
    }
    this.pending.length = 0;
    this.mineIds = liveMines;

    this.drawBursts(local, mpp, now);
    this.drawPuffs(local, mpp, now);

    for (const [id, line] of this.ranges) {
      if (liveMines.has(id)) continue;
      this.drop(line);
      this.ranges.delete(id);
    }
    for (const [id, m] of this.marks) {
      if (liveKvs.has(id)) continue;
      this.drop(m.launch);
      this.drop(m.brake);
      this.marks.delete(id);
    }
    for (const key of this.tags) if (!tags.has(key)) this.placeLabel(key, 0, 0, null);
    this.tags = tags;
  }

  /** Faint dashed ring at the launch range, shown while a mine is awake and closing. */
  private drawRange(e: EntityView, range: number, local: (p: Vec3) => [number, number]): void {
    let ring = this.ranges.get(e.id);
    if (!ring) {
      ring = new THREE.LineSegments(
        dashedCircle(72),
        new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.35 }),
      );
      ring.frustumCulled = false;
      this.scene.add(ring);
      this.ranges.set(e.id, ring);
    }
    ring.visible = e.target !== null;
    const [x, y] = local(e.pos);
    ring.position.set(x, y, Z);
    ring.scale.setScalar(range);
  }

  private drawKv(
    e: EntityView,
    session: FlightSession,
    local: (p: Vec3) => [number, number],
    mpp: number,
    now: number,
    cap: number,
    tags: Set<string>,
  ): void {
    let m = this.marks.get(e.id);
    const rcs = session.game.rcs_delta_v(e.id);
    if (!m) {
      const launch = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute(
          'position',
          new THREE.Float32BufferAttribute(new Float32Array(4 * 3), 3),
        ),
        new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.7 }),
      );
      const brake = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute(
          'position',
          new THREE.Float32BufferAttribute(new Float32Array(CHEVRONS * 4 * 3), 3),
        ),
        new THREE.LineBasicMaterial({ color: AMBER, transparent: true }),
      );
      for (const o of [launch, brake]) {
        o.frustumCulled = false;
        this.scene.add(o);
      }
      m = { launch, launchPos: { ...e.pos }, brake, rcs, vel: { ...e.vel }, flip: 1 };
      this.marks.set(e.id, m);
    }

    const [ex, ey] = local(e.pos);
    const c = 4 * mpp;
    const [lx, ly] = local(m.launchPos);
    setSegments(m.launch, [
      [lx - c, ly - c, lx + c, ly + c],
      [lx - c, ly + c, lx + c, ly - c],
    ]);

    // RCS: a thruster firing spends delta-v; push the puff opposite the velocity change.
    if (rcs >= 0 && m.rcs - rcs > RCS_EPS) {
      const dvx = e.vel.x - m.vel.x;
      const dvy = e.vel.y - m.vel.y;
      const len = Math.hypot(dvx, dvy);
      let dir: [number, number];
      if (len > 1e-6) {
        dir = [-dvx / len, -dvy / len];
      } else {
        dir = [-e.heading.y * m.flip, e.heading.x * m.flip];
        m.flip = -m.flip;
      }
      this.puffs.push({ pos: { ...e.pos }, dir, born: now });
      if (this.puffs.length > MAX_PUFFS) this.puffs.shift();
    }
    m.rcs = rcs;
    m.vel = { ...e.vel };

    const target = session.entity(e.target);
    const live = target?.alive === true;
    m.brake.visible = false;
    if (!live || !target) return;

    const rx = target.pos.x - e.pos.x;
    const ry = target.pos.y - e.pos.y;
    const range = Math.hypot(rx, ry);
    const ux = range > 0 ? rx / range : 1;
    const uy = range > 0 ? ry / range : 0;
    const vx = e.vel.x - target.vel.x;
    const vy = e.vel.y - target.vel.y;
    const closing = vx * ux + vy * uy;

    const braking = e.throttle > 0 && closing > cap * BRAKE_MARGIN;
    if (braking) {
      // Chevrons ahead of the nose, pointing back at the vehicle, rippling inward.
      const phase = (now * 2.5) % 1;
      const segs: number[][] = [];
      const nx = -uy;
      const ny = ux;
      for (let k = 0; k < CHEVRONS; k++) {
        const d = (12 + 7 * (k + 1 - phase)) * mpp;
        const s = 4 * mpp;
        const ax = ex + ux * d;
        const ay = ey + uy * d;
        segs.push([ax, ay, ax + ux * s + nx * s, ay + uy * s + ny * s]);
        segs.push([ax, ay, ax + ux * s - nx * s, ay + uy * s - ny * s]);
      }
      setSegments(m.brake, segs);
      m.brake.visible = true;
    }

    // Closest-approach miss, from the same extrapolation as the intercept cross.
    const rvx = -vx;
    const rvy = -vy;
    const v2 = rvx * rvx + rvy * rvy;
    const t = v2 > 1e-6 ? Math.max(0, -(rx * rvx + ry * rvy) / v2) : 0;
    const miss = Math.hypot(rx + rvx * t, ry + rvy * t);
    const key = `kv-${e.id}`;
    const speed = `${Math.round(closing)} m/s`;
    const status = braking ? `BRAKE ${speed}` : `CLOSE ${speed}`;
    this.placeLabel(key, ex + 10 * mpp, ey + 12 * mpp, `KV ${status} · MISS ${fmtDistance(miss)}`);
    tags.add(key);
  }

  private burst(pos: Vec3, now: number): void {
    const ring = new THREE.LineLoop(
      unitCircle(48),
      new THREE.LineBasicMaterial({ color: AMBER, transparent: true }),
    );
    const spokes = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array(8 * 2 * 3), 3),
      ),
      new THREE.LineBasicMaterial({ color: AMBER, transparent: true }),
    );
    for (const o of [ring, spokes]) {
      o.frustumCulled = false;
      this.scene.add(o);
    }
    this.bursts.push({ ring, spokes, pos: { ...pos }, born: now });
  }

  private drawBursts(local: (p: Vec3) => [number, number], mpp: number, now: number): void {
    this.bursts = this.bursts.filter((b) => {
      const t = (now - b.born) / BURST_SECONDS;
      if (t >= 1) {
        this.drop(b.ring);
        this.drop(b.spokes);
        return false;
      }
      const [x, y] = local(b.pos);
      const r = (6 + 34 * t) * mpp;
      b.ring.position.set(x, y, Z);
      b.ring.scale.setScalar(r);
      const segs: number[][] = [];
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        segs.push([x + ca * r * 0.5, y + sa * r * 0.5, x + ca * r * 1.3, y + sa * r * 1.3]);
      }
      setSegments(b.spokes, segs);
      (b.ring.material as THREE.LineBasicMaterial).opacity = 1 - t;
      (b.spokes.material as THREE.LineBasicMaterial).opacity = 1 - t;
      return true;
    });
  }

  private drawPuffs(local: (p: Vec3) => [number, number], mpp: number, now: number): void {
    this.puffs = this.puffs.filter((p) => now - p.born < PUFF_SECONDS);
    const pos = this.puffLines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.puffLines.geometry.getAttribute('color') as THREE.BufferAttribute;
    const base = new THREE.Color(PUFF);
    this.puffs.forEach((p, i) => {
      const t = (now - p.born) / PUFF_SECONDS;
      const [x, y] = local(p.pos);
      const a = (5 + 7 * t) * mpp;
      const b = (2 + 12 * t) * mpp;
      pos.setXYZ(2 * i, x + p.dir[0] * a, y + p.dir[1] * a, Z);
      pos.setXYZ(2 * i + 1, x + p.dir[0] * (a + b), y + p.dir[1] * (a + b), Z);
      const k = 1 - t;
      col.setXYZ(2 * i, base.r * k, base.g * k, base.b * k);
      col.setXYZ(2 * i + 1, 0, 0, 0);
    });
    pos.needsUpdate = col.needsUpdate = true;
    this.puffLines.geometry.setDrawRange(0, this.puffs.length * 2);
    this.puffLines.geometry.computeBoundingSphere();
  }

  private drop(o: THREE.Line | THREE.LineSegments): void {
    this.scene.remove(o);
    o.geometry.dispose();
    (o.material as THREE.Material).dispose();
  }
}

function setSegments(line: THREE.LineSegments, segs: number[][]): void {
  const p = line.geometry.getAttribute('position') as THREE.BufferAttribute;
  segs.forEach(([ax, ay, bx, by], i) => {
    p.setXYZ(2 * i, ax, ay, Z);
    p.setXYZ(2 * i + 1, bx, by, Z);
  });
  p.needsUpdate = true;
  line.geometry.setDrawRange(0, segs.length * 2);
  line.geometry.computeBoundingSphere();
}

function unitCircle(n: number): THREE.BufferGeometry {
  const pts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts[3 * i] = Math.cos(a);
    pts[3 * i + 1] = Math.sin(a);
  }
  return new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute(pts, 3),
  );
}

/** Unit circle drawn as alternating dashes. */
function dashedCircle(n: number): THREE.BufferGeometry {
  const pts: number[] = [];
  for (let i = 0; i < n; i += 2) {
    for (const j of [i, i + 1]) {
      const a = (2 * Math.PI * j) / n;
      pts.push(Math.cos(a), Math.sin(a), 0);
    }
  }
  return new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute(pts, 3),
  );
}
