import { TutorialRunner, type TutorialWorld } from '../missions/tutorial';
import type { MissionDef, TutorialStep } from '../missions/types';
import type { FlightSession } from '../sim/session';
import './tutorial.css';

const SVG = 'http://www.w3.org/2000/svg';

/** What the guide needs from the rest of the game. */
export interface TutorialHooks {
  /** The ship AI speaks (and the line lands in the comms log). */
  say(id: string, text: string): void;
  /** Fills the helm's altitude box, in km. */
  setAltitude(km: number): void;
  /** Guided mode started or stopped (the ship AI drops its small talk while it is on). */
  onGuided(on: boolean): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  content = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (content) e.textContent = content;
  return e;
}

/** The first matching element that is actually on screen. */
function visible(selector: string): HTMLElement | null {
  for (const e of document.querySelectorAll<HTMLElement>(selector)) {
    const r = e.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return e;
  }
  return null;
}

/**
 * Tutorial levels open with the ship AI asking whether the player wants the
 * guided script. If so, a callout narrates each step while the named parts of
 * the interface are outlined, buttons flash and an arrow points at the one to
 * use. Declined (or skipped), the level is plain flight. While the question is
 * up the flight is held, so `asking` freezes the frame loop.
 */
export class TutorialGuide {
  private root = el('div', 'tut');
  private ask = el('div', 'tut-ask');
  private callout = el('section', 'tut-callout');
  private stepNo = el('span', 'tut-step');
  private body = el('p', 'tut-text');
  private next = el('button', 'ctl tut-next', 'NEXT ▸');
  private svg = document.createElementNS(SVG, 'svg');
  private arrow = document.createElementNS(SVG, 'line');
  private boxes: HTMLElement[] = [];
  private level: MissionDef | null = null;
  private runner: TutorialRunner | null = null;
  private world: TutorialWorld | null = null;
  private asked = false;
  /** The first step starts on the next frame, when a world snapshot exists. */
  private pendingBegin = false;

  constructor(
    root: HTMLElement,
    private hooks: TutorialHooks,
  ) {
    this.buildArrow();
    this.buildCallout();
    this.root.append(this.svg, this.callout, this.ask);
    this.root.hidden = true;
    root.appendChild(this.root);
    // Capture and swallow: the question owns the keyboard, like the mission screens do.
    window.addEventListener('keydown', (ev) => this.onKey(ev), { capture: true });
  }

  /** The question is up: the flight holds still. */
  get asking(): boolean {
    return this.asked;
  }

  /** A walkthrough is running. */
  get guided(): boolean {
    return this.runner !== null && !this.runner.finished;
  }

  /** A tutorial level just launched: the ship AI asks whether to guide. */
  offer(level: MissionDef): void {
    this.end();
    if (!level.tutorial) return;
    this.level = level;
    this.asked = true;
    this.root.hidden = false;
    this.ask.replaceChildren(
      el('h2', 'tut-ask-title', 'SHIP AI'),
      el(
        'p',
        'tut-ask-text',
        'Want me to talk you through this one? I will point out the controls as we go.',
      ),
    );
    const row = el('div', 'tut-ask-buttons');
    row.append(
      this.button('YES, GUIDE ME', '⏎', 'tut-yes', () => this.accept()),
      this.button('NO, I WILL FLY', 'N', 'tut-no', () => this.decline()),
    );
    this.ask.appendChild(row);
    this.ask.classList.add('show');
    this.hooks.say(
      'tutorial.offer',
      'Shall I talk you through this one? I can point out the controls as we go.',
    );
  }

  /** Back to plain flight: removes everything on screen. */
  end(): void {
    const was = this.guided;
    this.asked = false;
    this.runner = null;
    this.level = null;
    this.ask.classList.remove('show');
    this.callout.classList.remove('show');
    this.arrow.setAttribute('visibility', 'hidden');
    for (const b of this.boxes) b.hidden = true;
    this.root.hidden = true;
    if (was) this.hooks.onGuided(false);
  }

  /** A control action was pressed (and whether the ship accepted it). */
  press(id: string, ok: boolean): void {
    this.runner?.press(id, ok);
  }

  /** Ticks the walkthrough and redraws the highlights. Call each frame the flight is running. */
  update(
    session: FlightSession,
    world: TutorialWorld,
    ids: ReadonlyMap<string, number>,
    dt: number,
  ): void {
    this.world = world;
    const runner = this.runner;
    if (!runner || runner.finished) return;
    if (this.pendingBegin) {
      this.pendingBegin = false;
      runner.begin(world);
    } else {
      runner.update(world, dt);
    }
    const step = runner.step;
    if (!step) return this.finishWalkthrough();
    runner.guard(session, world, ids);
    this.layout(step);
  }

  private accept(): void {
    const level = this.level;
    if (!level?.tutorial) return;
    this.asked = false;
    this.ask.classList.remove('show');
    this.runner = new TutorialRunner(
      level.tutorial,
      {
        say: (id, text) => this.hooks.say(id, text),
        onStep: (step, i, total) => this.showStep(step, i, total),
      },
      level.id,
    );
    this.hooks.onGuided(true);
    this.pendingBegin = true;
  }

  private decline(): void {
    this.hooks.say('tutorial.declined', 'Understood. You have the helm. Ask if you want me.');
    this.end();
  }

