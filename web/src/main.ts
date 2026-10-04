import init, { Game } from './wasm-pkg/orbit_wasm.js';
import { VesselAdvisor } from './advisor/advisor';
import { AdvisoryChannel } from './advisor/channel';
import { playerSnapshot } from './advisor/snapshot';
import { FlightView } from './render/view';
import { FlightSession } from './sim/session';
import { bindKeyboard, type ClientControl } from './ui/controls';
import { CommsLog } from './ui/comms';
import { ControlPanel } from './ui/panel';

async function main(): Promise<void> {
  await init();
  let session = new FlightSession(new Game());
  const view = new FlightView(document.body, session.planetRadius);
  // Vessel AI: speaks on one channel; the comms log (and later TTS) listens.
  const voice = new AdvisoryChannel();
  const advisor = new VesselAdvisor(voice);
  const comms = new CommsLog(document.body, voice);
  const clock = (): number => performance.now() / 1000;

  const client: ClientControl = {
    zoomBy: (f) => view.zoomBy(f),
    toggleFocus: () => view.toggleFocus(),
    restart: () => {
      session.game.free();
      session = new FlightSession(new Game());
      advisor.reset();
      comms.clear();
    },
    onAction: (action, ok) =>
      advisor.acknowledge({ id: action.id, ok }, playerSnapshot(session, []), clock()),
  };
  const panel = new ControlPanel(document.body, () => session, client);
  bindKeyboard(() => session, client);
  const consoleEl = document.querySelector<HTMLElement>('.console');

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = (now - last) / 1000;
    last = now;
    session.update(dt);
    const events = session.takeEvents();
    view.showEvents(events);
    advisor.observe(playerSnapshot(session, events), now / 1000);
    view.setBottomInset(consoleEl?.offsetHeight ?? 0);
    view.render(session);
    panel.update();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
