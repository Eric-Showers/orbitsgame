import * as THREE from 'three';
import {
  CLASS_BEACON,
  KIND_MINE,
  KIND_MISSILE,
  KIND_SHIP,
  TEAM_COLORS,
  createVesselSprites,
  worldPerPixel,
  type VesselDrawState,
} from './index';

// Dev page: every sprite for every team in a grid, slowly turning, with the
// engine plume pulsing so throttle scaling is visible.
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera();
camera.position.z = 10;

const COLS = CLASS_BEACON + 3; // five ship classes, missile, mine
const resize = (): void => {
  const aspect = window.innerWidth / window.innerHeight;
  camera.left = -0.5;
  camera.right = COLS + 0.5 - 1;
  const h = (camera.right - camera.left) / aspect;
  camera.top = 0.5;
  camera.bottom = 0.5 - h;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
};
window.addEventListener('resize', resize);
resize();

const sprites = createVesselSprites(scene);
const vessels: VesselDrawState[] = [];
TEAM_COLORS.forEach((_, team) => {
  for (let col = 0; col < COLS; col++) {
    const kind = col <= CLASS_BEACON ? KIND_SHIP : col === COLS - 2 ? KIND_MISSILE : KIND_MINE;
    vessels.push({
      id: team * COLS + col,
      kind,
      shipClass: col,
      team,
      x: col,
      y: -team,
      z: 0,
      headingX: 1,
      headingY: 0,
      throttle: 0,
    });
  }
});

const frame = (now: number): void => {
  const t = now / 1000;
  for (const v of vessels) {
    const a = t * 0.4 + v.team * 0.6;
    v.headingX = Math.cos(a);
    v.headingY = Math.sin(a);
    v.throttle = Math.max(0, Math.sin(t * 1.5 + v.id));
  }
  // Doubled so the preview shows detail; the game uses the default 1x.
  sprites.update(vessels, worldPerPixel(camera, renderer.domElement) * 2);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
