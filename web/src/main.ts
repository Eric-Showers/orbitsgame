import init, { Game } from './wasm-pkg/orbit_wasm.js';
import { VesselAdvisor } from './advisor/advisor';
import { AdvisoryChannel } from './advisor/channel';
import { playerSnapshot } from './advisor/snapshot';
import { loadMissions } from './missions/load';
import { Progress } from './missions/progress';
import { MissionRun } from './missions/run';
import { FlightView } from './render/view';
import { ZoneLayer } from './render/zones';
import { FlightSession } from './sim/session';
import { bindKeyboard, type ClientControl } from './ui/controls';
import { CommsLog } from './ui/comms';
import { MissionHud, MissionScreens } from './ui/missions';
import { ControlPanel } from './ui/panel';

async function main(): Promise<void> {
  await init();
  const missions = loadMissions();
  const progress = new Progress();
  let session = new FlightSession(new Game());
  /** The mission being flown, or null in free flight. */
  let run: MissionRun | null = null;
  let runIndex = -1;
  let debriefed = false;
  const view = new FlightView(document.body, session.planetRadius);
  view.addLayer((scene) => new ZoneLayer(scene, () => run));
  // Vessel AI: speaks on one channel; the comms log (and later TTS) listens.
  const voice = new AdvisoryChannel();
  const advisor = new VesselAdvisor(voice);
  const comms = new CommsLog(document.body, voice);
  const clock = (): number => performance.now() / 1000;

  /** Every new flight (mission, retry or free flight) starts with a quiet advisor. */
  const switchTo = (next: FlightSession): void => {
    session.game.free();
    session = next;
    advisor.reset();
    comms.clear();
  };
  const startMission = (index: number): void => {
    run = new MissionRun(new Game(), missions[index]);
    runIndex = index;
    debriefed = false;
    switchTo(run.session);
  };
  const freeFlight = (): void => {
    run = null;
    switchTo(new FlightSession(new Game()));
  };

  const client: ClientControl = {
    zoomBy: (f) => view.zoomBy(f),
    toggleFocus: () => view.toggleFocus(),
    restart: () => (run ? startMission(runIndex) : freeFlight()),
    onAction: (action, ok) =>
      advisor.acknowledge({ id: action.id, ok }, playerSnapshot(session, []), clock()),
  };
  const panel = new ControlPanel(document.body, () => session, client);
  const hud = new MissionHud(document.body);
  const screens = new MissionScreens(document.body, missions, progress, {
    launch: startMission,
    freeFlight,
  });
  bindKeyboard(() => session, client);
  const consoleEl = document.querySelector<HTMLElement>('.console');
  screens.showBoard();

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = (now - last) / 1000;
    last = now;
    // The flight (and the advisor watching it) holds still while a mission screen is up.
    if (!screens.open) {
      let events;
      if (run) {
        events = run.update(dt);
      } else {
        session.update(dt);
        events = session.takeEvents();
      }
      view.showEvents(events);
      advisor.observe(playerSnapshot(session, events), now / 1000);
    }
    if (run && run.outcome !== 'running' && !debriefed) {
      debriefed = true;
      progress.record(run.def.id, run.stars());
      screens.showResult(run, runIndex);
    }
    view.setBottomInset(consoleEl?.offsetHeight ?? 0);
    view.render(session);
    panel.update();
    hud.update(run);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
