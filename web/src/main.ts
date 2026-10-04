import init, { Game } from './wasm-pkg/orbit_wasm.js';
import { VesselAdvisor } from './advisor/advisor';
import { Pilot } from './autopilot/pilot';
import { pilotCue } from './autopilot/speech';
import { AdvisoryChannel } from './advisor/channel';
import { playerSnapshot } from './advisor/snapshot';
import { LOCK_PROGRESSION, loadMissions } from './missions/load';
import { Progress } from './missions/progress';
import { MissionRun } from './missions/run';
import { FlightView } from './render/view';
import { ZoneLayer } from './render/zones';
import { FlightSession } from './sim/session';
import { bindKeyboard, type ClientControl } from './ui/controls';
import { CommsLog } from './ui/comms';
import { MissionHud, MissionScreens } from './ui/missions';
import { ControlPanel } from './ui/panel';
import { PilotPanel } from './ui/pilot';

async function main(): Promise<void> {
  await init();
  const missions = loadMissions();
  const progress = new Progress(LOCK_PROGRESSION);
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

  // Ship AI hands: flies confirmed maneuvers and speaks through the same advisor.
  let unlistenPilot = (): void => {};
  const attachPilot = (): Pilot => {
    const p = new Pilot(session);
    unlistenPilot = p.subscribe((ev) => {
      const cue = pilotCue(ev, p.speechVars());
      if (cue) advisor.announce(cue, playerSnapshot(session, []), clock());
    });
    return p;
  };
  let pilot = attachPilot();

  /** Every new flight (mission, retry or free flight) starts with a quiet advisor. */
  const switchTo = (next: FlightSession): void => {
    unlistenPilot();
    pilot.dispose();
    session.game.free();
    session = next;
    pilot = attachPilot();
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
  const pilotPanel = new PilotPanel(
    document.body,
    () => pilot,
    () => session,
  );
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
      const snap = playerSnapshot(session, events);
      advisor.observe(snap, now / 1000);
      for (const text of run?.takeCoach() ?? [])
        advisor.announce({ id: 'coach', text }, snap, now / 1000);
    }
    if (run && run.outcome !== 'running' && !debriefed) {
      debriefed = true;
      progress.record(run.def.id, run.stars());
      screens.showResult(run, runIndex);
    }
    const consoleHeight = consoleEl?.offsetHeight ?? 0;
    document.documentElement.style.setProperty('--console-h', `${consoleHeight}px`);
    view.setBottomInset(consoleHeight);
    view.render(session);
    panel.update();
    pilotPanel.update();
    hud.update(run);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
