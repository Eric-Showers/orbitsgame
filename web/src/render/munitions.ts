import * as THREE from 'three';
import { EntityKind, SimEventKind, type EntityView, type SimEvent, type Vec3 } from '../sim/bridge';

/** Mine wake-up range (m); mirrors `MINE.trigger_range` in `orbit-sim`. */
const MINE_TRIGGER_RANGE = 5_000;
const FLASH_SECONDS = 0.8;

const TEAM_COLORS = [0x3fd2ff, 0xff4d5e, 0x5dffa8];
const FLAME = 0xffb547;
const BLAST = 0xfff1c2;

interface Marker {
  group: THREE.Group;
  body: THREE.Mesh;
  flame: THREE.Mesh;
  /** Trigger-range ring, shown while a mine sleeps. */
  ring: THREE.LineLoop | null;
}

interface Flash {
  mesh: THREE.LineLoop;
  pos: Vec3;
  born: number;
  /** Final radius in pixels. */
  size: number;
}

/**
 * Draws missiles, mines and blast flashes. Placeholder shapes in pixels,
 * scaled by metres-per-pixel each frame like the ship markers.
 */
export class MunitionLayer {
  private markers = new Map<number, Marker>();
  private flashes: Flash[] = [];

  constructor(private scene: THREE.Scene) {}

  update(entities: readonly EntityView[], local: (p: Vec3) => [number, number], mpp: number): void {
    const seen = new Set<number>();
    const now = performance.now() / 1000;
    for (const e of entities) {
      if (e.kind === EntityKind.Ship || !e.alive) continue;
      seen.add(e.id);
      const m = this.marker(e);
      const [x, y] = local(e.pos);
      m.group.position.set(x, y, 1.5);
      m.group.scale.setScalar(mpp);
      m.group.rotation.z = Math.atan2(e.heading.y, e.heading.x);
      m.flame.visible = e.throttle > 0.01;
      m.flame.scale.set(0.5 + e.throttle * (0.8 + 0.3 * Math.random()), 1, 1);
      if (e.kind === EntityKind.Mine) {
        // A sleeping mine reports no target; once awake it chases one and pulses.
        const awake = e.target !== null;
        const mat = m.body.material as THREE.MeshBasicMaterial;
        mat.opacity = awake ? 0.6 + 0.4 * Math.sin(now * 12) : 0.55;
        if (m.ring) {
          m.ring.visible = !awake;
          // The ring is in metres: undo the group's pixel scale.
          m.ring.scale.setScalar(1 / mpp);
        }
      }
    }
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) {
        this.scene.remove(m.group);
        this.markers.delete(id);
      }
    }

    this.flashes = this.flashes.filter((f) => {
      const t = (now - f.born) / FLASH_SECONDS;
      if (t >= 1) {
        this.scene.remove(f.mesh);
        return false;
      }
      const [fx, fy] = local(f.pos);
      f.mesh.position.set(fx, fy, 2);
      f.mesh.scale.setScalar(mpp * f.size * (0.2 + 0.8 * t));
      (f.mesh.material as THREE.LineBasicMaterial).opacity = 1 - t;
      return true;
    });
  }

  /** Starts blast flashes for detonations and ship kills. */
  showEvents(events: readonly SimEvent[]): void {
    for (const ev of events) {
      const size =
        ev.kind === SimEventKind.Detonation ? 22 : ev.kind === SimEventKind.ShipDestroyed ? 40 : 0;
      if (size === 0) continue;
      const mesh = new THREE.LineLoop(
        unitCircle(48),
        new THREE.LineBasicMaterial({ color: BLAST, transparent: true }),
      );
      this.scene.add(mesh);
      this.flashes.push({ mesh, pos: ev.pos, born: performance.now() / 1000, size });
    }
  }

  private marker(e: EntityView): Marker {
    let m = this.markers.get(e.id);
    if (m) return m;
    const color = TEAM_COLORS[e.team] ?? TEAM_COLORS[2];
    const shape = new THREE.Shape();
    if (e.kind === EntityKind.Missile) {
      shape.moveTo(6, 0).lineTo(-4, 2.5).lineTo(-4, -2.5).closePath();
    } else {
      shape.moveTo(4, 0).lineTo(0, 4).lineTo(-4, 0).lineTo(0, -4).closePath();
    }
    const body = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ color, transparent: true }),
    );
    const flame = new THREE.Mesh(
      new THREE.ShapeGeometry(new THREE.Shape().moveTo(0, 1.8).lineTo(-8, 0).lineTo(0, -1.8)),
      new THREE.MeshBasicMaterial({ color: FLAME, transparent: true, opacity: 0.85 }),
    );
    flame.position.x = -4;
    const group = new THREE.Group();
    group.add(flame, body);
    let ring: THREE.LineLoop | null = null;
    if (e.kind === EntityKind.Mine) {
      ring = new THREE.LineLoop(
        unitCircle(96),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 }),
      );
      ring.geometry.scale(MINE_TRIGGER_RANGE, MINE_TRIGGER_RANGE, 1);
      group.add(ring);
    }
    this.scene.add(group);
    m = { group, body, flame, ring };
    this.markers.set(e.id, m);
    return m;
  }
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
