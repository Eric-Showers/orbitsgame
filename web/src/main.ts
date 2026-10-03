import init, { Sim } from './wasm-pkg/orbit_wasm.js';
import { createScene } from './scene';

// Smoke test: the Rust sim (compiled to WASM) integrates one body around a
// central mass; Three.js draws it with an orthographic top-down camera.
const SIM_DT = 1 / 120;

async function main(): Promise<void> {
  await init();
  const sim = new Sim(1.0);
  sim.add_circular_orbit(1.0);

  const view = createScene(document.body);
  const hud = document.getElementById('hud');

  let last = performance.now();
  let acc = 0;
  const frame = (now: number): void => {
    // Fixed timestep keeps the sim deterministic regardless of frame rate.
    acc += Math.min((now - last) / 1000, 0.25);
    last = now;
    while (acc >= SIM_DT) {
      sim.step(SIM_DT);
      acc -= SIM_DT;
    }
    view.setBodyPositions(sim.positions());
    view.render();
    if (hud) hud.textContent = `t = ${sim.time().toFixed(2)}  bodies = ${sim.body_count()}`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
