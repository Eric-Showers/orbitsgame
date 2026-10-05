import type { Pilot } from '../autopilot/pilot';
import { EntityKind, len, SHIP_CLASS_NAMES } from '../sim/bridge';
import type { FlightSession } from '../sim/session';
import { fmtDistance, fmtDuration, fmtPercent, fmtSpeed } from './format';
import {
  munitionStats,
  orbitStats,
  resourceStats,
  targetStats,
  TcaCache,
  type MunitionStats,
  type OrbitStats,
} from './hudData';
import { highGround } from './highGround';
import { OrbitWaveHud } from './orbitWaveHud';
import './hud.css';

/** Declutter levels, cycled with `I`. */
export const HUD_MODES = ['full', 'combat', 'min', 'off'] as const;
export type HudMode = (typeof HUD_MODES)[number];
export const HUD_KEY = 'KeyI';
const STORAGE_KEY = 'orbits.hud-mode';
/** Most munition rows shown at once; the nearest to impact come first. */
const MAX_ROWS = 4;
const HOT = 0.7;
const CRITICAL = 0.9;

const TEAM_CLASS = ['own', 'hostile', 'neutral'];

/**
 * Fixed-position flight HUD (docs/hud-design.md). Read-only: it only reads the session,
 * so it never takes a key the console owns except its own declutter key.
 */
export class FlightHud {
  readonly root = div('hud');
  private mode: HudMode = loadMode();
  private cache = new TcaCache();
  private peak = { session: null as FlightSession | null, missiles: 0, mines: 0 };

  private stack = div('hud-stack');
  private own = div('hud-strip hud-own l1');
  private ownAp = field(this.own, 'AP');
  private ownPe = field(this.own, 'PE');
  private ownMinor = div('hud-minor');
  private target = div('hud-strip hud-target l2');
  private tgtHead = div('hud-head-row');
  private tgtRows = div('hud-minor');
  private tgtOrbit = div('hud-minor l3');
  private tgtGround = div('hud-minor hud-ground');
  private resources = div('hud-strip hud-resources l1');
  private heatFill = div('hud-bar-fill');
  private heatText = span('hud-bar-text');
  private heatNote = span('hud-note');
  private pips = { missiles: div('hud-pips'), mines: div('hud-pips') };
  private munitions = div('hud-side hud-munitions l2');
  private warn = div('hud-warning l1');
  private toast = div('hud-toast');
  private toastTimer = 0;
  private last = new Map<HTMLElement, string>();
  private wave: OrbitWaveHud;

  constructor(
    parent: HTMLElement,
    private session: () => FlightSession,
    pilot: () => Pilot,
  ) {
    this.own.append(this.ownMinor);
    this.target.append(this.tgtHead, this.tgtRows, this.tgtOrbit, this.tgtGround);

    const heat = div('hud-heat');
    const bar = div('hud-bar');
    bar.append(this.heatFill);
    heat.append(label('THERMAL'), bar, this.heatText, this.heatNote);
    this.resources.append(heat, row('MISSILES', this.pips.missiles), row('MINES', this.pips.mines));

    this.stack.append(this.own, this.target, this.resources, this.warn);
    this.root.append(this.stack, this.munitions, this.toast);
    parent.append(this.root);
    this.wave = new OrbitWaveHud(this.root, session, pilot);
    window.addEventListener('keydown', (ev) => {
      if (ev.code !== HUD_KEY || ev.repeat || ev.target instanceof HTMLInputElement) return;
      this.cycleMode();
    });
    this.applyMode();
  }

  get currentMode(): HudMode {
    return this.mode;
  }

  cycleMode(): void {
    this.setMode(HUD_MODES[(HUD_MODES.indexOf(this.mode) + 1) % HUD_MODES.length]);
  }

