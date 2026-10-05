import * as THREE from 'three';

// Mirrors `Kind` and the class indices in crates/orbit-sim/src/vessel.rs.
export const KIND_SHIP = 0;
export const KIND_MISSILE = 1;
export const KIND_MINE = 2;
export const KIND_KV = 3;
export const CLASS_CORVETTE = 0;
export const CLASS_DRONE = 1;
export const CLASS_GUNBOAT = 2;
export const CLASS_MINELAYER = 3;
export const CLASS_BEACON = 4;

/**
 * Art directions, one folder each under ./svg:
 * - neon: cold-war vector-display look; the default interface style.
 * - realistic: what the hardware "actually" looks like in the game world.
 * - tactical: map symbols for zoomed-out views with many objects.
 * When each applies (user choice, zoom level) is still open.
 */
export type SpriteStyle = 'neon' | 'realistic' | 'tactical';
export const SPRITE_STYLES: readonly SpriteStyle[] = ['neon', 'realistic', 'tactical'];

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

export interface VesselSpriteOptions {
  style?: SpriteStyle;
  /** Tactical symbols draw hostile teams as diamonds. Default: every team but 0. */
  isHostile?: (team: number) => boolean;
}

export interface VesselSprites {
  /** Resolves once the current style's textures are rasterized. */
  ready: Promise<void>;
  readonly style: SpriteStyle;
  /** Switches art; the old style stays on screen until the new one has loaded. */
  setStyle(style: SpriteStyle): Promise<void>;
  /**
   * Syncs sprites to `vessels`; entities missing from the list are removed.
   * `worldPerPixel` keeps sprites a constant on-screen size at any zoom.
   */
  update(vessels: Iterable<VesselDrawState>, worldPerPixel: number): void;
  dispose(): void;
}

/** Accent colour per team; the SVGs use TEAM_TOKEN as the placeholder. */
// Matches the flight view palette: player, enemy, neutral, spare.
export const TEAM_COLORS = ['#3fd2ff', '#ff4d5e', '#5dffa8', '#ffd24d'];
const TEAM_TOKEN = /#4da6ff/gi;

/** Rasterized texture edge in pixels (sprites draw at most ~48 px on screen). */
const TEXTURE_PX = 128;

const SVGS = import.meta.glob<string>('./svg/*/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
});

interface Look {
  file: string;
  /** On-screen size in CSS pixels. */
  px: number;
  /** Whether the art turns with the heading (beacons and mines do not). */
  rotates: boolean;
}

const SHIP_LOOKS: Look[] = [
  { file: 'corvette', px: 40, rotates: true },
  { file: 'drone', px: 32, rotates: true },
  { file: 'gunboat', px: 44, rotates: true },
  { file: 'minelayer', px: 46, rotates: true },
  { file: 'beacon', px: 28, rotates: false },
];
const MISSILE_LOOK: Look = { file: 'missile', px: 24, rotates: true };
const MINE_LOOK: Look = { file: 'mine', px: 20, rotates: false };
const KV_LOOK: Look = { file: 'kv', px: 22, rotates: true };

function lookFor(v: VesselDrawState): Look {
  if (v.kind === KIND_MISSILE) return MISSILE_LOOK;
  if (v.kind === KIND_MINE) return MINE_LOOK;
  if (v.kind === KIND_KV) return KV_LOOK;
  return SHIP_LOOKS[v.shipClass] ?? SHIP_LOOKS[CLASS_DRONE];
}

/** Glowing line art reads best added onto the dark background. */
const blendingFor = (style: SpriteStyle): THREE.Blending =>
  style === 'neon' ? THREE.AdditiveBlending : THREE.NormalBlending;

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

/** Rasterizes every file of one style in every team colour, keyed `file:team`. */
async function loadStyle(style: SpriteStyle): Promise<Map<string, THREE.Texture>> {
  const textures = new Map<string, THREE.Texture>();
  const jobs: Promise<void>[] = [];
  for (const [path, svg] of Object.entries(SVGS)) {
    const [, dir, file] = /\.\/svg\/([^/]+)\/([^/]+)\.svg$/.exec(path) ?? [];
    if (dir !== style) continue;
    // The plume keeps its own colours; everything else is tinted per team.
    const teams = file === 'flame' ? [''] : TEAM_COLORS;
    teams.forEach((color, team) => {
      const tinted = color ? svg.replace(TEAM_TOKEN, color) : svg;
      jobs.push(rasterize(tinted).then((t) => void textures.set(`${file}:${team}`, t)));
    });
  }
  await Promise.all(jobs);
  return textures;
}

