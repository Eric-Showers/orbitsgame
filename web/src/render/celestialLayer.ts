import * as THREE from 'three';
import type { FlightSession } from '../sim/session';
import type { Vec3 } from '../sim/bridge';
import type { SpriteStyle } from '../sprites';
import { CELESTIAL, inPlanetShadow, moonPosition, sunDirection, type Vec2 } from './celestial';
import type { ViewLayer } from './view';

const SEGMENTS = 256;
const SUN_PX = 14;
const LIGHT = 0xffe9a8;
const NEON = 0x3fd2ff;
const MOON_REAL = 0xb9b4a8;
const NIGHT = 0x02060d;
const FAR = 1e9;

function halfDisc(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, 1, -Math.PI / 2, Math.PI / 2, false);
  shape.closePath();
  return new THREE.ShapeGeometry(shape, SEGMENTS);
}

function unitRing(): THREE.BufferGeometry {
  const pts = new Float32Array(SEGMENTS * 3);
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (2 * Math.PI * i) / SEGMENTS;
    pts[3 * i] = Math.cos(a);
    pts[3 * i + 1] = Math.sin(a);
  }
  return new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute(pts, 3),
  );
}

function fill(color: number, opacity = 1, additive = false): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

function stroke(color: number, opacity = 1): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
}

/**
 * The sun and the moon. The sun is infinitely far, so it is drawn as a marker
 * pinned to the screen edge in its true direction; it lights the planet and
 * moon (night half-discs) and casts the planet's shadow. The moon is a body on
 * a Keplerian circular orbit. Both follow the active sprite style.
 */