  setMode(mode: HudMode): void {
    this.mode = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // storage can be blocked; the mode just won't persist
    }
    this.applyMode();
    this.toast.textContent = `HUD ${mode.toUpperCase()} · ${HUD_KEY.slice(3)}`;
    this.toast.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('show'), 1500);
  }

  private applyMode(): void {
    this.root.dataset.mode = this.mode;
  }

  update(): void {
    if (this.mode === 'off') return;
    const s = this.session();
    const me = s.player();
    const R = s.planetRadius;
    const o = me.alive ? s.orbit(me.id) : null;
    const os = o ? orbitStats(o, R) : null;

    this.setOwnOrbit(os, me.alive ? me.pos : null, me.vel, R);

    const target = s.entity(me.target);
    const showTarget = me.alive && target?.alive === true;
    this.target.hidden = !showTarget;
    if (showTarget && target) this.setTarget(s, me, target);

    const res = resourceStats(s, me);
    if (this.peak.session !== s) this.peak = { session: s, missiles: 0, mines: 0 };
    this.peak.missiles = Math.max(this.peak.missiles, res.missiles);
    this.peak.mines = Math.max(this.peak.mines, res.mines);
    const heat = Math.max(0, Math.min(1, res.heat));
    this.heatFill.style.width = fmtPercent(heat);
    this.heatFill.className = `hud-bar-fill ${heat >= CRITICAL ? 'crit' : heat >= HOT ? 'warn' : ''}`;
    this.text(
      this.heatText,
      `${fmtPercent(heat)}${res.heatRate !== null ? ` ${res.heatRate >= 0 ? '▲' : '▼'}` : ''}`,
    );
    this.text(this.heatNote, res.outputCap < 1 ? `CAP ${fmtPercent(res.outputCap)}` : '');
    this.setPips(this.pips.missiles, res.missiles, this.peak.missiles);
    this.setPips(this.pips.mines, res.mines, this.peak.mines);

    this.setMunitions(munitionStats(s));
    this.wave.update();

    let warn = '';
    if (!me.alive) warn = '';
    else if (heat >= CRITICAL) warn = 'THERMAL LIMIT · CUT THROTTLE';
    else if (heat >= HOT) warn = 'HEAT BUILDING';
    this.text(this.warn, warn);
    this.warn.classList.toggle('crit', heat >= CRITICAL);
    this.warn.hidden = warn === '';
  }

  private setOwnOrbit(
    os: OrbitStats | null,
    pos: { x: number; y: number; z: number } | null,
    vel: { x: number; y: number; z: number },
    R: number,
  ): void {
    this.own.hidden = false;
    this.own.classList.toggle('open', os?.open === true);
    this.text(this.ownAp.value, os ? (os.apAlt === null ? 'ESCAPE' : fmtDistance(os.apAlt)) : '—');
    this.text(this.ownAp.eta, os && os.apEta !== null ? `+${fmtDuration(os.apEta)}` : '');
    this.text(this.ownPe.value, os ? fmtDistance(os.peAlt) : '—');
    this.text(this.ownPe.eta, os ? `+${fmtDuration(os.peEta)}` : '');
    this.ownPe.root.classList.toggle('crit', os !== null && os.peAlt < 0);
    const alt = pos ? Math.hypot(pos.x, pos.y, pos.z) - R : null;
    this.text(
      this.ownMinor,
      os
        ? `ECC ${os.ecc.toFixed(4)} · PER ${fmtDuration(os.period)} · ALT ${alt === null ? '—' : fmtDistance(alt)} · VEL ${fmtSpeed(Math.hypot(vel.x, vel.y, vel.z))}`
        : '',
    );
  }

  private setTarget(
    s: FlightSession,
    me: ReturnType<FlightSession['player']>,
    target: NonNullable<ReturnType<FlightSession['entity']>>,
  ): void {
    const t = targetStats(s, me, target, this.cache);
    const name = `${SHIP_CLASS_NAMES[t.shipClass] ?? '?'} #${t.id}`.toUpperCase();
    this.target.dataset.team = TEAM_CLASS[t.team] ?? 'neutral';
    this.text(
      this.tgtHead,
      `◇ ${name} · RNG ${fmtDistance(t.range)} · ${t.closing < -0.05 ? 'OPN' : 'CLS'} ${fmtSpeed(Math.abs(t.closing))}`,
    );
    this.text(
      this.tgtRows,
      `REL ${fmtSpeed(t.relSpeed)} · TCA ${t.tca === null ? '—' : fmtDuration(t.tca)}${t.missDistance === null ? '' : ` @ ${fmtDistance(t.missDistance)}`} · ΔV MATCH ${fmtSpeed(t.dvMatch)}`,
    );
    const o = t.orbit;
    this.text(
      this.tgtOrbit,
      o
        ? `ORBIT AP ${o.apAlt === null ? 'ESCAPE' : fmtDistance(o.apAlt)} · PE ${fmtDistance(o.peAlt)} · ECC ${o.ecc.toFixed(4)} · PER ${fmtDuration(o.period)}`
        : 'ORBIT —',
    );
    this.setGround(s, me, target);
  }

  private setGround(
    s: FlightSession,
    me: ReturnType<FlightSession['player']>,
    target: NonNullable<ReturnType<FlightSession['entity']>>,
  ): void {
    const mine = s.orbit(me.id);
    const theirs = s.orbit(target.id);
    if (!mine || !theirs) {
      this.text(this.tgtGround, 'GROUND —');
      return;
    }
    const g = highGround(
      s.game.mu(),
      { radius: len(me.pos), semiMajorAxis: mine.eccentricity < 1 ? mine.semiMajorAxis : null },
      { radius: len(target.pos), semiMajorAxis: theirs.eccentricity < 1 ? theirs.semiMajorAxis : null },
    );
    this.tgtGround.dataset.side = g.side;
    const tag = g.side === 'high' ? '▲ HIGH' : g.side === 'low' ? '▼ LOW' : '= EVEN';
    const sign = g.altDiff >= 0 ? '+' : '−';
    this.text(
      this.tgtGround,
      `GROUND ${tag} ${sign}${fmtDistance(Math.abs(g.altDiff))} · DRIFT ${fmtSpeed(g.drift)} · KV ${g.kvMargin >= 0 ? 'CATCHES' : 'LOSES'} ${fmtSpeed(Math.abs(g.kvMargin))}`,
    );
  }

  private setMunitions(list: MunitionStats[]): void {
    this.munitions.hidden = list.length === 0;
    const key = list
      .slice(0, MAX_ROWS)
      .map((m) => this.munitionLine(m))
      .join('\n');
    if (this.last.get(this.munitions) === key) return;
    this.last.set(this.munitions, key);
    this.munitions.replaceChildren(
      ...list.slice(0, MAX_ROWS).map((m) => {
        const r = div(`hud-mun ${TEAM_CLASS[m.team] ?? 'neutral'}`);
        r.textContent = this.munitionLine(m);
        return r;
      }),
    );
    if (list.length > MAX_ROWS) {
      const more = div('hud-mun hud-more');
      more.textContent = `+${list.length - MAX_ROWS} MORE`;
      this.munitions.append(more);
    }
  }

  private munitionLine(m: MunitionStats): string {
    const tag = m.kind === EntityKind.Missile ? 'MSL' : 'MINE';
    const t = m.targetId === null ? 'NO LOCK' : `→#${m.targetId} ${fmtDistance(m.range ?? 0)}`;
    const eta = m.tti === null ? '' : ` T-${fmtDuration(m.tti)}`;
    if (m.kind === EntityKind.Mine) {
      const rate = m.chargeRate === null ? '' : ` ${m.chargeRate >= 0 ? '▲' : '▼'}`;
      return `${tag} ${m.id} BAT ${fmtPercent(m.mainFraction)}${rate} ΔV ${Math.round(m.mainDv)} ${m.targetId === null ? 'DORMANT' : t + eta}`;
    }
    const rcs = m.rcsDv === null ? '' : ` RCS ${Math.round(m.rcsDv)}`;
    return `${tag} ${m.id} ΔV ${Math.round(m.mainDv)}${rcs} ${t}${eta}`;
  }

  private setPips(host: HTMLElement, left: number, max: number): void {
    const key = `${left}/${max}`;
    if (this.last.get(host) === key) return;
    this.last.set(host, key);
    host.replaceChildren(
      ...Array.from({ length: max }, (_, i) => div(i < left ? 'pip on' : 'pip')),
      span('hud-count', ` ${left}`),
    );
  }

  private text(el: HTMLElement, value: string): void {
    if (this.last.get(el) !== value) {
      this.last.set(el, value);
      el.textContent = value;
    }
  }
}

function loadMode(): HudMode {
  try {
    const m = localStorage.getItem(STORAGE_KEY);
    if ((HUD_MODES as readonly string[]).includes(m ?? '')) return m as HudMode;
  } catch {
    // fall through to the default
  }
  return 'full';
}

function div(cls: string): HTMLElement {
  const e = document.createElement('div');
  e.className = cls;
  return e;
}

function span(cls: string, text = ''): HTMLElement {
  const e = document.createElement('span');
  e.className = cls;
  e.textContent = text;
  return e;
}

function label(text: string): HTMLElement {
  return span('hud-label', text);
}

function row(title: string, body: HTMLElement): HTMLElement {
  const r = div('hud-row');
  r.append(label(title), body);
  return r;
}

function field(parent: HTMLElement, title: string) {
  const root = div('hud-field');
  const value = span('hud-value');
  const eta = span('hud-eta');
  root.append(label(title), value, eta);
  parent.append(root);
  return { root, value, eta };
}
