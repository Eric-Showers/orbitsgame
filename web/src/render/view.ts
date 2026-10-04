import * as THREE from 'three';
import {
  EntityKind,
  type EntityView,
  type OrbitView,
  type SimEvent,
  type Vec3,
} from '../sim/bridge';
import type { FlightSession } from '../sim/session';
import { fmtDistance } from '../ui/format';
import { MunitionLayer } from './munitions';

const MIN_VIEW = 300; // m across the screen height
const MAX_VIEW = 6_000_000;
const ORBIT_POINTS = 1024;

const COLORS = {
  planet: 0x0d2a4a,
  planetEdge: 0x2f7fb8,
  player: 0x3fd2ff,
  enemy: 0xff4d5e,
  neutral: 0x5dffa8,
  flame: 0xffb547,
  prograde: 0x5dffa8,
  target: 0xff7ce5,
  orbit: 0x3fd2ff,
  targetOrbit: 0xff7ce5,
};

type Focus = 'ship' | 'planet';

/** Extra scene content owned elsewhere (e.g. mission zones), updated every frame. */
export interface ViewLayer {
  update(session: FlightSession, local: (p: Vec3) => [number, number], mpp: number): void;
}

interface Marker {
  group: THREE.Group;
  hull: THREE.Mesh;
  flame: THREE.Mesh;
}

/**
 * Top-down orthographic view of the orbital plane. Uses a floating origin:
 * everything is drawn relative to the focus point in f64 before handing f32
 * coordinates to Three.js (design doc sec. 1, precision).
 */
export class FlightView {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera();
  private viewHeight = 400_000;
  private focus: Focus = 'ship';
  private origin: Vec3 = { x: 0, y: 0, z: 0 };
  private planet: THREE.Group;
  private markers = new Map<number, Marker>();
  private orbitLine: THREE.Line;
  private targetOrbitLine: THREE.Line;
  private apsides: THREE.Points;
  private vectors: THREE.LineSegments;
  private labels = new Map<string, HTMLElement>();
  private munitions = new MunitionLayer(this.scene);
  private layers: ViewLayer[] = [];
  /** Screen pixels at the bottom covered by the console; the view centres above them. */
  private bottomInset = 0;

  constructor(
    private container: HTMLElement,
    planetRadius: number,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.camera.position.set(0, 0, 10);

    this.planet = new THREE.Group();
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(planetRadius, 2048),
      new THREE.MeshBasicMaterial({ color: COLORS.planet }),
    );
    disc.position.z = -2;
    const edge = new THREE.LineLoop(
      circleGeometry(planetRadius, 2048),
      new THREE.LineBasicMaterial({ color: COLORS.planetEdge }),
    );
    this.planet.add(disc, edge);
    this.scene.add(this.planet);

    this.orbitLine = orbitLine(COLORS.orbit, 0.9);
    this.targetOrbitLine = orbitLine(COLORS.targetOrbit, 0.5);
    this.scene.add(this.orbitLine, this.targetOrbitLine);

