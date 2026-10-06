import type { Pilot } from '../autopilot/pilot';
import type { FlightSession } from '../sim/session';
import { fmtDuration } from './format';
import {
  altitudeOf,
  altitudeTrack,
  plannedBurnsUsable,
  WAVE_HORIZON,
  WAVE_SAMPLES,
} from './orbitWave';
import './orbitWave.css';

export const WAVE_KEY = 'KeyO';
const STORAGE_KEY = 'orbits.wave-visible';
const W = 680;
const H = 130;
const PAD = { l: 36, r: 10, t: 16, b: 16 };
const REFRESH_MS = 250;
const CYAN = '#3fd2ff';
const PINK = '#ff9ae9';
const RED = '#ff4d5e';
const AMBER = '#ffb547';
const DIM = '#5c8797';

/**
 * Orbit view: x is game time over the next three hours, y is each ship's altitude above the surface.
 * Elliptic orbits show as waves, circular ones as flat lines; a dotted red line marks the ground.
 * Shown only while a target is selected. Read-only.
 */
export class OrbitWaveHud {
  readonly root = document.createElement('div');
  private canvas = document.createElement('canvas');
  private readout = document.createElement('div');
  private ctx2d: CanvasRenderingContext2D | null = this.canvas.getContext('2d');
  private visible = loadVisible();
  private lastDraw = 0;
  private shown = false;

