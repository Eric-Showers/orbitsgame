import init, { Game } from './wasm-pkg/orbit_wasm.js';
import { loadMissions } from './missions/load';
import { Progress } from './missions/progress';
import { MissionRun } from './missions/run';
import { FlightView } from './render/view';
import { ZoneLayer } from './render/zones';
import { FlightSession } from './sim/session';
import { bindKeyboard, type ClientControl } from './ui/controls';
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

  const switchTo = (next: FlightSession): void => {
    session.game.free();
    session = next;
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
    // The flight holds still while a mission screen is up.
    if (!screens.open) {
      if (run) {
        view.showEvents(run.update(dt));
      } else {
        session.update(dt);
        view.showEvents(session.takeEvents());
      }
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
