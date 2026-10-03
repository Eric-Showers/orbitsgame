import * as THREE from 'three';
import { EntityKind, SimEventKind, type EntityView, type SimEvent, type Vec3 } from '../sim/bridge';

/** Mine wake-up range (m); mirrors `MINE.trigger_range` in `orbit-sim`. */
const MINE_TRIGGER_RANGE = 5_000;
const FLASH_SECONDS = 0.8;

const TEAM_COLORS = [0x3fd2ff, 0xff4d5e, 0x5dffa8];
const BLAST = 0xfff1c2;

interface Ring {
  /** Trigger-range ring, shown while a mine sleeps. */
  ring: THREE.LineLoop;
}

interface Flash {
  mesh: THREE.LineLoop;
  pos: Vec3;
  born: number;
  /** Final radius in pixels. */
  size: number;
}

/**
 * Munition overlays: mine trigger-range rings and blast flashes. The missiles
 * and mines themselves are drawn by the vessel sprite layer.
 */
export class MunitionLayer {
  private rings = new Map<number, Ring>();
  private flashes: Flash[] = [];

  constructor(private scene: THREE.Scene) {}

  update(entities: readonly EntityView[], local: (p: Vec3) => [number, number], mpp: number): void {
    const seen = new Set<number>();
    const now = performance.now() / 1000;
    for (const e of entities) {
      if (e.kind !== EntityKind.Mine || !e.alive) continue;
      seen.add(e.id);
      const { ring } = this.ring(e);
      const [x, y] = local(e.pos);
      ring.position.set(x, y, 1.4);
      // A sleeping mine reports no target; once awake it chases one and the ring goes.
      ring.visible = e.target === null;
    }
    for (const [id, r] of this.rings) {
      if (!seen.has(id)) {
        this.scene.remove(r.ring);
        r.ring.geometry.dispose();
        this.rings.delete(id);
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

  private ring(e: EntityView): Ring {
    let r = this.rings.get(e.id);
    if (r) return r;
    const color = TEAM_COLORS[e.team] ?? TEAM_COLORS[2];
    const ring = new THREE.LineLoop(
      unitCircle(96),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 }),
    );
    ring.geometry.scale(MINE_TRIGGER_RANGE, MINE_TRIGGER_RANGE, 1);
    this.scene.add(ring);
    r = { ring };
    this.rings.set(e.id, r);
    return r;
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