  constructor(
    parent: HTMLElement,
    private session: () => FlightSession,
    private pilot: () => Pilot,
  ) {
    this.root.className = 'hud-side hud-wave';
    const head = document.createElement('div');
    head.className = 'wave-head';
    head.innerHTML = `<span class="hud-label">ORBIT WAVES · NEXT 3 HOURS</span><span class="wave-legend"><i style="color:${CYAN}">YOU</i><i style="color:${PINK}">TGT</i><i style="color:${AMBER}">┄ AFTER BURN</i><i style="color:${RED}">··· GROUND</i><b>${WAVE_KEY.slice(3)}</b></span>`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.ctx2d?.scale(dpr, dpr);
    this.readout.className = 'wave-readout';
    this.root.append(head, this.canvas, this.readout);
    parent.append(this.root);
    window.addEventListener('keydown', (ev) => {
      if (ev.code !== WAVE_KEY || ev.repeat || ev.target instanceof HTMLInputElement) return;
      this.setVisible(!this.visible);
    });
    this.root.hidden = true;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    if (!on) this.setShown(false);
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      // storage can be blocked; the choice just won't persist
    }
  }

  update(): void {
    const s = this.session();
    const me = s.player();
    const tgt = me.alive ? s.entity(me.target) : null;
    const on = this.visible && tgt?.alive === true && s.orbit(me.id) !== null;
    this.setShown(on);
    if (!on || !tgt || !this.ctx2d) return;
    const now = performance.now();
    if (now - this.lastDraw < REFRESH_MS) return;
    this.lastDraw = now;
    this.draw(this.ctx2d, s, me, tgt);
  }

  private setShown(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.root.hidden = !on;
  }

  private draw(
    g: CanvasRenderingContext2D,
    s: FlightSession,
    me: ReturnType<FlightSession['player']>,
    tgt: NonNullable<ReturnType<FlightSession['entity']>>,
  ): void {
    const mu = s.game.mu();
    const R = s.planetRadius;
    const tgtColor = tgt.team === 1 ? RED : PINK;
    const you = altitudeTrack(mu, R, me.pos, me.vel, WAVE_SAMPLES, WAVE_HORIZON);
    const them = altitudeTrack(mu, R, tgt.pos, tgt.vel, WAVE_SAMPLES, WAVE_HORIZON);
    const plan = this.pilot().proposal?.plan ?? null;
    const burned =
      plan?.feasible && plannedBurnsUsable(me.pos, me.vel, plan.nodes)
        ? altitudeTrack(mu, R, me.pos, me.vel, WAVE_SAMPLES, WAVE_HORIZON, {
            now: s.time,
            nodes: plan.nodes,
          })
        : null;

    const all = [...you, ...them, ...(burned ?? [])];
    const lo = Math.min(0, ...all);
    const top = Math.max(1000, ...all);
    const pad = (top - lo) * 0.08;
    const [yMin, yMax] = [lo === 0 ? 0 : lo - pad, top + pad];
    const X = (t: number): number => PAD.l + (t / WAVE_HORIZON) * (W - PAD.l - PAD.r);
    const Y = (alt: number): number =>
      H - PAD.b - ((alt - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
    g.clearRect(0, 0, W, H);

    g.lineWidth = 1;
    g.strokeStyle = 'rgba(29, 74, 94, 0.7)';
    const step = niceStep((yMax - yMin) / 4);
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
      const y = Y(v);
      g.beginPath();
      g.moveTo(PAD.l, y);
      g.lineTo(W - PAD.r, y);
      g.stroke();
      this.text(g, `${Math.round(v / 1000)} km`, PAD.l - 4, y + 3, DIM, 'right');
    }
    for (let m = 0; m <= 6; m++) {
      const t = m * 1800;
      g.beginPath();
      g.moveTo(X(t), PAD.t);
      g.lineTo(X(t), H - PAD.b);
      g.stroke();
      this.text(
        g,
        m === 0 ? 'NOW' : `+${Math.floor(m / 2)}:${m % 2 ? '30' : '00'}`,
        X(t),
        H - 4,
        DIM,
        m === 0 ? 'left' : m === 6 ? 'right' : 'center',
      );
    }
    g.save();
    g.strokeStyle = RED;
    g.lineWidth = 1.5;
    g.setLineDash([2, 4]);
    g.beginPath();
    g.moveTo(PAD.l, Y(0));
    g.lineTo(W - PAD.r, Y(0));
    g.stroke();
    g.restore();

    this.stroke(g, them, tgtColor, false, X, Y);
    this.stroke(g, you, CYAN, false, X, Y);
    if (burned) this.stroke(g, burned, AMBER, true, X, Y);
    this.dot(g, X(0), Y(you[0]), CYAN);
    this.dot(g, X(0), Y(them[0]), tgtColor);

    const dh = altitudeOf(tgt.pos, R) - altitudeOf(me.pos, R);
    const km = (m: number): string => `${Math.round(m / 1000).toLocaleString('en-US')} km`;
    let readout = `YOU ${km(altitudeOf(me.pos, R))} · TGT ${km(altitudeOf(tgt.pos, R))} · TGT ${km(Math.abs(dh))} ${dh >= 0 ? 'HIGHER' : 'LOWER'}`;
    const hit = you.findIndex((a) => a < 0);
    if (hit >= 0)
      readout += ` · YOU IMPACT ${fmtOffset((hit * WAVE_HORIZON) / (WAVE_SAMPLES - 1))}`;
    if (this.readout.textContent !== readout) this.readout.textContent = readout;
  }

  /** One altitude track as a line. */
  private stroke(
    g: CanvasRenderingContext2D,
    track: readonly number[],
    color: string,
    dashed: boolean,
    X: (t: number) => number,
    Y: (alt: number) => number,
  ): void {
    const step = WAVE_HORIZON / (track.length - 1);
    g.save();
    g.strokeStyle = color;
    g.lineWidth = dashed ? 1.5 : 2;
    g.shadowColor = color;
    g.shadowBlur = dashed ? 0 : 5;
    g.setLineDash(dashed ? [5, 4] : []);
    g.beginPath();
    g.moveTo(X(0), Y(track[0]));
    for (let i = 1; i < track.length; i++) g.lineTo(X(i * step), Y(track[i]));
    g.stroke();
    g.restore();
  }

  private text(
    g: CanvasRenderingContext2D,
    t: string,
    x: number,
    y: number,
    color: string,
    align: CanvasTextAlign,
  ): void {
    g.font = '9px ui-monospace, monospace';
    g.fillStyle = color;
    g.textAlign = align;
    g.fillText(t, x, y);
  }

  private dot(g: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    g.fillStyle = color;
    g.strokeStyle = '#06121a';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(x, y, 4, 0, Math.PI * 2);
    g.stroke();
    g.fill();
  }
}

const fmtOffset = (t: number): string => `+${fmtDuration(t).replace(/^00:/, '')}`;

/** Rounds a grid spacing up to 1, 2 or 5 times a power of ten. */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  return ([1, 2, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
}

function loadVisible(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}
