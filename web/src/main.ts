import init, { Game } from './wasm-pkg/orbit_wasm.js';
import { FlightView } from './render/view';
import { FlightSession } from './sim/session';
import { bindKeyboard, type ClientControl } from './ui/controls';
import { ControlPanel } from './ui/panel';

async function main(): Promise<void> {
  await init();
  let session = new FlightSession(new Game());
  const view = new FlightView(document.body, session.planetRadius);

  const client: ClientControl = {
    zoomBy: (f) => view.zoomBy(f),
    toggleFocus: () => view.toggleFocus(),
    restart: () => {
      session.game.free();
      session = new FlightSession(new Game());
    },
  };
  const panel = new ControlPanel(document.body, () => session, client);
  bindKeyboard(() => session, client);
  const consoleEl = document.querySelector<HTMLElement>('.console');

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = (now - last) / 1000;
    last = now;
    session.update(dt);
    view.showEvents(session.takeEvents());
    view.setBottomInset(consoleEl?.offsetHeight ?? 0);
    view.render(session);
    panel.update();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
