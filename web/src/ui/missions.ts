import type { Progress } from '../missions/progress';
import type { MissionRun, ObjectiveStatus } from '../missions/run';
import type { MissionDef } from '../missions/types';
import { fmtDuration, fmtPercent } from './format';
import './missions.css';

export interface ScreenActions {
  launch(index: number): void;
  freeFlight(): void;
}

type Screen =
  | { kind: 'board' }
  | { kind: 'briefing'; index: number }
  | { kind: 'result'; index: number }
  | { kind: 'closed' };

/**
 * Mission board, briefing and debrief overlays. While one is open it owns
 * the keyboard (flight keys are swallowed); Esc in flight opens the board.
 */
export class MissionScreens {
  private overlay: HTMLElement;
  private screen: Screen = { kind: 'closed' };
  private selected = 0;
  private lastRun: MissionRun | null = null;

  constructor(
    root: HTMLElement,
    private missions: readonly MissionDef[],
    private progress: Progress,
    private actions: ScreenActions,
  ) {
    this.overlay = el('div', 'mission-overlay');
    root.appendChild(this.overlay);
    window.addEventListener('keydown', (ev) => this.onKey(ev), { capture: true });
  }

  get open(): boolean {
    return this.screen.kind !== 'closed';
  }

  showBoard(): void {
    this.screen = { kind: 'board' };
    const card = this.card('OPERATIONS BOARD');
    const list = el('ol', 'mission-list');
    this.missions.forEach((m, i) => {
      if (i === 0 || isTutorial(m) !== isTutorial(this.missions[i - 1])) {
        list.appendChild(text('li', 'mission-group', isTutorial(m) ? 'TUTORIALS' : 'MISSIONS'));
      }
      const locked = !this.progress.unlocked(this.missions, i);
      const item = el('li', `mission-item${locked ? ' locked' : ''}`);
      item.append(
        text('span', 'mission-num', this.numberOf(i)),
        text('span', 'mission-name', m.title),
        text('span', 'mission-sum', locked ? 'LOCKED · win the previous mission' : m.summary),
        text('span', 'mission-stars', starString(this.progress.stars(m.id))),
      );
      item.addEventListener('click', () => {
        this.selected = i;
        this.activate();
      });
      list.appendChild(item);
    });
    const free = el('li', 'mission-item free');
    free.append(
      text('span', 'mission-num', '∞'),
      text('span', 'mission-name', 'Free Patrol'),
      text('span', 'mission-sum', 'Open patrol with a beacon and two target drones'),
      text('span', 'mission-stars', ''),
    );
    free.addEventListener('click', () => {
      this.selected = this.missions.length;
      this.activate();
    });
    list.appendChild(free);
    card.appendChild(list);
    card.appendChild(hint('↑↓ select · ENTER open · ESC close'));
    this.highlight();
  }

  showBriefing(index: number): void {
    const m = this.missions[index];
    this.screen = { kind: 'briefing', index };
    const card = this.card(`MISSION ${this.numberOf(index)} · ${m.title}`);
    for (const p of m.briefing) card.appendChild(text('p', 'mission-brief', p));

    if (m.lesson) {
      const box = el('div', 'mission-lesson');
      box.appendChild(text('h3', 'mission-sub', `CONCEPT · ${m.lesson.concept}`));
      const pts = el('ul', 'mission-points');
      for (const p of m.lesson.points) pts.appendChild(text('li', '', p));
      box.appendChild(pts);
      card.appendChild(box);
    }

    card.appendChild(text('h3', 'mission-sub', 'OBJECTIVES'));
    const obj = el('ul', 'mission-objs');
    for (const o of m.objectives) obj.appendChild(text('li', '', o.label));
    card.appendChild(obj);

    card.appendChild(text('h3', 'mission-sub', 'LOADOUT & LIMITS'));
    const facts = el('div', 'mission-facts');
    const l = m.player.loadout ?? {};
    const fact = (k: string, v: string): void => {
      facts.append(text('span', 'readout-label', k), text('span', 'readout-value', v));
    };
    fact('MISSILES', l.missiles === undefined ? 'standard' : String(l.missiles));
    fact('MINES', l.mines === undefined ? 'standard' : String(l.mines));
    fact(
      'PAR',
      `${fmtDuration(m.score.parTime)} · drive under ${fmtPercent(m.score.heatCeiling)} heat`,
    );
    card.appendChild(facts);

    const row = el('div', 'mission-buttons');
    row.append(
      btn('BACK', 'ESC', () => this.showBoard()),
      btn('LAUNCH', 'ENTER', () => this.launch(index)),
    );
    card.appendChild(row);
  }

