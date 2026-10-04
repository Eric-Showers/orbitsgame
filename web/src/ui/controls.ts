import { Attitude } from '../sim/bridge';
import type { FlightSession } from '../sim/session';

export type ControlGroup = 'attitude' | 'rotate' | 'engine' | 'target' | 'time' | 'camera';

export interface ControlAction {
  id: string;
  group: ControlGroup;
  /** Button caption. */
  label: string;
  /** Tooltip: what it does, in orbital-mechanics terms. */
  title: string;
  /** `KeyboardEvent.code` values that trigger it. */
  keys: string[];
  /** Key hint printed on the button. */
  keyHint: string;
  /** Active while held (button or key) rather than on press. */
  hold?: boolean;
  attitude?: Attitude;
}

const att = (
  attitude: Attitude,
  id: string,
  label: string,
  key: string,
  keyHint: string,
  title: string,
): ControlAction => ({ id, group: 'attitude', label, title, keys: [key], keyHint, attitude });

export const ACTIONS: ControlAction[] = [
  att(
    Attitude.Prograde,
    'prograde',
    'PROGRADE',
    'Digit1',
    '1',
    'Point along your velocity. Burning here raises the far side of your orbit.',
  ),
  att(
    Attitude.Retrograde,
    'retrograde',
    'RETROGRADE',
    'Digit2',
    '2',
    'Point against your velocity. Burning here lowers the far side of your orbit.',
  ),
  att(
    Attitude.RadialOut,
    'radial-out',
    'RADIAL OUT',
    'Digit3',
    '3',
    'Point away from the planet. Burning rotates your orbit around you.',
  ),
  att(Attitude.RadialIn, 'radial-in', 'RADIAL IN', 'Digit4', '4', 'Point toward the planet.'),
  att(
    Attitude.Normal,
    'normal',
    'NORMAL',
    'Digit5',
    '5',
    'Perpendicular to the orbital plane (plane change). Locked while flight is planar.',
  ),
  att(
    Attitude.AntiNormal,
    'anti-normal',
    'ANTI-NORMAL',
    'Digit6',
    '6',
    'Opposite of normal (plane change). Locked while flight is planar.',
  ),
  att(Attitude.Target, 'target', 'TARGET', 'Digit7', '7', 'Point at the selected target.'),
  att(
    Attitude.AntiTarget,
    'anti-target',
    'ANTI-TARGET',
    'Digit8',
    '8',
    'Point away from the selected target.',
  ),
  att(
    Attitude.TargetPrograde,
    'target-prograde',
    'TGT PROGRADE',
    'Digit9',
    '9',
    'Along your velocity relative to the target.',
  ),
  att(
    Attitude.TargetRetrograde,
    'target-retrograde',
    'TGT RETROGRADE',
    'Digit0',
    '0',
    'Against your velocity relative to the target. Burn here to match speed.',
  ),
  att(Attitude.Hold, 'hold', 'HOLD', 'KeyH', 'H', 'Hold the current heading.'),
  {
    id: 'rotate-left',
    group: 'rotate',
    label: '◀ ROTATE',
    title: 'Turn counter-clockwise (switches to HOLD).',
    keys: ['KeyA'],
    keyHint: 'A',
    hold: true,
  },
  {
    id: 'rotate-right',
    group: 'rotate',
    label: 'ROTATE ▶',
    title: 'Turn clockwise (switches to HOLD).',
    keys: ['KeyD'],
    keyHint: 'D',
    hold: true,
  },
  {
    id: 'throttle-up',
    group: 'engine',
    label: 'THR +',
    title: 'Increase throttle while held.',
    keys: ['ShiftLeft', 'ShiftRight', 'KeyW'],
    keyHint: '⇧/W',
    hold: true,
  },
  {
    id: 'throttle-down',
    group: 'engine',
    label: 'THR −',
    title: 'Decrease throttle while held.',
    keys: ['ControlLeft', 'ControlRight', 'KeyS'],
    keyHint: 'Ctrl/S',
    hold: true,
  },
  {
    id: 'throttle-full',
    group: 'engine',
    label: 'FULL',
    title: 'Full throttle.',
    keys: ['KeyZ'],
    keyHint: 'Z',
  },
  {
    id: 'throttle-cut',
    group: 'engine',
    label: 'CUT',
    title: 'Engine cut-off.',
    keys: ['KeyX'],
    keyHint: 'X',
  },
  {
    id: 'target-next',
    group: 'target',
    label: 'NEXT TARGET',
    title: 'Cycle target, nearest first.',
    keys: ['KeyT', 'Tab'],
    keyHint: 'T',
  },
  {
    id: 'target-clear',
    group: 'target',
    label: 'CLEAR',
    title: 'Clear target.',
    keys: ['Backspace'],
    keyHint: '⌫',
  },
  {
    id: 'fire-missile',
    group: 'target',
    label: 'MISSILE',
    title: 'Launch a missile at the target. It guides itself until its delta-v runs out.',
    keys: ['KeyF'],
    keyHint: 'F',
  },
  {
    id: 'drop-mine',
    group: 'target',
    label: 'MINE',
    title: 'Leave a mine on your orbit. It sleeps until an enemy passes within 5 km.',
    keys: ['KeyM'],
    keyHint: 'M',
  },
  {
    id: 'pause',
    group: 'time',
    label: 'PAUSE',
    title: 'Pause / resume.',
    keys: ['KeyP', 'Space'],
    keyHint: 'P',
  },
  {
    id: 'warp-down',
    group: 'time',
    label: '◀◀',
    title: 'Slower time warp.',
    keys: ['Comma'],
    keyHint: ',',
  },
  {
    id: 'warp-up',
    group: 'time',
    label: '▶▶',
    title: 'Faster time warp (capped at 4x while the engine fires).',
    keys: ['Period'],
    keyHint: '.',
  },
  {
    id: 'restart',
    group: 'time',
    label: 'RESET',
    title: 'Restart the flight.',
    keys: ['KeyR'],
    keyHint: 'R',
  },
  {
    id: 'zoom-in',
    group: 'camera',
    label: 'ZOOM +',
    title: 'Zoom in (or mouse wheel).',
    keys: ['Equal', 'NumpadAdd'],
    keyHint: '+',
  },
  {
    id: 'zoom-out',
    group: 'camera',
    label: 'ZOOM −',
    title: 'Zoom out (or mouse wheel).',
    keys: ['Minus', 'NumpadSubtract'],
    keyHint: '−',
  },
  {
    id: 'focus',
    group: 'camera',
    label: 'FOCUS',
    title: 'Toggle camera focus between ship and planet.',
    keys: ['KeyC'],
    keyHint: 'C',
  },
];

