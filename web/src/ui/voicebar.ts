import { fillTemplate, VOICE } from '../advisor/config';
import { PERSONAS } from '../advisor/personas';
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
    return fillTemplate(text, { callsign: VOICE.callsigns.Corvette ?? VOICE.defaultCallsign });
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
