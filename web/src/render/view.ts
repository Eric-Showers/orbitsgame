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
import {
  SPRITE_STYLES,
  createVesselSprites,
  type SpriteStyle,
  type VesselDrawState,
} from '../sprites';
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
  prograde: 0x5dffa8,
  target: 0xff7ce5,
  orbit: 0x3fd2ff,
  targetOrbit: 0xff7ce5,
};

type Focus = 'ship' | 'planet';

/** Cycles the vessel art: neon (default), realistic, tactical. */
const STYLE_KEY = 'KeyV';
const STYLE_NAMES: Record<SpriteStyle, string> = {
  neon: 'NEON',
  realistic: 'REALISTIC',
  tactical: 'TACTICAL',
};

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
  // Team 1 is the enemy; team 2 (drones, beacons) is neutral, not hostile.
  private sprites = createVesselSprites(this.scene, { isHostile: (team) => team === 1 });
  private drawStates: VesselDrawState[] = [];
  private styleToast = 0;
  private orbitLine: THREE.Line;
  private targetOrbitLine: THREE.Line;
  private apsides: THREE.Points;
  private vectors: THREE.LineSegments;
  private labels = new Map<string, HTMLElement>();
  private munitions = new MunitionLayer(this.scene);
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
    window.addEventListener('keydown', (ev) => {
      if (ev.code !== STYLE_KEY || ev.repeat || ev.target instanceof HTMLInputElement) return;
      this.cycleSpriteStyle();
    });
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

  cycleSpriteStyle(): void {
    const next =
      SPRITE_STYLES[(SPRITE_STYLES.indexOf(this.sprites.style) + 1) % SPRITE_STYLES.length];
    void this.sprites.setStyle(next);
    const toast = this.label('sprite-style');
    Object.assign(toast.style, { left: '50%', top: '16px', transform: 'translateX(-50%)' });
    toast.textContent = `ART ${STYLE_NAMES[next]} · V`;
    toast.hidden = false;
    window.clearTimeout(this.styleToast);
    this.styleToast = window.setTimeout(() => (toast.hidden = true), 1500);
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

    // Ships and munitions share the sprite layer, in floating-origin coordinates.
    const states = this.drawStates;
    let n = 0;
    for (const e of session.all()) {
      if (!e.alive) continue;
      const [x, y] = this.local(e.pos);
      const st = (states[n++] ??= {} as VesselDrawState);
      st.id = e.id;
      st.kind = e.kind;
      st.shipClass = e.shipClass;
      st.team = e.team;
      st.x = x;
      st.y = y;
      st.z = e.kind === EntityKind.Ship ? 1 : 1.5;
      st.headingX = e.heading.x;
      st.headingY = e.heading.y;
      st.throttle = e.kind === EntityKind.Ship && e.fuel <= 0 ? 0 : e.throttle;
    }
    states.length = n;
    this.sprites.update(states, mpp);

    this.munitions.update(session.all(), (p) => this.local(p), mpp);
    this.drawVectors(me, target, mpp);
    this.updateLabels(me, target);
    this.renderer.render(this.scene, this.camera);
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