  private finishWalkthrough(): void {
    this.hooks.onGuided(false);
    this.callout.classList.remove('show');
    this.arrow.setAttribute('visibility', 'hidden');
    for (const b of this.boxes) b.hidden = true;
  }

  private showStep(step: TutorialStep | null, i: number, total: number): void {
    if (!step) return this.finishWalkthrough();
    if (step.prefill) this.hooks.setAltitude(step.prefill.altitudeKm);
    this.stepNo.textContent = `STEP ${i + 1}/${total}`;
    this.body.textContent = step.say;
    this.next.hidden = step.until !== undefined;
    this.callout.classList.add('show');
  }

  /** Positions the outlines and the arrow over the live interface. */
  private layout(step: TutorialStep): void {
    const lit: { box: DOMRect; flash: boolean }[] = [];
    for (const sel of step.highlight ?? []) {
      const e = visible(sel);
      if (e) lit.push({ box: e.getBoundingClientRect(), flash: false });
    }
    for (const sel of step.flash ?? []) {
      const e = visible(sel);
      if (e) lit.push({ box: e.getBoundingClientRect(), flash: true });
    }
    while (this.boxes.length < lit.length) {
      const b = el('div', 'tut-box');
      this.root.appendChild(b);
      this.boxes.push(b);
    }
    this.boxes.forEach((b, i) => {
      const item = lit[i];
      b.hidden = !item;
      if (!item) return;
      const pad = 4;
      b.style.left = `${item.box.left - pad}px`;
      b.style.top = `${item.box.top - pad}px`;
      b.style.width = `${item.box.width + pad * 2}px`;
      b.style.height = `${item.box.height + pad * 2}px`;
      b.classList.toggle('flash', item.flash);
    });
    // The arrow points at the first flashing part, else the first outlined one.
    const aim = lit.find((x) => x.flash) ?? lit[0];
    if (!aim) return this.arrow.setAttribute('visibility', 'hidden');
    const c = this.callout.getBoundingClientRect();
    const tx = aim.box.left + aim.box.width / 2;
    const ty = aim.box.top + aim.box.height / 2;
    const above = ty < c.top;
    const sx = Math.min(Math.max(tx, c.left + 24), c.right - 24);
    const sy = above ? c.top : c.bottom;
    // Stop short of the part so the head sits on its edge.
    const dx = tx - sx;
    const dy = ty - sy;
    const d = Math.hypot(dx, dy) || 1;
    const edge = Math.min(
      aim.box.width / 2 / Math.max(Math.abs(dx / d), 1e-3),
      aim.box.height / 2 / Math.max(Math.abs(dy / d), 1e-3),
    );
    const stop = Math.max(0, d - edge - 8);
    this.arrow.setAttribute('x1', String(sx));
    this.arrow.setAttribute('y1', String(sy));
    this.arrow.setAttribute('x2', String(sx + (dx / d) * stop));
    this.arrow.setAttribute('y2', String(sy + (dy / d) * stop));
    this.arrow.setAttribute('visibility', stop > 12 ? 'visible' : 'hidden');
  }

  private buildArrow(): void {
    this.svg.setAttribute('class', 'tut-svg');
    const defs = document.createElementNS(SVG, 'defs');
    const marker = document.createElementNS(SVG, 'marker');
    marker.setAttribute('id', 'tut-head');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '8');
    marker.setAttribute('orient', 'auto-start-reverse');
    const head = document.createElementNS(SVG, 'path');
    head.setAttribute('d', 'M0 0 L10 5 L0 10 z');
    head.setAttribute('class', 'tut-head');
    marker.appendChild(head);
    defs.appendChild(marker);
    this.arrow.setAttribute('class', 'tut-arrow');
    this.arrow.setAttribute('marker-end', 'url(#tut-head)');
    this.arrow.setAttribute('visibility', 'hidden');
    this.svg.append(defs, this.arrow);
  }

  private buildCallout(): void {
    const head = el('div', 'tut-head-row');
    const skip = this.button('SKIP TUTORIAL', '', 'tut-skip', () => {
      this.runner?.skip();
    });
    this.next.type = 'button';
    this.next.addEventListener('mousedown', (ev) => ev.preventDefault());
    this.next.addEventListener('click', () => {
      if (this.world) this.runner?.advance(this.world);
    });
    head.append(el('span', 'tut-who', 'SHIP AI'), this.stepNo, skip);
    const foot = el('div', 'tut-foot');
    foot.appendChild(this.next);
    this.callout.append(head, this.body, foot);
  }

  private button(label: string, key: string, cls: string, fn: () => void): HTMLButtonElement {
    const b = el('button', `ctl ${cls}`);
    b.type = 'button';
    b.append(el('span', 'ctl-label', label));
    if (key) b.append(el('span', 'ctl-key', key));
    b.addEventListener('mousedown', (ev) => ev.preventDefault());
    b.addEventListener('click', fn);
    return b;
  }

  private onKey(ev: KeyboardEvent): void {
    if (!this.asked) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    if (ev.repeat) return;
    if (
      ev.code === 'Enter' ||
      ev.code === 'NumpadEnter' ||
      ev.code === 'KeyY' ||
      ev.code === 'Space'
    ) {
      this.accept();
    } else if (ev.code === 'KeyN' || ev.code === 'Escape') {
      this.decline();
    }
  }
}
