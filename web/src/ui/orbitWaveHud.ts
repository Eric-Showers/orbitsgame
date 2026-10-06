import type { Pilot } from '../autopilot/pilot';
import type { FlightSession } from '../sim/session';
import { fmtDistance } from './format';
import {
  apoapsisOf,
  periapsisOf,
  phaseOf,
  projectBurns,
  sampleWave,
  waveCrossings,
  waveOf,
  waveRadius,
  type WaveOrbit,
} from './orbitWave';
import './orbitWave.css';

export const WAVE_KEY = 'KeyO';
const STORAGE_KEY = 'orbits.wave-visible';
const W = 680;
const H = 130;
const PAD = { l: 6, r: 6, t: 16, b: 16 };
const SAMPLES = 181;
const REFRESH_MS = 250;
const CYAN = '#3fd2ff';
const PINK = '#ff9ae9';
const RED = '#ff4d5e';
const AMBER = '#ffb547';
const DIM = '#5c8797';

interface Layer {
  wave: WaveOrbit;
  color: string;
  dashed: boolean;
}

/**
 * Unrolled orbits, shown only while a target is selected: x is inertial angle over one turn, y is altitude, so every orbit is a wave whose
 * crest is Ap and trough is Pe. Own ship, tracked target and the orbit a planned burn would leave us in
 * share the plot; where waves cross, the orbits intersect. Read-only, like the rest of the HUD.
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
    head.innerHTML = `<span class="hud-label">ORBIT WAVES · ALTITUDE vs ANGLE</span><span class="wave-legend"><i style="color:${CYAN}">YOU</i><i style="color:${PINK}">TGT</i><i style="color:${AMBER}">┄ AFTER BURN</i><b>${WAVE_KEY.slice(3)}</b></span>`;
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
    if (!on || !this.ctx2d) return;
    const now = performance.now();
    if (now - this.lastDraw < REFRESH_MS) return;
    this.lastDraw = now;
    this.draw(this.ctx2d);
  }

  private setShown(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.root.hidden = !on;
  }

  private draw(g: CanvasRenderingContext2D): void {
    const s = this.session();
    const me = s.player();
    const R = s.planetRadius;
    g.clearRect(0, 0, W, H);
    const ownO = me.alive ? s.orbit(me.id) : null;
    if (!ownO) {
      this.text(g, 'NO ORBIT SOLUTION', W / 2, H / 2, DIM, 'center');
      this.readout.textContent = '';
      return;
    }
    const own = waveOf(ownO);
    const tgtEnt = s.entity(me.target);
    const tgtO = tgtEnt?.alive ? s.orbit(tgtEnt.id) : null;
    const tgt = tgtO ? waveOf(tgtO) : null;
    const hostile = tgtEnt?.team === 1;

    const pilot = this.pilot();
    const plan = pilot.proposal?.plan ?? null;
    const burns = plan?.feasible
      ? projectBurns(s.game.mu(), me.pos, me.vel, s.time, plan.nodes)
      : [];

    const layers: Layer[] = [];
    if (tgt) layers.push({ wave: tgt, color: hostile ? RED : PINK, dashed: false });
    layers.push({ wave: own, color: CYAN, dashed: false });
    for (const b of burns) layers.push({ wave: b.after, color: AMBER, dashed: true });

    // Vertical range from every apsis shown; open orbits only contribute their periapsis.
    let lo = Infinity;
    let hi = -Infinity;
    for (const { wave } of layers) {
      lo = Math.min(lo, periapsisOf(wave));
      const ap = apoapsisOf(wave);
      if (ap !== null) hi = Math.max(hi, ap);
    }
    if (!Number.isFinite(hi)) hi = lo * 2;
    if (hi - lo < 2_000) {
      const mid = (hi + lo) / 2;
      lo = mid - 1_000;
      hi = mid + 1_000;
    }
    const span = hi - lo;
    lo -= span * 0.08;
    hi += span * 0.08;
    const X = (th: number): number => PAD.l + (th / (Math.PI * 2)) * (W - PAD.l - PAD.r);
    const Y = (r: number): number => H - PAD.b - ((r - lo) / (hi - lo)) * (H - PAD.t - PAD.b);

    // Frame: surface line if on screen, quarter-turn ticks.
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(29, 74, 94, 0.7)';
    for (let q = 0; q <= 4; q++) {
      g.beginPath();
      g.moveTo(X((q * Math.PI) / 2), PAD.t);
      g.lineTo(X((q * Math.PI) / 2), H - PAD.b);
      g.stroke();
      this.text(
        g,
        `${q * 90}°`,
        X((q * Math.PI) / 2),
        H - 4,
        DIM,
        q === 0 ? 'left' : q === 4 ? 'right' : 'center',
      );
    }
    if (R >= lo && R <= hi) {
      g.strokeStyle = 'rgba(255, 77, 94, 0.5)';
      g.beginPath();
      g.moveTo(PAD.l, Y(R));
      g.lineTo(W - PAD.r, Y(R));
      g.stroke();
      this.text(g, 'SURFACE', W - PAD.r, Y(R) - 3, 'rgba(255,77,94,0.7)', 'right');
    }

    // Waves, back to front: target, own, post-burn.
    for (const l of layers) this.stroke(g, l, X, Y, hi);

    // Crossings with the target: now (own) and after the final burn (amber).
    if (tgt) {
      for (const th of waveCrossings(own, tgt))
        this.ring(g, X(th), Y(waveRadius(own, th) ?? 0), CYAN);
      const last = burns[burns.length - 1];
      if (last) {
        for (const th of waveCrossings(last.after, tgt))
          this.ring(g, X(th), Y(waveRadius(last.after, th) ?? 0), AMBER);
      }
    }

    // Burn points on the wave they leave.
    for (const b of burns) this.diamond(g, X(b.theta), Y(b.radius), AMBER);

    // Apsis labels.
    const ownTag = this.apsisLabels(g, own, R, CYAN, X, Y, false);
    if (tgt) this.apsisLabels(g, tgt, R, hostile ? RED : PINK, X, Y, true);
    const last = burns[burns.length - 1];
    if (last) this.apsisLabels(g, last.after, R, AMBER, X, Y, null);

    // Current positions.
    const ownPhase = phaseOf(me.pos);
    this.dot(g, X(ownPhase), Y(Math.hypot(me.pos.x, me.pos.y)), CYAN);
    let readout = ownTag;
    if (tgtEnt?.alive && tgt) {
      const tp = phaseOf(tgtEnt.pos);
      this.dot(g, X(tp), Y(Math.hypot(tgtEnt.pos.x, tgtEnt.pos.y)), hostile ? RED : PINK);
      let d = ((tp - ownPhase + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      if (d < -Math.PI) d += Math.PI * 2;
      const hiAlt = periapsisOf(tgt) > periapsisOf(own);
      readout = `PHASE ${d >= 0 ? '+' : ''}${Math.round((d * 180) / Math.PI)}° · TGT ${hiAlt ? 'HIGHER' : 'LOWER'} PE · ${waveCrossings(own, tgt).length} CROSSING${waveCrossings(own, tgt).length === 1 ? '' : 'S'}`;
    }
    if (last && plan)
      readout += ` · AFTER BURN PE ${fmtDistance(periapsisOf(last.after) - R)} AP ${apoapsisOf(last.after) === null ? 'ESCAPE' : fmtDistance((apoapsisOf(last.after) ?? 0) - R)}`;
    if (this.readout.textContent !== readout) this.readout.textContent = readout;
  }

  private stroke(
    g: CanvasRenderingContext2D,
    l: Layer,
    X: (t: number) => number,
    Y: (r: number) => number,
    hiR: number,
  ): void {
    const pts = sampleWave(l.wave, SAMPLES, hiR * 1.5);
    g.save();
    g.strokeStyle = l.color;
    g.lineWidth = l.dashed ? 1.5 : 2;
    g.shadowColor = l.color;
    g.shadowBlur = l.dashed ? 0 : 5;
    g.setLineDash(l.dashed ? [5, 4] : []);
    g.beginPath();
    let pen = false;
    pts.forEach((r, i) => {
      if (r === null) {
        pen = false;
        return;
      }
      const x = X((Math.PI * 2 * i) / (SAMPLES - 1));
      const y = Math.max(PAD.t - 6, Math.min(H - PAD.b + 6, Y(r)));
      if (pen) g.lineTo(x, y);
      else g.moveTo(x, y);
      pen = true;
    });
    g.stroke();
    g.restore();
  }

  /** Marks Pe and Ap on a wave; `below` puts the labels under the line (target) instead of over (own). */
  private apsisLabels(
    g: CanvasRenderingContext2D,
    o: WaveOrbit,
    R: number,
    color: string,
    X: (t: number) => number,
    Y: (r: number) => number,
    below: boolean | null,
  ): string {
    const pe = periapsisOf(o);
    const ap = apoapsisOf(o);
    const circular = o.e < 2e-3;
    const peTxt = `PE ${fmtDistance(pe - R)}`;
    const apTxt = ap === null ? '' : `AP ${fmtDistance(ap - R)}`;
    if (!circular) {
      const dy = below === null ? 0 : below ? 11 : -5;
      const place = (th: number, r: number, t: string): void => {
        const x = X(th);
        const align = x < 60 ? 'left' : x > W - 60 ? 'right' : 'center';
        this.text(g, t, x, Math.max(PAD.t - 4, Math.min(H - PAD.b - 2, Y(r) + dy)), color, align);
      };
      if (below !== null || ap === null) place(o.w, pe, peTxt);
      if (ap !== null && below !== null) place(o.w + Math.PI, ap, apTxt);
    }
    return circular ? `CIRCULAR ${fmtDistance(pe - R)}` : `${apTxt} ${peTxt}`.trim();
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

  private ring(g: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(x, y, 5.5, 0, Math.PI * 2);
    g.stroke();
  }

  private diamond(g: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x, y - 5);
    g.lineTo(x + 4, y);
    g.lineTo(x, y + 5);
    g.lineTo(x - 4, y);
    g.closePath();
    g.fill();
  }
}

function loadVisible(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}