  showResult(run: MissionRun, index: number): void {
    this.lastRun = run;
    this.screen = { kind: 'result', index };
    const won = run.outcome === 'won';
    const card = this.card(won ? 'OBJECTIVES MET' : 'OPERATION FAILED');
    card.classList.add(won ? 'won' : 'lost');
    card.appendChild(text('p', 'mission-reason', run.reason));
    if (won) card.appendChild(text('div', 'mission-big-stars', starString(run.stars())));
    const facts = el('div', 'mission-facts');
    const fact = (k: string, v: string): void => {
      facts.append(text('span', 'readout-label', k), text('span', 'readout-value', v));
    };
    fact(
      'MISSION TIME',
      `${fmtDuration(run.session.time)} (par ${fmtDuration(run.def.score.parTime)})`,
    );
    fact('WALL CLOCK', fmtDuration(run.wallSeconds));
    fact(
      'PEAK DRIVE HEAT',
      `${fmtPercent(run.peakHeat)} (par ${fmtPercent(run.def.score.heatCeiling)})`,
    );
    card.appendChild(facts);
    const row = el('div', 'mission-buttons');
    row.append(
      btn('BOARD', 'ESC', () => this.showBoard()),
      btn('RETRY', 'R', () => this.launch(index)),
    );
    if (this.hasNext(index)) row.appendChild(btn('NEXT', 'ENTER', () => this.enter(index + 1)));
    card.appendChild(row);
  }

  close(): void {
    this.screen = { kind: 'closed' };
    this.overlay.classList.remove('show');
    this.overlay.replaceChildren();
  }

  private hasNext(index: number): boolean {
    return (
      this.lastRun?.outcome === 'won' &&
      index + 1 < this.missions.length &&
      this.progress.unlocked(this.missions, index + 1)
    );
  }

  private launch(index: number): void {
    this.close();
    this.actions.launch(index);
  }

  private activate(): void {
    if (this.selected === this.missions.length) {
      this.close();
      this.actions.freeFlight();
    } else if (this.progress.unlocked(this.missions, this.selected)) {
      this.enter(this.selected);
    }
  }

  /** Tutorials skip the briefing and go straight to flight, where the ship AI takes over. */
  private enter(index: number): void {
    if (isTutorial(this.missions[index])) this.launch(index);
    else this.showBriefing(index);
  }

  /** Tutorials are numbered T1, T2...; missions count on from 01 among themselves. */
  private numberOf(index: number): string {
    const tutorials = this.missions.filter(isTutorial).length;
    return isTutorial(this.missions[index])
      ? `T${index + 1}`
      : String(index + 1 - tutorials).padStart(2, '0');
  }

  private highlight(): void {
    this.overlay.querySelectorAll('.mission-item').forEach((item, i) => {
      item.classList.toggle('selected', i === this.selected);
    });
  }

  private card(title: string): HTMLElement {
    this.overlay.replaceChildren();
    this.overlay.classList.add('show');
    const card = el('section', 'mission-card');
    card.appendChild(text('h2', 'mission-title', title));
    this.overlay.appendChild(card);
    return card;
  }