interface Entry {
  hull: THREE.Sprite;
  flame: THREE.Sprite;
  /** Tactical heading line; the symbol itself stays upright. */
  tick: THREE.Sprite;
  key: string;
}

/**
 * Draws ships, missiles and mines as camera-facing sprites in `scene`. Nose
 * art points +x, so a sprite's rotation is the heading angle in the xy plane.
 */
export function createVesselSprites(
  scene: THREE.Scene,
  options: VesselSpriteOptions = {},
): VesselSprites {
  const isHostile = options.isHostile ?? ((team: number) => team !== 0);
  const loaded = new Map<SpriteStyle, Promise<Map<string, THREE.Texture>>>();
  let style: SpriteStyle = options.style ?? 'neon';
  /** Style currently drawn, with its textures; null until the first load. */
  let shown: { style: SpriteStyle; textures: Map<string, THREE.Texture> } | null = null;

  const entries = new Map<number, Entry>();
  const seen = new Set<number>();

  const remove = (id: number, e: Entry): void => {
    scene.remove(e.hull, e.flame, e.tick);
    e.hull.material.dispose();
    e.flame.material.dispose();
    e.tick.material.dispose();
    entries.delete(id);
  };

  const setStyle = async (next: SpriteStyle): Promise<void> => {
    style = next;
    if (!loaded.has(next)) loaded.set(next, loadStyle(next));
    const textures = await loaded.get(next)!;
    if (style !== next) return; // superseded while loading
    shown = { style: next, textures };
    const blending = blendingFor(next);
    for (const e of entries.values()) {
      e.key = '';
      e.hull.material.blending = e.flame.material.blending = blending;
      e.flame.material.map = textures.get('flame:0') ?? null;
      e.flame.material.needsUpdate = true;
    }
  };

  return {
    ready: setStyle(style),
    get style() {
      return style;
    },
    setStyle,
    update(vessels, wpp) {
      if (!shown) return;
      const { textures } = shown;
      const tactical = shown.style === 'tactical';
      const flameMap = textures.get('flame:0') ?? null;
      seen.clear();
      for (const v of vessels) {
        seen.add(v.id);
        const look = lookFor(v);
        const team = v.team % TEAM_COLORS.length;
        const hostile = tactical && isHostile(v.team) ? '-hostile' : '';
        const key = `${look.file}${hostile}:${team}`;
        let e = entries.get(v.id);
        if (!e) {
          const blending = blendingFor(shown.style);
          const flame = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: flameMap, depthWrite: false, blending }),
          );
          const hull = new THREE.Sprite(new THREE.SpriteMaterial({ depthWrite: false, blending }));
          const tick = new THREE.Sprite(new THREE.SpriteMaterial({ depthWrite: false }));
          // Munitions draw over ships so incoming threats stay visible.
          hull.renderOrder = v.kind === KIND_SHIP ? 1 : 2;
          flame.renderOrder = 0;
          tick.renderOrder = hull.renderOrder;
          scene.add(flame, hull, tick);
          e = { hull, flame, tick, key: '' };
          entries.set(v.id, e);
        }
        if (e.key !== key) {
          e.hull.material.map = textures.get(key) ?? null;
          e.hull.material.needsUpdate = true;
          e.tick.material.map = textures.get(`heading:${team}`) ?? null;
          e.tick.material.needsUpdate = true;
          e.key = key;
        }
        const angle = Math.atan2(v.headingY, v.headingX);
        const size = look.px * wpp;
        e.hull.position.set(v.x, v.y, v.z);
        e.hull.scale.set(size, size, 1);
        e.hull.material.rotation = look.rotates && !tactical ? angle : 0;

        e.tick.visible = tactical && look.rotates;
        if (e.tick.visible) {
          e.tick.position.copy(e.hull.position);
          e.tick.scale.copy(e.hull.scale);
          e.tick.material.rotation = angle;
        }

        // Mines and beacons have no main engine; tactical symbols have no art for one.
        const burning = v.throttle > 0 && look.rotates && flameMap !== null;
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
      for (const p of loaded.values()) void p.then((m) => m.forEach((t) => t.dispose()));
      loaded.clear();
    },
  };
}
