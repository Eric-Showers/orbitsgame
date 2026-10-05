import * as THREE from 'three';
import { Game } from '../wasm-pkg/orbit_wasm.js';
import { EntityKind, type EntityView, type Vec3 } from '../sim/bridge';
import type { FlightSession } from '../sim/session';
import type { ViewLayer } from './view';

const TEAM_COLORS = [0x3fd2ff, 0xff4d5e, 0x5dffa8];
/** Sim seconds between trail samples, and samples kept. */
const TRAIL_STEP = 2;
const TRAIL_LEN = 48;
/** Predicted closest approach is extrapolated at most this far ahead (s). */
const LEAD_MAX = 900;
const MAX_TRACKS = 24;
const CROSS_PX = 7;
const RING_SEGMENTS = 64;
/** Blast ring is backed by a fixed-size halo when its true radius is smaller than this (px). */
const HALO_PX = 9;
const HIT = 0xffb547;

interface Track {
  line: THREE.LineSegments;
  trail: THREE.Line;
  ring: THREE.LineLoop;
  halo: THREE.LineLoop;
  history: Vec3[];
  lastSample: number;
}

/**
 * Intercept graphics for missiles and awake mines: a trail behind each, a line to its
 * target, a cross where the pair is predicted to pass closest, and the warhead's kill
 * radius around that point (visible when zoomed in on a fight).
 */
export class InterceptLayer implements ViewLayer {
  private tracks = new Map<number, Track>();
  private blast: number[] | null = null;

  constructor(private scene: THREE.Scene) {}

  update(session: FlightSession, local: (p: Vec3) => [number, number], mpp: number): void {
    const seen = new Set<number>();
    let n = 0;
    for (const e of session.all()) {
      if (
        !e.alive ||
        (e.kind !== EntityKind.Missile && e.kind !== EntityKind.Mine && e.kind !== EntityKind.Kv)
      )
        continue;
      if (++n > MAX_TRACKS) break;
      seen.add(e.id);
      this.draw(this.track(e), e, session, local, mpp);
    }
    for (const [id, t] of this.tracks) {
      if (seen.has(id)) continue;
      for (const o of [t.line, t.trail, t.ring, t.halo]) {
        this.scene.remove(o);
        o.geometry.dispose();
      }
      this.tracks.delete(id);
    }
  }

  private killRadius(kind: EntityKind): number {
    this.blast ??= [0, 1, 2, 3].map((k) => Game.munition_stats(k)[4] ?? 0);
    return this.blast[kind] ?? 0;
  }

  private draw(
    t: Track,
    e: EntityView,
    session: FlightSession,
    local: (p: Vec3) => [number, number],
    mpp: number,
  ): void {
    const time = session.time;
    if (time - t.lastSample >= TRAIL_STEP || time < t.lastSample) {
      t.lastSample = time;
      t.history.push({ ...e.pos });
      if (t.history.length > TRAIL_LEN) t.history.shift();
    }
    const trail = t.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    t.history.forEach((p, i) => {
      const [x, y] = local(p);
      trail.setXYZ(i, x, y, 1.2);
    });
    const [ex, ey] = local(e.pos);
    trail.setXYZ(t.history.length, ex, ey, 1.2);
    trail.needsUpdate = true;
    t.trail.geometry.setDrawRange(0, t.history.length + 1);
    t.trail.geometry.computeBoundingSphere();

    const target = session.entity(e.target);
    const live = target?.alive === true;
    t.line.visible = live;
    t.ring.visible = live;
    t.halo.visible = false;
    if (!live || !target) return;

    const rel = { x: target.pos.x - e.pos.x, y: target.pos.y - e.pos.y, z: 0 };
    const relV = { x: target.vel.x - e.vel.x, y: target.vel.y - e.vel.y, z: 0 };
    const v2 = relV.x * relV.x + relV.y * relV.y;
    const lead =
      v2 > 1e-6 ? Math.max(0, Math.min(LEAD_MAX, -(rel.x * relV.x + rel.y * relV.y) / v2)) : 0;
    const hit = {
      x: target.pos.x + target.vel.x * lead,
      y: target.pos.y + target.vel.y * lead,
      z: 0,
    };
    const shot = { x: e.pos.x + e.vel.x * lead, y: e.pos.y + e.vel.y * lead, z: 0 };
    const [tx, ty] = local(target.pos);
    const [hx, hy] = local(hit);
    const [sx, sy] = local(shot);
    const c = CROSS_PX * mpp;
    const p = t.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const seg = [
      [ex, ey, tx, ty], // munition to target
      [ex, ey, sx, sy], // predicted flight
      [hx - c, hy, hx + c, hy], // closest-approach cross
      [hx, hy - c, hx, hy + c],
      [sx, sy, hx, hy], // predicted miss vector
    ];
    seg.forEach(([ax, ay, bx, by], i) => {
      p.setXYZ(2 * i, ax, ay, 1.3);
      p.setXYZ(2 * i + 1, bx, by, 1.3);
    });
    p.needsUpdate = true;
    t.line.geometry.computeBoundingSphere();

    const blast = Math.max(this.killRadius(e.kind), 1);
    t.ring.position.set(hx, hy, 1.3);
    t.ring.scale.setScalar(blast);
    // Predicted pass inside the blast radius: the ring and miss vector go amber.
    const inside = Math.hypot(hit.x - shot.x, hit.y - shot.y) <= blast;
    const tint = inside ? HIT : (TEAM_COLORS[e.team] ?? TEAM_COLORS[2]);
    (t.ring.material as THREE.LineBasicMaterial).color.setHex(tint);
    (t.line.material as THREE.LineBasicMaterial).color.setHex(
      TEAM_COLORS[e.team] ?? TEAM_COLORS[2],
    );
    t.halo.visible = blast < HALO_PX * mpp;
    t.halo.position.set(hx, hy, 1.3);
    t.halo.scale.setScalar(HALO_PX * mpp);
    (t.halo.material as THREE.LineBasicMaterial).color.setHex(tint);
  }

  private track(e: EntityView): Track {
    let t = this.tracks.get(e.id);
    if (t) return t;
    const color = TEAM_COLORS[e.team] ?? TEAM_COLORS[2];
    const line = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array(10 * 3), 3),
      ),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }),
    );
    const trail = new THREE.Line(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array((TRAIL_LEN + 1) * 3), 3),
      ),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }),
    );
    const ring = new THREE.LineLoop(
      unitCircle(RING_SEGMENTS),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }),
    );
    const halo = new THREE.LineLoop(
      unitCircle(24),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3 }),
    );
    for (const o of [line, trail, ring, halo]) {
      o.frustumCulled = false;
      this.scene.add(o);
    }
    t = { line, trail, ring, halo, history: [], lastSample: -Infinity };
    this.tracks.set(e.id, t);
    return t;
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
