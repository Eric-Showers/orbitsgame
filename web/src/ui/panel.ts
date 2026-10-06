import { Attitude, dot, len, sub, SHIP_CLASS_NAMES } from '../sim/bridge';
import { type FlightSession, WARP_LEVELS } from '../sim/session';
import {
  ACTIONS,
  applyAction,
  type ClientControl,
  type ControlAction,
  type ControlGroup,
} from './controls';
import { fmtDistance, fmtDuration, fmtPercent, fmtSpeed } from './format';
import './panel.css';

interface Readout {
  set(value: string): void;
}

/** Sci-fi flight console: clickable controls (mirroring the keyboard) plus readouts. */
export class ControlPanel {
  private buttons = new Map<string, HTMLButtonElement>();
  private readouts = new Map<string, Readout>();
  private throttleFill: HTMLElement;
  private alert: HTMLElement;

  constructor(
    root: HTMLElement,
    private session: () => FlightSession,
    client: ClientControl,
  ) {
    const console_ = el('div', 'console');
    root.appendChild(console_);

    const attitude = module(console_, 'ATTITUDE CONTROL', 'attitude');
    const grid = el('div', 'grid');
    attitude.appendChild(grid);
    this.addButtons(grid, 'attitude', client);
    const rot = el('div', 'row');
    attitude.appendChild(rot);
    this.addButtons(rot, 'rotate', client);

    const engine = module(console_, 'MAIN ENGINE', 'engine');
    const gauge = el('div', 'gauge');
    this.throttleFill = el('div', 'gauge-fill');
    gauge.appendChild(this.throttleFill);
    const engineRow = el('div', 'engine-body');
    engineRow.appendChild(gauge);
    const engineButtons = el('div', 'stack');
    engineRow.appendChild(engineButtons);
    engine.appendChild(engineRow);
    this.addButtons(engineButtons, 'engine', client);
    for (const [k, label] of [
      ['thr', 'THROTTLE'],
      ['heat', 'DRIVE HEAT'],
      ['cap', 'OUTPUT CAP'],
      ['accel', 'MAX ACCEL'],
    ] as const) {
      this.readouts.set(k, readout(engine, label));
    }

    const target = module(console_, 'TARGET', 'target');
    for (const [k, label] of [
      ['tname', 'TRACK'],
      ['range', 'RANGE'],
      ['relv', 'REL VEL'],
      ['closing', 'CLOSING'],
    ] as const) {
      this.readouts.set(k, readout(target, label));
    }
    const targetRow = el('div', 'row');
    target.appendChild(targetRow);
    this.addButtons(targetRow, 'target', client);

    const time = module(console_, 'SHIP TIME', 'time');
    this.readouts.set('met', readout(time, 'MET'));
    this.readouts.set('warp', readout(time, 'WARP'));
    const timeRow = el('div', 'row');
    time.appendChild(timeRow);
    this.addButtons(timeRow, 'time', client);
    const view = module(console_, 'VIEW', 'view');
    const camRow = el('div', 'row');
    view.appendChild(camRow);
    this.addButtons(camRow, 'camera', client);

    this.alert = el('div', 'alert');
    root.appendChild(this.alert);
  }

  private addButtons(parent: HTMLElement, group: ControlGroup, client: ClientControl): void {
    for (const action of ACTIONS.filter((a) => a.group === group)) {
      const b = button(action);
      parent.appendChild(b);
      this.buttons.set(action.id, b);
      if (action.hold) {
        const release = (): void => applyAction(this.session(), client, action, false);
        b.addEventListener('pointerdown', (ev) => {
          b.setPointerCapture(ev.pointerId);
          applyAction(this.session(), client, action, true);
        });
        b.addEventListener('pointerup', release);
        b.addEventListener('pointercancel', release);
      } else {
        b.addEventListener('click', () => applyAction(this.session(), client, action, true));
      }
    }
  }

  /** Refreshes lamps and readouts from the current session state. */
  update(): void {
    const s = this.session();
    const me = s.player();
    const target = s.entity(me.target);

    for (const action of ACTIONS) {
      const b = this.buttons.get(action.id);
      if (!b) continue;
      if (action.attitude !== undefined) {
        b.classList.toggle('active', me.mode === action.attitude);
        const outOfPlane =
          action.attitude === Attitude.Normal || action.attitude === Attitude.AntiNormal;
        const needsTarget =
          action.attitude >= Attitude.Target && action.attitude <= Attitude.TargetRetrograde;
        b.disabled = (outOfPlane && s.game.planar()) || (needsTarget && !target) || !me.alive;
      }
    }
    this.buttons.get('pause')?.classList.toggle('active', s.paused);
    this.buttons.get('throttle-full')?.classList.toggle('active', me.throttle >= 1);
    this.buttons.get('throttle-cut')?.classList.toggle('active', me.throttle === 0);

    const r = this.readouts;

    this.throttleFill.style.height = fmtPercent(me.throttle);
    r.get('thr')?.set(fmtPercent(me.throttle));
    r.get('heat')?.set(fmtPercent(me.heatCapacity > 0 ? me.heat / me.heatCapacity : 0));
    r.get('cap')?.set(fmtPercent(me.outputCap));
    r.get('accel')?.set(`${(me.maxAccel / 9.80665).toFixed(2)} g`);

    if (target) {
      const rel = sub(target.pos, me.pos);
      const relV = sub(target.vel, me.vel);
      const range = len(rel);
      r.get('tname')?.set(`${SHIP_CLASS_NAMES[target.shipClass] ?? '?'} #${target.id}`);
      r.get('range')?.set(fmtDistance(range));
      r.get('relv')?.set(fmtSpeed(len(relV)));
      r.get('closing')?.set(fmtSpeed(range > 0 ? -dot(rel, relV) / range : 0));
    } else {
      for (const k of ['tname', 'range', 'relv', 'closing']) r.get(k)?.set('—');
    }

    const warp = s.effectiveWarp();
    const capped = warp < WARP_LEVELS[s.warpIndex];
    r.get('met')?.set(fmtDuration(s.time));
    r.get('warp')?.set(s.paused ? 'PAUSED' : `×${warp}${capped ? ' (ENGINE)' : ''}`);

    const alert = me.alive ? '' : 'VESSEL LOST · PRESS R TO RESET';
    this.alert.textContent = alert;
    this.alert.classList.toggle('show', alert !== '');
  }
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function module(parent: HTMLElement, title: string, cls: string): HTMLElement {
  const m = el('section', `module ${cls}`);
  const h = el('h2', 'module-title');
  h.textContent = title;
  m.appendChild(h);
  parent.appendChild(m);
  return m;
}

function readout(parent: HTMLElement, label: string): Readout {
  const row = el('div', 'readout');
  const l = el('span', 'readout-label');
  l.textContent = label;
  const v = el('span', 'readout-value');
  row.append(l, v);
  parent.appendChild(row);
  let last = '';
  return {
    set(value) {
      if (value !== last) v.textContent = last = value;
    },
  };
}

function button(action: ControlAction): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `ctl ctl-${action.group}`;
  b.title = `${action.title} [${action.keyHint}]`;
  b.dataset.action = action.id;
  const label = el('span', 'ctl-label');
  label.textContent = action.label;
  const key = el('span', 'ctl-key');
  key.textContent = action.keyHint;
  b.append(label, key);
  // Keep keyboard focus off buttons so Space/keys keep driving the ship.
  b.addEventListener('mousedown', (ev) => ev.preventDefault());
  return b;
}