    this.apsides = new THREE.Points(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array(6), 3),
      ),
      new THREE.PointsMaterial({ color: COLORS.orbit, size: 7, sizeAttenuation: false }),
    );
    this.scene.add(this.apsides);

    this.vectors = new THREE.LineSegments(
      new THREE.BufferGeometry()
        .setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(8 * 3), 3))
        .setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(8 * 3), 3)),
      new THREE.LineBasicMaterial({ vertexColors: true }),
    );
    this.scene.add(this.vectors);

    window.addEventListener('resize', () => this.resize());
    container.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        this.zoomBy(Math.exp(ev.deltaY * 0.0015));
      },
      { passive: false },
    );
    this.resize();
  }

  zoomBy(factor: number): void {
    this.viewHeight = Math.min(MAX_VIEW, Math.max(MIN_VIEW, this.viewHeight * factor));
    this.resize();
  }

  toggleFocus(): void {
    this.focus = this.focus === 'ship' ? 'planet' : 'ship';
    if (this.focus === 'planet') this.viewHeight = Math.max(this.viewHeight, 2_000_000);
    this.resize();
  }

  /** Adds a layer that draws into this view's scene. */
  addLayer(make: (scene: THREE.Scene) => ViewLayer): void {
    this.layers.push(make(this.scene));
  }

  /** Drops per-entity ship markers; call when switching to a different world. */
  reset(): void {
    for (const m of this.markers.values()) this.scene.remove(m.group);
    this.markers.clear();
  }

  /** Feeds sim events (detonations, kills) to the effects layer. */
  showEvents(events: readonly SimEvent[]): void {
    this.munitions.showEvents(events);
  }

  setBottomInset(px: number): void {
    if (px === this.bottomInset) return;
    this.bottomInset = px;
    this.resize();
  }

  /** World units from the focus point up to the top screen edge. */
  private get topExtent(): number {
    const h = window.innerHeight;
    return (this.viewHeight * (h - this.bottomInset)) / (2 * h);
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const half = this.viewHeight / 2;
    this.camera.left = (-half * w) / h;
    this.camera.right = (half * w) / h;
    this.camera.top = this.topExtent;
    this.camera.bottom = this.topExtent - this.viewHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private get metersPerPixel(): number {
    return this.viewHeight / window.innerHeight;
  }

  private local(p: Vec3): [number, number] {
    return [p.x - this.origin.x, p.y - this.origin.y];
  }

  render(session: FlightSession): void {
    const me = session.player();
    this.origin = this.focus === 'ship' ? me.pos : { x: 0, y: 0, z: 0 };
    const mpp = this.metersPerPixel;

    const [px, py] = this.local({ x: 0, y: 0, z: 0 });
    this.planet.position.set(px, py, 0);

    const target = session.entity(me.target);
    this.drawOrbit(this.orbitLine, me.alive ? session.orbit(me.id) : null);
    this.drawOrbit(this.targetOrbitLine, target?.alive ? session.orbit(target.id) : null);
    this.drawApsides(me.alive ? session.orbit(me.id) : null, session.planetRadius);

    const seen = new Set<number>();
    for (const e of session.all()) {
      if (e.kind !== EntityKind.Ship) continue;
      seen.add(e.id);
      const m = this.marker(e);
      m.group.visible = e.alive;
      if (!e.alive) continue;
      const [x, y] = this.local(e.pos);
      m.group.position.set(x, y, 1);
      m.group.rotation.z = Math.atan2(e.heading.y, e.heading.x);
      m.group.scale.setScalar(mpp);
      m.flame.visible = e.throttle > 0 && e.fuel > 0;
      m.flame.scale.set(0.4 + e.throttle * (0.8 + 0.3 * Math.random()), 1, 1);
    }
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) {
        this.scene.remove(m.group);
        this.markers.delete(id);
      }
    }

    this.munitions.update(session.all(), (p) => this.local(p), mpp);
    for (const layer of this.layers) layer.update(session, (p) => this.local(p), mpp);
    this.drawVectors(me, target, mpp);
    this.updateLabels(me, target);
    this.renderer.render(this.scene, this.camera);
  }

  private marker(e: EntityView): Marker {
    let m = this.markers.get(e.id);
    if (m) return m;
    // Placeholder hull shapes (in pixels; scaled by metres-per-pixel each frame).
    const color = e.team === 0 ? COLORS.player : e.team === 1 ? COLORS.enemy : COLORS.neutral;
    const hullShape = new THREE.Shape();
    if (e.team === 2) {
      hullShape.moveTo(6, 0).lineTo(0, 6).lineTo(-6, 0).lineTo(0, -6).closePath();
    } else {
      hullShape.moveTo(11, 0).lineTo(-7, 7).lineTo(-4, 0).lineTo(-7, -7).closePath();
    }
    const hull = new THREE.Mesh(
      new THREE.ShapeGeometry(hullShape),
      new THREE.MeshBasicMaterial({ color }),
    );
    const flameShape = new THREE.Shape().moveTo(0, 3.5).lineTo(-14, 0).lineTo(0, -3.5).closePath();
    const flame = new THREE.Mesh(
      new THREE.ShapeGeometry(flameShape),
      new THREE.MeshBasicMaterial({ color: COLORS.flame, transparent: true, opacity: 0.85 }),
    );
    flame.position.x = -4;
    const group = new THREE.Group();
    group.add(flame, hull);
    this.scene.add(group);
    m = { group, hull, flame };
    this.markers.set(e.id, m);
    return m;
  }

  private drawOrbit(line: THREE.Line, orbit: OrbitView | null): void {
    line.visible = orbit !== null;
    if (!orbit) return;
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const { eccentricity: e, semiLatusRectum: p, argPeriapsis: w } = orbit;
    // Elliptic: whole loop. Open orbits: the arc where the conic is defined, capped in range.
    const span = e < 1 ? Math.PI : Math.min(Math.acos(-1 / e) - 1e-3, Math.PI);
    for (let i = 0; i < ORBIT_POINTS; i++) {
      const nu = -span + (2 * span * i) / (ORBIT_POINTS - 1);
      const r = Math.min(p / (1 + e * Math.cos(nu)), 5e7);
      const [x, y] = this.local({ x: r * Math.cos(nu + w), y: r * Math.sin(nu + w), z: 0 });
      pos.setXYZ(i, x, y, 0);
    }
    pos.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  }

  private drawApsides(orbit: OrbitView | null, R: number): void {
    const pos = this.apsides.geometry.getAttribute('position') as THREE.BufferAttribute;
    const show = orbit !== null && orbit.eccentricity > 1e-4;
    this.apsides.visible = show;
    const ap = this.label('ap');
    const pe = this.label('pe');
    ap.hidden = pe.hidden = !show;
    if (!show || !orbit) return;
    const w = orbit.argPeriapsis;
    const peP = { x: orbit.periapsis * Math.cos(w), y: orbit.periapsis * Math.sin(w), z: 0 };
    const [x0, y0] = this.local(peP);
    pos.setXYZ(0, x0, y0, 0);
    this.placeLabel(pe, peP, `Pe ${fmtDistance(orbit.periapsis - R)}`);
    if (orbit.eccentricity < 1) {
      const apP = { x: -orbit.apoapsis * Math.cos(w), y: -orbit.apoapsis * Math.sin(w), z: 0 };
      const [x1, y1] = this.local(apP);
      pos.setXYZ(1, x1, y1, 0);
      this.placeLabel(ap, apP, `Ap ${fmtDistance(orbit.apoapsis - R)}`);
    } else {
      pos.setXYZ(1, x0, y0, 0);
      ap.hidden = true;
    }
    pos.needsUpdate = true;
    this.apsides.geometry.computeBoundingSphere();
  }

  /** Short screen-space direction ticks: heading, prograde, retrograde, target. */
  private drawVectors(me: EntityView, target: EntityView | undefined, mpp: number): void {
    const pos = this.vectors.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.vectors.geometry.getAttribute('color') as THREE.BufferAttribute;
    this.vectors.visible = me.alive;
    if (!me.alive) return;
    const [cx, cy] = this.local(me.pos);
    const seg = (i: number, dir: Vec3, from: number, to: number, color: number): void => {
      const n = Math.hypot(dir.x, dir.y) || 1;
      const ux = dir.x / n;
      const uy = dir.y / n;
      const c = new THREE.Color(color);
      pos.setXYZ(2 * i, cx + ux * from * mpp, cy + uy * from * mpp, 1);
      pos.setXYZ(2 * i + 1, cx + ux * to * mpp, cy + uy * to * mpp, 1);
      col.setXYZ(2 * i, c.r, c.g, c.b);
      col.setXYZ(2 * i + 1, c.r, c.g, c.b);
    };
    seg(0, me.heading, 14, 40, COLORS.player);
    seg(1, me.vel, 46, 62, COLORS.prograde);
    seg(2, { x: -me.vel.x, y: -me.vel.y, z: 0 }, 46, 54, COLORS.prograde);
    if (target?.alive) {
      seg(
        3,
        { x: target.pos.x - me.pos.x, y: target.pos.y - me.pos.y, z: 0 },
        66,
        84,
        COLORS.target,
      );
    } else {
      seg(3, me.vel, 0, 0, COLORS.target);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.vectors.geometry.computeBoundingSphere();
  }

  private updateLabels(me: EntityView, target: EntityView | undefined): void {
    const tgt = this.label('tgt');
    tgt.hidden = !target?.alive;
    if (target?.alive) {
      const range = Math.hypot(
        target.pos.x - me.pos.x,
        target.pos.y - me.pos.y,
        target.pos.z - me.pos.z,
      );
      this.placeLabel(tgt, target.pos, `◇ TGT ${fmtDistance(range)}`);
    }
  }

  private label(key: string): HTMLElement {
    let l = this.labels.get(key);
    if (!l) {
      l = document.createElement('div');
      l.className = `map-label ${key}`;
      this.container.appendChild(l);
      this.labels.set(key, l);
    }
    return l;
  }

  private placeLabel(l: HTMLElement, p: Vec3, text: string): void {
    const [x, y] = this.local(p);
    const mpp = this.metersPerPixel;
    l.style.left = `${window.innerWidth / 2 + x / mpp}px`;
    l.style.top = `${(this.topExtent - y) / mpp}px`;
    if (l.textContent !== text) l.textContent = text;
  }
}

function circleGeometry(r: number, n: number): THREE.BufferGeometry {
  const pts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts[3 * i] = r * Math.cos(a);
    pts[3 * i + 1] = r * Math.sin(a);
  }
  return new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute(pts, 3),
  );
}

function orbitLine(color: number, opacity: number): THREE.Line {
  const geom = new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute(new Float32Array(ORBIT_POINTS * 3), 3),
  );
  return new THREE.Line(geom, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}
