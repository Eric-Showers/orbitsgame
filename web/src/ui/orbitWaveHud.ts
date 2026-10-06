import type { Pilot } from '../autopilot/pilot';
import type { FlightSession } from '../sim/session';
import { fmtDuration } from './format';
import {
  alignments,
  phaseGap,
  phaseOf,
  phaseTrack,
  plannedBurnsUsable,
  WAVE_HORIZON,
  WAVE_SAMPLES,
} from './orbitWave';
import './orbitWave.css';

export const WAVE_KEY = 'KeyO';
const STORAGE_KEY = 'orbits.wave-visible';
const TAU = Math.PI * 2;
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
 * Beat-matching view: x is game time over the next three hours, y is each ship's angle around the
 * planet. Ships on a lower orbit sweep faster, so the lines drift apart or together, and where they
 * cross the two ships sit on the same bearing. Shown only while a target is selected. Read-only.
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
    head.innerHTML = `<span class="hud-label">ORBIT WAVES · NEXT 3 HOURS</span><span class="wave-legend"><i style="color:${CYAN}">YOU</i><i style="color:${PINK}">TGT</i><i style="color:${AMBER}">┄ AFTER BURN</i><b>${WAVE_KEY.slice(3)}</b></span>`;
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
    const hostile = tgt.team === 1;
    const tgtColor = hostile ? RED : PINK;
    const you = phaseTrack(mu, me.pos, me.vel, WAVE_SAMPLES, WAVE_HORIZON);
    const them = phaseTrack(mu, tgt.pos, tgt.vel, WAVE_SAMPLES, WAVE_HORIZON);
    const plan = this.pilot().proposal?.plan ?? null;
    const burned =
      plan?.feasible && plannedBurnsUsable(me.pos, me.vel, plan.nodes)
        ? phaseTrack(mu, me.pos, me.vel, WAVE_SAMPLES, WAVE_HORIZON, {
            now: s.time,
            nodes: plan.nodes,
          })
        : null;

    const X = (t: number): number => PAD.l + (t / WAVE_HORIZON) * (W - PAD.l - PAD.r);
    const Y = (a: number): number => H - PAD.b - (a / TAU) * (H - PAD.t - PAD.b);
    g.clearRect(0, 0, W, H);

    g.lineWidth = 1;
    g.strokeStyle = 'rgba(29, 74, 94, 0.7)';
    for (let q = 0; q <= 4; q++) {
      const y = Y((q * TAU) / 4);
      g.beginPath();
      g.moveTo(PAD.l, y);
      g.lineTo(W - PAD.r, y);
      g.stroke();
      this.text(g, `${q * 90}°`, PAD.l - 4, y + 3, DIM, 'right');
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

    this.stroke(g, them, tgtColor, false, X, Y);
    this.stroke(g, you, CYAN, false, X, Y);
    if (burned) this.stroke(g, burned, AMBER, true, X, Y);

    const meets = alignments(you, them, WAVE_HORIZON);
    for (const t of meets) this.ring(g, X(t), Y(trackAt(you, t)), CYAN, fmtOffset(t));
    const burnedMeets = burned ? alignments(burned, them, WAVE_HORIZON) : [];
    for (const t of burnedMeets) this.ring(g, X(t), Y(trackAt(burned!, t)), AMBER, fmtOffset(t));

    this.dot(g, X(0), Y(you[0]), CYAN);
    this.dot(g, X(0), Y(them[0]), tgtColor);

    const gap = phaseGap(phaseOf(tgt.pos), phaseOf(me.pos));
    let readout = `PHASE ${gap >= 0 ? '+' : ''}${Math.round((gap * 180) / Math.PI)}° · TGT ${gap >= 0 ? 'AHEAD' : 'BEHIND'} · ${
      meets.length ? `NEXT ALIGN ${fmtOffset(meets[0])}` : 'NO ALIGNMENT IN 3 H'
    }`;
    if (burned)
      readout += ` · AFTER BURN ${burnedMeets.length ? `ALIGN ${fmtOffset(burnedMeets[0])}` : 'NO ALIGNMENT'}`;
    if (this.readout.textContent !== readout) this.readout.textContent = readout;
  }

  /** One track as a line; where the angle wraps past 0/360 the line runs to the edge and restarts on the other. */
  private stroke(
    g: CanvasRenderingContext2D,
    track: readonly number[],
    color: string,
    dashed: boolean,
    X: (t: number) => number,
    Y: (a: number) => number,
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
    for (let i = 1; i < track.length; i++) {
      const prev = track[i - 1];
      const cur = track[i];
      if (Math.abs(cur - prev) > Math.PI) {
        const up = prev > cur;
        const span = up ? cur + TAU - prev : cur - TAU - prev;
        const x = X((i - 1 + (up ? TAU - prev : -prev) / span) * step);
        g.lineTo(x, Y(up ? TAU : 0));
        g.moveTo(x, Y(up ? 0 : TAU));
      }
      g.lineTo(X(i * step), Y(cur));
    }
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
    g.arc(x, y, 4, 0, TAU);
    g.stroke();
    g.fill();
  }

  private ring(
    g: CanvasRenderingContext2D,
    x: number,
    y: number,
    color: string,
    label: string,
  ): void {
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(x, y, 5.5, 0, TAU);
    g.stroke();
    this.text(g, label, x, y < H / 2 ? y + 16 : y - 9, color, x > W - 50 ? 'right' : 'center');
  }
}

const fmtOffset = (t: number): string => `+${fmtDuration(t).replace(/^00:/, '')}`;

/** Track value at an arbitrary offset, by nearest sample. */
function trackAt(track: readonly number[], t: number): number {
  return track[
    Math.max(0, Math.min(track.length - 1, Math.round((t / WAVE_HORIZON) * (track.length - 1))))
  ];
}

function loadVisible(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}
