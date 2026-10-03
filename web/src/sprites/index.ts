import * as THREE from 'three';
import beaconSvg from './svg/beacon.svg?raw';
import corvetteSvg from './svg/corvette.svg?raw';
import droneSvg from './svg/drone.svg?raw';
import flameSvg from './svg/flame.svg?raw';
import gunboatSvg from './svg/gunboat.svg?raw';
import mineSvg from './svg/mine.svg?raw';
import minelayerSvg from './svg/minelayer.svg?raw';
import missileSvg from './svg/missile.svg?raw';

// Mirrors `Kind` and the class indices in crates/orbit-sim/src/vessel.rs.
export const KIND_SHIP = 0;
export const KIND_MISSILE = 1;
export const KIND_MINE = 2;
export const CLASS_CORVETTE = 0;
export const CLASS_DRONE = 1;
export const CLASS_GUNBOAT = 2;
export const CLASS_MINELAYER = 3;
export const CLASS_BEACON = 4;

/** What the renderer needs from one sim entity. Headings are unit vectors. */
export interface VesselDrawState {
  id: number;
  kind: number;
  /** Index into SHIP_CLASSES; ignored for munitions. */
  shipClass: number;
  team: number;
  x: number;
  y: number;
  z: number;
  headingX: number;
  headingY: number;
  /** 0..1; draws the engine plume when above zero. */
  throttle: number;
}

export interface VesselSprites {
  /** Resolves once every texture is rasterized; sprites stay hidden until then. */
  ready: Promise<void>;
  /**
   * Syncs sprites to `vessels`; entities missing from the list are removed.
   * `worldPerPixel` keeps sprites a constant on-screen size at any zoom.
   */
  update(vessels: Iterable<VesselDrawState>, worldPerPixel: number): void;
  dispose(): void;
}

/** Hull accent colour per team; the SVGs use TEAM_TOKEN as the placeholder. */
export const TEAM_COLORS = ['#4da6ff', '#ff5a4d', '#ffd24d', '#5ee07a'];
const TEAM_TOKEN = /#4da6ff/gi;

/** Rasterized texture edge in pixels (sprites draw at most ~48 px on screen). */
const TEXTURE_PX = 128;

interface SpriteDef {
  svg: string;
  /** On-screen size in CSS pixels. */
  px: number;
  /** Whether the sprite turns with the heading (beacons and mines do not). */
  rotates: boolean;
}

const SHIP_DEFS: SpriteDef[] = [
  { svg: corvetteSvg, px: 40, rotates: true },
  { svg: droneSvg, px: 32, rotates: true },
  { svg: gunboatSvg, px: 44, rotates: true },
  { svg: minelayerSvg, px: 46, rotates: true },
  { svg: beaconSvg, px: 28, rotates: false },
];
const MISSILE_DEF: SpriteDef = { svg: missileSvg, px: 24, rotates: true };
const MINE_DEF: SpriteDef = { svg: mineSvg, px: 20, rotates: false };

function defFor(v: VesselDrawState): SpriteDef {
  if (v.kind === KIND_MISSILE) return MISSILE_DEF;
  if (v.kind === KIND_MINE) return MINE_DEF;
  return SHIP_DEFS[v.shipClass] ?? SHIP_DEFS[CLASS_DRONE];
}

/** World units per CSS pixel for an orthographic camera filling the canvas. */
export function worldPerPixel(camera: THREE.OrthographicCamera, canvas: HTMLCanvasElement): number {
  return (camera.right - camera.left) / camera.zoom / Math.max(canvas.clientWidth, 1);
}

function rasterize(svg: string): Promise<THREE.Texture> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TEXTURE_PX;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const img = new Image(TEXTURE_PX, TEXTURE_PX);
  return new Promise((resolve, reject) => {
    img.onload = () => {
      canvas.getContext('2d')?.drawImage(img, 0, 0, TEXTURE_PX, TEXTURE_PX);
      texture.needsUpdate = true;
      resolve(texture);
    };
    img.onerror = () => reject(new Error('sprite SVG failed to load'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

interface Entry {
  hull: THREE.Sprite;
  flame: THREE.Sprite;
  key: string;
}

/**
 * Draws ships, missiles and mines as camera-facing sprites in `scene`. Nose
 * art points +x, so a sprite's rotation is the heading angle in the xy plane.
 */
export function createVesselSprites(scene: THREE.Scene): VesselSprites {
  const textures = new Map<string, THREE.Texture>();
  const defs = [...SHIP_DEFS, MISSILE_DEF, MINE_DEF];
  const jobs: Promise<void>[] = [];
  for (const def of defs) {
    TEAM_COLORS.forEach((color, team) => {
      const key = `${defs.indexOf(def)}:${team}`;
      jobs.push(
        rasterize(def.svg.replace(TEAM_TOKEN, color)).then((t) => void textures.set(key, t)),
      );
    });
  }
  let flameTexture: THREE.Texture | null = null;
  jobs.push(rasterize(flameSvg).then((t) => void (flameTexture = t)));
  let loaded = false;
  const ready = Promise.all(jobs).then(() => {
    loaded = true;
  });

  const entries = new Map<number, Entry>();
  const seen = new Set<number>();

  const remove = (id: number, e: Entry): void => {
    scene.remove(e.hull, e.flame);
    e.hull.material.dispose();
    e.flame.material.dispose();
    entries.delete(id);
  };

  return {
    ready,
    update(vessels, wpp) {
      if (!loaded) return;
      seen.clear();
      for (const v of vessels) {
        seen.add(v.id);
        const def = defFor(v);
        const key = `${defs.indexOf(def)}:${v.team % TEAM_COLORS.length}`;
        let e = entries.get(v.id);
        if (!e) {
          const flame = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: flameTexture, depthWrite: false }),
          );
          const hull = new THREE.Sprite(new THREE.SpriteMaterial({ depthWrite: false }));
          // Munitions draw over ships so incoming threats stay visible.
          hull.renderOrder = v.kind === KIND_SHIP ? 1 : 2;
          flame.renderOrder = 0;
          scene.add(flame, hull);
          e = { hull, flame, key: '' };
          entries.set(v.id, e);
        }
        if (e.key !== key) {
          e.hull.material.map = textures.get(key) ?? null;
          e.hull.material.needsUpdate = true;
          e.key = key;
        }
        const angle = Math.atan2(v.headingY, v.headingX);
        const size = def.px * wpp;
        e.hull.position.set(v.x, v.y, v.z);
        e.hull.scale.set(size, size, 1);
        e.hull.material.rotation = def.rotates ? angle : 0;

        const burning = v.throttle > 0 && def.rotates; // mines and beacons have no main engine
        e.flame.visible = burning;
        if (burning) {
          // Plume sits behind the stern, stretched by throttle.
          const len = size * (0.4 + 0.6 * Math.min(v.throttle, 1));
          const back = size * 0.35 + len * 0.5;
          e.flame.position.set(v.x - v.headingX * back, v.y - v.headingY * back, v.z);
          e.flame.scale.set(len, size * 0.5, 1);
          e.flame.material.rotation = angle;
        }
      }
      for (const [id, e] of entries) if (!seen.has(id)) remove(id, e);
    },
    dispose() {
      for (const [id, e] of entries) remove(id, e);
      for (const t of textures.values()) t.dispose();
      flameTexture?.dispose();
    },
  };
}