  private onKey(ev: KeyboardEvent): void {
    const s = this.screen;
    if (s.kind === 'closed') {
      if (ev.code === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        this.showBoard();
      }
      return;
    }
    // An open screen owns the keyboard: no flight input leaks through.
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.repeat) return;
    const k = ev.code;
    const enter = k === 'Enter' || k === 'NumpadEnter' || k === 'Space';
    if (s.kind === 'board') {
      const n = this.missions.length + 1;
      if (k === 'ArrowDown' || k === 'KeyS') this.selected = (this.selected + 1) % n;
      else if (k === 'ArrowUp' || k === 'KeyW') this.selected = (this.selected + n - 1) % n;
      else if (enter) return this.activate();
      else if (k === 'Escape') return this.close();
      this.highlight();
    } else if (s.kind === 'briefing') {
      if (enter) this.launch(s.index);
      else if (k === 'Escape') this.showBoard();
    } else if (s.kind === 'result') {
      if (k === 'KeyR') this.launch(s.index);
      else if (k === 'Escape') this.showBoard();
      else if (enter) {
        if (this.hasNext(s.index)) this.enter(s.index + 1);
        else this.launch(s.index);
      }
    }
  }
}

const LAMPS: Record<ObjectiveStatus, string> = {
  waiting: '○',
  active: '◉',
  done: '✓',
  failed: '✗',
};

/** In-flight objectives module, top left. Hidden outside missions. */
export class MissionHud {
  private box: HTMLElement;
  private sig = '';

  constructor(root: HTMLElement) {
    this.box = el('section', 'module mission-hud');
    root.appendChild(this.box);
  }

  update(run: MissionRun | null): void {
    this.box.classList.toggle('show', run !== null);
    if (!run) return;
    const s = run.session;
    const ammo = s.munitionsLeft(s.playerId);
    const lines = run.objectives.map(
      (o) => `${o.status}|${o.def.label}|${o.detail}|${o.progress.toFixed(2)}`,
    );
    const clock = `MET ${fmtDuration(s.time)}`;
    const wall = `REAL ${fmtDuration(run.wallSeconds)}`;
    const sig = [run.def.title, clock, wall, ammo.missiles, ammo.mines, ...lines].join('#');
    if (sig === this.sig) return;
    this.sig = sig;

    this.box.replaceChildren(
      text('h2', 'module-title', `MISSION · ${run.def.title.toUpperCase()}`),
    );
    const head = el('div', 'hud-head');
    head.append(
      text('span', 'hud-clock', clock),
      text('span', 'hud-wall', wall),
      text('span', 'hud-ammo', `MSL ${ammo.missiles} · MINE ${ammo.mines}`),
    );
    this.box.appendChild(head);
    for (const o of run.objectives) {
      const row = el('div', `hud-obj ${o.status}`);
      row.append(text('span', 'hud-lamp', LAMPS[o.status]), text('span', 'hud-label', o.def.label));
      if (o.status === 'active' || o.status === 'failed') {
        if (o.detail) row.appendChild(text('span', 'hud-detail', o.detail));
        if (o.status === 'active') {
          const bar = el('span', 'hud-bar');
          const fill = el('span', 'hud-fill');
          fill.style.width = fmtPercent(o.progress);
          bar.appendChild(fill);
          row.appendChild(bar);
        }
      }
      this.box.appendChild(row);
    }
    this.box.appendChild(hint('ESC operations board'));
  }
}

function isTutorial(m: MissionDef): boolean {
  return m.tutorial !== undefined;
}

function starString(n: number): string {
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function text(tag: string, cls: string, content: string): HTMLElement {
  const e = el(tag, cls);
  e.textContent = content;
  return e;
}

function hint(content: string): HTMLElement {
  return text('div', 'mission-hint', content);
}

function btn(label: string, key: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ctl mission-btn';
  b.append(text('span', 'ctl-label', label), text('span', 'ctl-key', key));
  b.addEventListener('mousedown', (ev) => ev.preventDefault());
  b.addEventListener('click', onClick);
  return b;
}
