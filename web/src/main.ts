import init, { Game } from './wasm-pkg/orbit_wasm.js';
import { VesselAdvisor } from './advisor/advisor';
import { Pilot } from './autopilot/pilot';
import { pilotCue } from './autopilot/speech';
import { AdvisoryChannel } from './advisor/channel';
import { findPersona } from './advisor/personas';
import { SoundDirector } from './audio/director';
import { AudioMixer } from './audio/mixer';
import { playerSnapshot } from './advisor/snapshot';
import { LOCK_PROGRESSION, loadMissions } from './missions/load';
import { Progress } from './missions/progress';
import { MissionRun } from './missions/run';
import { readWorld } from './missions/tutorial';
import { FlightView } from './render/view';
import { InterceptLayer } from './render/intercepts';
import { ZoneLayer } from './render/zones';
import { withSunFromConfig } from './sim/bridge';
import { FlightSession } from './sim/session';
import { bindKeyboard, type ClientControl } from './ui/controls';
import { CommsLog } from './ui/comms';
import { TtsPlayer } from './ui/tts';
import { CommanderName } from './commander';
import { VoiceBar } from './ui/voicebar';
import { MissionHud, MissionScreens } from './ui/missions';
import { ControlPanel } from './ui/panel';
import { AudioPanel } from './ui/audio';
import { PilotPanel } from './ui/pilot';
import { FlightHud } from './ui/hud';
import { AlarmIcons } from './ui/alarms';
import { TutorialGuide } from './ui/tutorial';

async function main(): Promise<void> {
  await init();
  const missions = loadMissions();
  const progress = new Progress(LOCK_PROGRESSION);
  let session = new FlightSession(withSunFromConfig(new Game()));
  /** The mission being flown, or null in free flight. */
  let run: MissionRun | null = null;
  let runIndex = -1;
  let debriefed = false;
  const view = new FlightView(document.body, session.planetRadius);
  view.addLayer((scene) => new ZoneLayer(scene, () => run));
  view.addLayer((scene) => new InterceptLayer(scene));
  // Vessel AI: speaks on one channel; the comms log (and later TTS) listens.
  const voice = new AdvisoryChannel();
  const advisor = new VesselAdvisor(voice);
  const comms = new CommsLog(document.body, voice);
  const tts = new TtsPlayer(voice);
  advisor.setPersona(tts.persona);
  const commander = new CommanderName();
  advisor.setCommander(commander.name);
  commander.subscribe((name) => advisor.setCommander(name));
  new VoiceBar(
    comms.box,
    tts,
    (id) => {
      const persona = findPersona(id);
      tts.setPersona(persona);
      advisor.setPersona(persona);
    },
    commander,
  );
  const clock = (): number => performance.now() / 1000;
  // Tutorial levels: the ship AI offers a guided script. Built before the mission screens so its
  // question gets the keyboard first.
  let pilotPanel: PilotPanel | null = null;
  const tutorial = new TutorialGuide(document.body, {
    say: (id, text) => advisor.announce({ id, text }, playerSnapshot(session, []), clock()),
    setAltitude: (km) => pilotPanel?.setAltitude(km),
    onGuided: (on) => advisor.setGuided(on),
  });
  // Sound: shipboard and cockpit buses, driven by sim events, the AI's voice and the pilot.
  const mixer = new AudioMixer();
  const sound = new SoundDirector(mixer);
  voice.subscribe((ev) => sound.onAdvisory(ev));
  new AudioPanel(document.body, mixer);

  // Ship AI hands: flies confirmed maneuvers and speaks through the same advisor.
  let unlistenPilot = (): void => {};
  const attachPilot = (): Pilot => {
    const p = new Pilot(session);
    unlistenPilot = p.subscribe((ev) => {
      sound.onPilot(ev);
      const cue = pilotCue(ev, p.speechVars());
      const snap = playerSnapshot(session, []);
      if (cue) advisor.announce(cue, snap, clock());
      if (ev.kind === 'done') advisor.guide(ev.maneuver.kind, snap, clock());
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
    view.resetCamera();
    pilot = attachPilot();
    advisor.reset();
    comms.clear();
    sound.reset();
  };
  const startMission = (index: number): void => {
    run = new MissionRun(withSunFromConfig(new Game()), missions[index]);
    runIndex = index;
    debriefed = false;
    switchTo(run.session);
    tutorial.offer(missions[index]);
  };
  const freeFlight = (): void => {
    run = null;
    switchTo(new FlightSession(withSunFromConfig(new Game())));
    tutorial.end();
  };

  const client: ClientControl = {
    zoomBy: (f) => view.zoomBy(f),
    toggleFocus: () => view.toggleFocus(),
    cycleFocus: (d) => view.cycleFocus(d),
    focusOnTarget: () => view.focusOnTarget(),
    toggleFreeCamera: () => view.toggleFreeCamera(),
    recentre: () => view.recentre(),
    setPan: (x, y) => view.setPan(x, y),
    restart: () => (run ? startMission(runIndex) : freeFlight()),
    onAction: (action, ok) => {
      tutorial.press(action.id, ok);
      advisor.acknowledge({ id: action.id, ok }, playerSnapshot(session, []), clock());
    },
  };
  const panel = new ControlPanel(document.body, () => session, client);
  const flightHud = new FlightHud(
    document.body,
    () => session,
    () => pilot,
  );
  const alarms = new AlarmIcons(document.body, () => session, voice);
  const hud = new MissionHud(document.body);
  const screens = new MissionScreens(document.body, missions, progress, {
    launch: startMission,
    freeFlight,
  });
  bindKeyboard(() => session, client);
  const consoleEl = document.querySelector<HTMLElement>('.console');
  pilotPanel = new PilotPanel(
    consoleEl ?? document.body,
    () => pilot,
    () => session,
  );
  screens.showBoard();

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = (now - last) / 1000;
    last = now;
    // The flight (and the advisor watching it) holds still while a mission screen is up.
    if (!screens.open && !tutorial.asking) {
      let events;
      if (run) {
        events = run.update(dt);
      } else {
        session.update(dt);
        events = session.takeEvents();
      }
      view.showEvents(events);
      sound.onSimEvents(events);
      const snap = playerSnapshot(session, events, run?.objectiveView() ?? null);
      advisor.setManeuvering(pilot.busy);
      advisor.observe(snap, now / 1000);
      // A guided tutorial speaks its own script; the level's coaching lines would talk over it.
      for (const text of run?.takeCoach() ?? [])
        if (!tutorial.guided) advisor.announce({ id: 'coach', text }, snap, now / 1000);
      if (run && tutorial.guided)
        tutorial.update(session, readWorld(session, pilot, run), run.ids, dt);
    }
    const me = session.player();
    sound.onFrame({
      dt,
      simTime: session.time,
      paused: session.paused || screens.open || tutorial.asking,
      alive: me.alive,
      warp: session.effectiveWarp(),
      throttle: me.throttle,
      heading: me.heading,
      pos: me.pos,
      pilotStatus: pilot.status,
    });
    if (run && run.outcome !== 'running' && !debriefed) {
      debriefed = true;
      tutorial.end();
      progress.record(run.def.id, run.stars());
      screens.showResult(run, runIndex);
    }
    const consoleHeight = consoleEl?.offsetHeight ?? 0;
    document.documentElement.style.setProperty('--console-h', `${consoleHeight}px`);
    view.setBottomInset(consoleHeight);
    view.render(session);
    panel.update();
    pilotPanel.update();
    flightHud.update();
    alarms.update();
    hud.update(run);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
