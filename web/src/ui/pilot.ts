import { INTENTS, buildIntent, type Intent } from '../autopilot/intents';
import type { Pilot } from '../autopilot/pilot';
import type { FlightSession } from '../sim/session';
import { fmtDuration, fmtSpeed } from './format';
import './pilot.css';

const DEFAULT_ALTITUDE_KM = 120;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/**
 * Commander-facing autopilot: intent buttons ("Circularize", "Rendezvous"),
 * a confirm / cancel card for ARGUS's plan, and progress with abort. Manual
 * controls elsewhere stay live and take over the moment they are touched.
 */
export class PilotPanel {
  private toggle: HTMLButtonElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private altitude = this.altitudeInput();
  private body: HTMLElement;
  private card: HTMLElement;
  private cardKey = '';
  private bar: HTMLElement | null = null;
  private note: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    private pilot: () => Pilot,
    private session: () => FlightSession,
  ) {
    const mod = el('section', 'module pilot');
    mod.appendChild(el('h2', 'module-title', 'ARGUS PILOT'));
    this.toggle = el('button', 'ctl pilot-toggle');
    this.toggle.type = 'button';
    this.toggle.title = 'Let ARGUS fly maneuvers for you. Manual controls always override it.';
    this.toggle.addEventListener('mousedown', (ev) => ev.preventDefault());
    this.toggle.addEventListener('click', () => this.pilot().setAssist(!this.pilot().assist));
    mod.appendChild(this.toggle);

    this.body = el('div', 'pilot-body');
    mod.appendChild(this.body);
    for (const group of ['orbit', 'target', 'combat'] as const) {
      const row = el('div', `pilot-row pilot-${group}`);
      for (const intent of INTENTS.filter((i) => i.group === group)) {
        row.appendChild(this.intentButton(intent));
        if (intent.needs === 'altitude') row.appendChild(this.altitude);
      }
      this.body.appendChild(row);
    }
    this.card = el('div', 'pilot-card');
    this.body.appendChild(this.card);
    parent.appendChild(mod);

    window.addEventListener('keydown', (ev) => {
      if (ev.target instanceof HTMLInputElement && ev.key !== 'Enter') return;
      const p = this.pilot();
      if (ev.key === 'Enter') {
        if (p.proposal) {
          ev.preventDefault();
          p.confirm();
          (ev.target as HTMLElement).blur?.();
        }
      } else if (ev.key === 'Escape') {
        if (p.proposal) p.cancel();
        else if (p.busy) p.abort('commander');
      }
    });
  }

  private altitudeInput(): HTMLInputElement {
    const input = el('input', 'pilot-alt');
    input.type = 'number';
    input.min = '30';
    input.step = '10';
    input.value = String(DEFAULT_ALTITUDE_KM);
    input.title = 'Target altitude in km';
    return input;
  }

  private intentButton(intent: Intent): HTMLButtonElement {
    const b = el('button', 'ctl pilot-intent', intent.label);
    b.type = 'button';
    b.title = intent.title;
    b.addEventListener('mousedown', (ev) => ev.preventDefault());
    b.addEventListener('click', () => this.request(intent));
    this.buttons.set(intent.id, b);
    return b;
  }

  private request(intent: Intent): void {
    const s = this.session();
    const built = buildIntent(intent, {
      target: s.player().target,
      altitudeKm: Number(this.altitude.value) || DEFAULT_ALTITUDE_KM,
    });
    const pilot = this.pilot();
    if (typeof built === 'string') {
      pilot.cancel();
      pilot.refuse(intent.label, built);
      return;
    }
    pilot.propose(built);
  }

  /** Refreshes buttons and the plan/progress card. Call every frame. */
  update(): void {
    const pilot = this.pilot();
    this.toggle.textContent = pilot.assist ? 'AI ASSIST · ON' : 'AI ASSIST · OFF · MANUAL';
    this.toggle.classList.toggle('active', pilot.assist);
    this.body.classList.toggle('off', !pilot.assist);
    const me = this.session().player();
    for (const intent of INTENTS) {
      const b = this.buttons.get(intent.id);
      if (!b) continue;
      b.disabled = !pilot.assist || !me.alive;
      b.classList.toggle('active', pilot.active?.kind === intent.id);
    }

    const { proposal, active, status } = pilot;
    const key = proposal ? 'plan' : active ? 'run' : 'idle';
    if (
      key !== this.cardKey ||
      (key === 'plan' && this.card.dataset.id !== proposal?.maneuver.label)
    ) {
      this.cardKey = key;
      this.build(key);
    }
    if (key === 'plan' && proposal) {
      this.card.dataset.id = proposal.maneuver.label;
    } else if (key === 'run' && status && this.bar && this.note) {
      this.bar.style.width = `${Math.round(status.progress * 100)}%`;
      this.note.textContent = status.note;
    }
  }

  private build(key: string): void {
    const pilot = this.pilot();
    this.card.replaceChildren();
    this.bar = null;
    this.note = null;
    this.card.classList.toggle('shown', key !== 'idle');
    if (key === 'plan' && pilot.proposal) {
      const { maneuver, plan } = pilot.proposal;
      this.card.appendChild(el('div', 'pilot-title', maneuver.label.toUpperCase()));
      const facts = [`ΔV ${fmtSpeed(plan.dv)}`, `ETA ${fmtDuration(plan.eta)}`];
      for (const n of plan.nodes) {
        facts.push(
          `${n.label}: T+${fmtDuration(n.time - this.session().time)} · ${fmtSpeed(n.dv)}`,
        );
      }
      this.card.appendChild(el('div', 'pilot-facts', facts.join('  ·  ')));
      const row = el('div', 'pilot-actions');
      row.append(
        this.action('CONFIRM ⏎', 'go', () => pilot.confirm()),
        this.action('CANCEL ⎋', 'stop', () => pilot.cancel()),
      );
      this.card.appendChild(row);
    } else if (key === 'run' && pilot.active) {
      this.card.appendChild(el('div', 'pilot-title', pilot.active.label.toUpperCase()));
      const track = el('div', 'pilot-track');
      this.bar = el('div', 'pilot-fill');
      track.appendChild(this.bar);
      this.card.appendChild(track);
      this.note = el('div', 'pilot-facts');
      this.card.appendChild(this.note);
      const row = el('div', 'pilot-actions');
      row.append(this.action('ABORT ⎋', 'stop', () => pilot.abort('commander')));
      this.card.appendChild(row);
    }
  }

  private action(label: string, kind: string, fn: () => void): HTMLButtonElement {
    const b = el('button', `ctl pilot-${kind}`, label);
    b.type = 'button';
    b.addEventListener('mousedown', (ev) => ev.preventDefault());
    b.addEventListener('click', fn);
    return b;
  }
}
