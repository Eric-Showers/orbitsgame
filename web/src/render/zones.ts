import * as THREE from 'three';
import type { MissionRun } from '../missions/run';
import type { FlightSession } from '../sim/session';
import type { Vec3 } from '../sim/bridge';
import type { ViewLayer } from './view';

const SEGMENTS = 2048;
const BAND = 0xffb547;
const GOAL = 0x5dffa8;

/**
 * Draws the active objectives' geometry: altitude bands (orbit and mine-zone
 * objectives) as planet-centred rings, and rendezvous range as a ring around
 * the target. Unit circles scaled per frame, so nothing is rebuilt.
 */
export class ZoneLayer implements ViewLayer {
  private rings: THREE.LineLoop[] = [];
  private used = 0;

  constructor(
    private scene: THREE.Scene,
    private run: () => MissionRun | null,
  ) {}

  update(session: FlightSession, local: (p: Vec3) => [number, number]): void {
    this.used = 0;
    const run = this.run();
    if (run && run.session === session && run.outcome === 'running') {
      const R = session.planetRadius;
      const centre = local({ x: 0, y: 0, z: 0 });
      for (const o of run.objectives) {
        if (o.status !== 'active') continue;
        const d = o.def;
        if (d.type === 'mineZone') {
          for (const a of d.altitude) this.ring(centre, R + a, BAND);
        } else if (d.type === 'orbit') {
          for (const a of new Set([...d.pe, ...d.ap])) this.ring(centre, R + a, GOAL);
        } else if (d.type === 'rendezvous') {
          const t = session.entity(run.ids.get(d.target) ?? null);
          if (t?.alive) this.ring(local(t.pos), d.range, GOAL);
        }
      }
    }
    for (let i = 0; i < this.rings.length; i++) this.rings[i].visible = i < this.used;
  }

  private ring([x, y]: [number, number], radius: number, color: number): void {
    let r = this.rings[this.used];
    if (!r) {
      const pts = new Float32Array(SEGMENTS * 3);
      for (let i = 0; i < SEGMENTS; i++) {
        const a = (i / SEGMENTS) * Math.PI * 2;
        pts[i * 3] = Math.cos(a);
        pts[i * 3 + 1] = Math.sin(a);
      }
      const geo = new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(pts, 3),
      );
      r = new THREE.LineLoop(
        geo,
        new THREE.LineDashedMaterial({ dashSize: 0.004, gapSize: 0.004, transparent: true }),
      );
      r.computeLineDistances();
      this.scene.add(r);
      this.rings.push(r);
    }
    (r.material as THREE.LineDashedMaterial).color.setHex(color);
    (r.material as THREE.LineDashedMaterial).opacity = 0.7;
    r.position.set(x, y, 0.5);
    r.scale.set(radius, radius, 1);
    this.used++;
  }
}
