import * as THREE from 'three';
import {
  CLASS_BEACON,
  KIND_MINE,
  KIND_MISSILE,
  KIND_SHIP,
  SPRITE_STYLES,
  createVesselSprites,
  worldPerPixel,
  type VesselDrawState,
} from './index';

// Dev page: every sprite in every style, for a friendly and a hostile team,
// slowly turning, with the engine plume pulsing so throttle scaling is visible.
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera();
camera.position.z = 10;

const COLS = CLASS_BEACON + 3; // five ship classes, missile, mine
const TEAMS = [0, 1];
const resize = (): void => {
  const aspect = window.innerWidth / window.innerHeight;
  camera.left = -0.5;
  camera.right = COLS - 0.5;
  const h = (camera.right - camera.left) / aspect;
  camera.top = 0.5;
  camera.bottom = 0.5 - h;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
};
window.addEventListener('resize', resize);
resize();

const rows = SPRITE_STYLES.map((style, s) => {
  const sprites = createVesselSprites(scene, { style });
  const vessels: VesselDrawState[] = [];
  for (const team of TEAMS) {
    for (let col = 0; col < COLS; col++) {
      const kind = col <= CLASS_BEACON ? KIND_SHIP : col === COLS - 2 ? KIND_MISSILE : KIND_MINE;
      const row = s * TEAMS.length + team;
      vessels.push({
        id: row * COLS + col,
        kind,
        shipClass: col,
        team,
        x: col,
        y: -row * 0.8,
        z: 0,
        headingX: 1,
        headingY: 0,
        throttle: 0,
      });
    }
  }
  return { sprites, vessels };
});

const frame = (now: number): void => {
  const t = now / 1000;
  // Doubled so the preview shows detail; the game uses the default 1x.
  const wpp = worldPerPixel(camera, renderer.domElement) * 2;
  for (const { sprites, vessels } of rows) {
    for (const v of vessels) {
      const a = t * 0.4 + v.team * 0.6;
      v.headingX = Math.cos(a);
      v.headingY = Math.sin(a);
      v.throttle = Math.max(0, Math.sin(t * 1.5 + v.id));
    }
    sprites.update(vessels, wpp);
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