const BY_KEY = new Map<string, ControlAction>(ACTIONS.flatMap((a) => a.keys.map((k) => [k, a])));

export function actionForKey(code: string): ControlAction | undefined {
  return BY_KEY.get(code);
}

/** Client-side controls that live outside the sim. */
export interface ClientControl {
  zoomBy(factor: number): void;
  toggleFocus(): void;
  restart(): void;
  /** Told about every pressed action after it is applied; `ok` is false if the ship refused it. */
  onAction?(action: ControlAction, ok: boolean): void;
}

/** Applies a control action. `pressed` is false only for the release of a hold action. */
export function applyAction(
  session: FlightSession,
  client: ClientControl,
  action: ControlAction,
  pressed: boolean,
): void {
  const ok = dispatch(session, client, action, pressed);
  if (pressed) client.onAction?.(action, ok !== false);
}

function dispatch(
  session: FlightSession,
  client: ClientControl,
  action: ControlAction,
  pressed: boolean,
): boolean | void {
  if (action.attitude !== undefined) {
    if (pressed) return session.setAttitude(action.attitude);
    return;
  }
  switch (action.id) {
    case 'rotate-left':
      return session.setRotate(pressed ? 1 : 0);
    case 'rotate-right':
      return session.setRotate(pressed ? -1 : 0);
    case 'throttle-up':
      session.throttleRamp = pressed ? 1 : 0;
      return;
    case 'throttle-down':
      session.throttleRamp = pressed ? -1 : 0;
      return;
  }
  if (!pressed) return;
  switch (action.id) {
    case 'throttle-full':
      return session.setThrottle(1);
    case 'throttle-cut':
      return session.setThrottle(0);
    case 'target-next':
      return session.cycleTarget();
    case 'target-clear':
      return session.setTarget(null);
    case 'fire-missile':
      return session.fireMissile();
    case 'drop-mine':
      return session.dropMine();
    case 'pause':
      session.paused = !session.paused;
      return;
    case 'warp-down':
      return session.setWarp(session.warpIndex - 1);
    case 'warp-up':
      return session.setWarp(session.warpIndex + 1);
    case 'zoom-in':
      return client.zoomBy(0.5);
    case 'zoom-out':
      return client.zoomBy(2);
    case 'focus':
      return client.toggleFocus();
    case 'restart':
      return client.restart();
  }
}

/** Wires keyboard events to actions. Returns a function that removes the listeners. */
export function bindKeyboard(session: () => FlightSession, client: ClientControl): () => void {
  const down = (ev: KeyboardEvent): void => {
    if (ev.target instanceof HTMLInputElement) return; // typing in a field
    const action = actionForKey(ev.code);
    if (!action) return;
    ev.preventDefault();
    if (ev.repeat) return;
    applyAction(session(), client, action, true);
  };
  const up = (ev: KeyboardEvent): void => {
    if (ev.target instanceof HTMLInputElement) return;
    const action = actionForKey(ev.code);
    if (action?.hold) applyAction(session(), client, action, false);
  };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  return () => {
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
  };
}
