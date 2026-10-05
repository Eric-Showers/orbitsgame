import { fillTemplate, VOICE } from '../advisor/config';
import { PERSONAS } from '../advisor/personas';
import type { CommanderName } from '../commander';
import type { TtsPlayer } from './tts';

/** Voice toggle and persona picker, docked under the comms log. */
export class VoiceBar {
  private toggle: HTMLButtonElement;
  private select: HTMLSelectElement;
  private blurb: HTMLElement;

  constructor(
    parent: HTMLElement,
    private tts: TtsPlayer,
    private onPersona: (id: string) => void,
    commander?: CommanderName,
  ) {
    const bar = document.createElement('div');
    bar.className = 'voicebar';
    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = 'voicebar-toggle';
    this.toggle.addEventListener('click', () => {
      tts.setEnabled(!tts.enabled);
      if (tts.enabled) tts.say(this.sample());
    });
    this.select = document.createElement('select');
    this.select.className = 'voicebar-select';
    this.select.setAttribute('aria-label', 'AI voice');
    for (const p of PERSONAS) this.select.append(new Option(p.name, p.id));
    this.select.addEventListener('change', () => {
      this.onPersona(this.select.value);
      if (tts.enabled) tts.say(this.sample());
    });
    if (commander) {
      const field = document.createElement('input');
      field.type = 'text';
      field.className = 'voicebar-name';
      field.maxLength = 24;
      field.placeholder = 'Your name';
      field.autocomplete = 'off';
      field.spellcheck = false;
      field.setAttribute('aria-label', 'Your name, as the AI says it');
      field.value = commander.custom ? commander.name : '';
      // Typing must not reach the flight keys, and Enter commits the name.
      field.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter' || ev.key === 'Escape') field.blur();
      });
      field.addEventListener('change', () => {
        commander.set(field.value);
        field.value = commander.custom ? commander.name : '';
        if (tts.enabled) tts.say(`Aye, ${commander.name}.`);
      });
      bar.append(text('span', 'voicebar-label', 'NAME'), field);
    }
    this.blurb = document.createElement('p');
    this.blurb.className = 'voicebar-blurb';
    bar.append(this.toggle, this.select, this.blurb);
    parent.appendChild(bar);
    tts.subscribe(() => this.refresh());
    this.refresh();
  }

  private sample(): string {
    const p = this.tts.persona;
    const text = p.lines['status.online']?.[0] ?? VOICE.lines['status.online'].text[0];
    return fillTemplate(text, { callsign: p.callsign });
  }

  private refresh(): void {
    const p = this.tts.persona;
    this.select.value = p.id;
    this.blurb.textContent = p.blurb;
    this.toggle.disabled = !this.tts.supported;
    this.toggle.textContent = !this.tts.supported
      ? 'VOICE N/A'
      : this.tts.enabled
        ? 'VOICE ON'
        : 'VOICE OFF';
    this.toggle.setAttribute('aria-pressed', String(this.tts.enabled));
  }
}

function text(tag: string, cls: string, content: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = content;
  return e;
}
