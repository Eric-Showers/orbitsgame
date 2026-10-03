import * as THREE from 'three';

/** World units visible across the shorter screen axis. */
const VIEW_SIZE = 3;

export interface OrbitView {
  setBodyPositions(packed: Float64Array): void;
  render(): void;
}

/**
 * Three.js scene with an orthographic camera looking down the z axis, so
 * planar (z = 0) gameplay reads as 2D while all data stays 3D.
 */
export function createScene(container: HTMLElement): OrbitView {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera();
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);

  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const aspect = w / h;
    const half = VIEW_SIZE / 2;
    camera.left = -half * Math.max(aspect, 1);
    camera.right = half * Math.max(aspect, 1);
    camera.top = half / Math.min(aspect, 1);
    camera.bottom = -half / Math.min(aspect, 1);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', resize);
  resize();

  const central = new THREE.Mesh(
    new THREE.CircleGeometry(0.15, 48),
    new THREE.MeshBasicMaterial({ color: 0x3377ff }),
  );
  scene.add(central);

  const bodyGeometry = new THREE.CircleGeometry(0.04, 24);
  const bodyMaterial = new THREE.MeshBasicMaterial({ color: 0xffcc66 });
  const bodies: THREE.Mesh[] = [];

  return {
    setBodyPositions(packed) {
      const count = packed.length / 3;
      while (bodies.length < count) {
        const mesh = new THREE.Mesh(bodyGeometry, bodyMaterial);
        scene.add(mesh);
        bodies.push(mesh);
      }
      for (let i = 0; i < count; i++) {
        bodies[i].position.set(packed[3 * i], packed[3 * i + 1], packed[3 * i + 2]);
      }
    },
    render() {
      renderer.render(scene, camera);
    },
  };
}