export class CelestialLayer implements ViewLayer {
  private night = new THREE.Mesh(halfDisc(), fill(NIGHT, CELESTIAL.night.opacity));
  private shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 2),
    fill(NIGHT, CELESTIAL.night.shadowOpacity),
  );
  private moonFill = new THREE.Mesh(new THREE.CircleGeometry(1, SEGMENTS), fill(MOON_REAL));
  private moonNight = new THREE.Mesh(halfDisc(), fill(NIGHT, 0.7));
  private moonRing = new THREE.LineLoop(unitRing(), stroke(NEON));
  private moonLit = new THREE.Mesh(new THREE.CircleGeometry(1, SEGMENTS), fill(NEON, 0.12, true));
  private moonOrbit = new THREE.LineLoop(unitRing(), stroke(NEON, CELESTIAL.moon.ringOpacity));
  private moonDot = new THREE.Mesh(new THREE.CircleGeometry(1, 24), fill(NEON, 1, true));
  private sunDisc = new THREE.Mesh(new THREE.CircleGeometry(1, 48), fill(LIGHT, 1, true));
  private sunHalo = new THREE.Mesh(new THREE.CircleGeometry(1, 48), fill(LIGHT, 0.25, true));
  private sunRays = new THREE.LineSegments(rayGeometry(), stroke(LIGHT));

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.OrthographicCamera,
    private style: () => SpriteStyle,
    private label: (key: string, x: number, y: number, text: string | null) => void,
  ) {
    // Behind vessels (z 1) and the planet rim, above the planet disc (z -2).
    this.night.position.z = -1.9;
    this.shadow.position.z = -2.1;
    this.moonFill.position.z = this.moonNight.position.z = -1;
    this.moonLit.position.z = this.moonRing.position.z = this.moonDot.position.z = -1;
    this.moonOrbit.position.z = -2.2;
    this.moonNight.position.z = -0.9;
    for (const m of [this.sunDisc, this.sunHalo, this.sunRays]) m.position.z = 0.5;
    this.scene.add(
      this.night,
      this.shadow,
      this.moonFill,
      this.moonNight,
      this.moonRing,
      this.moonLit,
      this.moonOrbit,
      this.moonDot,
      this.sunDisc,
      this.sunHalo,
      this.sunRays,
    );
  }

  update(session: FlightSession, local: (p: Vec3) => [number, number], mpp: number): void {
    const style = this.style();
    const t = session.time;
    const R = session.planetRadius;
    const mu = session.game.mu();
    const sun = sunDirection(t);
    const ang = Math.atan2(sun.y, sun.x);
    const [cx, cy] = local({ x: 0, y: 0, z: 0 });

    // Night half of the planet and the shadow it casts anti-sunward.
    this.night.position.set(cx, cy, this.night.position.z);
    this.night.scale.set(R, R, 1);
    this.night.rotation.z = ang + Math.PI;
    this.shadow.position.set(cx - sun.x * FAR, cy - sun.y * FAR, this.shadow.position.z);
    this.shadow.scale.set(FAR, R, 1);
    this.shadow.rotation.z = ang;
    this.night.visible = style !== 'tactical';
    this.shadow.visible = true;

    this.updateMoon(style, t, mu, sun, R, local, mpp);
    this.updateSun(style, sun, ang, mpp);
  }

  private updateMoon(
    style: SpriteStyle,
    t: number,
    mu: number,
    sun: Vec2,
    R: number,
    local: (p: Vec3) => [number, number],
    mpp: number,
  ): void {
    const m = CELESTIAL.moon;
    const p = moonPosition(t, mu);
    const [x, y] = local({ ...p, z: 0 });
    const [cx, cy] = local({ x: 0, y: 0, z: 0 });
    const eclipsed = inPlanetShadow(p, sun, R);
    // Symbol grows with the moon but never shrinks below a readable size.
    const drawR = Math.max(m.radius, m.minPx * mpp);
    const sunAng = Math.atan2(sun.y, sun.x);

    this.moonOrbit.position.set(cx, cy, this.moonOrbit.position.z);
    this.moonOrbit.scale.set(m.orbitRadius, m.orbitRadius, 1);

    const real = style === 'realistic';
    const neon = style === 'neon';
    const tactical = style === 'tactical';
    this.moonFill.visible = this.moonNight.visible = real;
    this.moonRing.visible = this.moonLit.visible = neon;
    this.moonDot.visible = tactical;
    this.moonOrbit.visible = true;

    for (const mesh of [this.moonFill, this.moonNight, this.moonRing, this.moonLit, this.moonDot]) {
      mesh.position.set(x, y, mesh.position.z);
      mesh.scale.set(drawR, drawR, 1);
    }
    this.moonNight.rotation.z = sunAng + Math.PI;
    (this.moonFill.material as THREE.MeshBasicMaterial).opacity = eclipsed ? 0.35 : 1;
    (this.moonRing.material as THREE.LineBasicMaterial).opacity = eclipsed ? 0.35 : 1;
    // Tactical symbol: a small filled dot with a ring, marking position only.
    this.moonDot.scale.set(drawR * 0.35, drawR * 0.35, 1);
    this.moonRing.visible = neon || tactical;
    (this.moonRing.material as THREE.LineBasicMaterial).color.setHex(tactical ? 0xc8d4e0 : NEON);
    (this.moonDot.material as THREE.MeshBasicMaterial).color.setHex(0xc8d4e0);
    this.label('moon', x, y - drawR - 12 * mpp, 'MOON');
  }

  private updateSun(style: SpriteStyle, sun: Vec2, ang: number, mpp: number): void {
    const cam = this.camera;
    const hx = (cam.right - cam.left) / 2;
    const hy = (cam.top - cam.bottom) / 2;
    const ox = (cam.right + cam.left) / 2;
    const oy = (cam.top + cam.bottom) / 2;
    const margin = CELESTIAL.sun.edgeMarginPx * mpp;
    const ex = Math.max(hx - margin, 1);
    const ey = Math.max(hy - margin, 1);
    // Ray from the view centre toward the sun, clipped to the inset screen rectangle.
    const k = Math.min(
      Math.abs(sun.x) > 1e-9 ? ex / Math.abs(sun.x) : Infinity,
      Math.abs(sun.y) > 1e-9 ? ey / Math.abs(sun.y) : Infinity,
    );
    const x = ox + sun.x * k;
    const y = oy + sun.y * k;
    const size = SUN_PX * mpp;
    const tactical = style === 'tactical';
    const neon = style === 'neon';
    for (const mesh of [this.sunDisc, this.sunHalo]) mesh.position.set(x, y, 0.5);
    this.sunDisc.scale.set(size * (tactical ? 0.6 : 0.8), size * (tactical ? 0.6 : 0.8), 1);
    this.sunDisc.visible = !neon;
    this.sunHalo.visible = style === 'realistic';
    this.sunHalo.scale.set(size * 2.4, size * 2.4, 1);
    this.sunRays.position.set(x, y, 0.5);
    this.sunRays.scale.set(size, size, 1);
    this.sunRays.rotation.z = ang;
    this.sunRays.visible = neon || tactical;
    this.label('sun', x, y - size * 1.9, 'SUN');
  }
}

function rayGeometry(): THREE.BufferGeometry {
  const n = 12;
  const pts = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    pts.set([c * 1.0, s * 1.0, 0, c * 1.5, s * 1.5, 0], i * 6);
  }
  return new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute(pts, 3),
  );
}
