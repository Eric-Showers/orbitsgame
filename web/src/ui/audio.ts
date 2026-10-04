import type { AudioBus, AudioMixer } from '../audio/mixer';
import './audio.css';

const ROWS: { bus: AudioBus; label: string; title: string }[] = [
  { bus: 'master', label: 'ALL', title: 'Master volume' },
  {
    bus: 'physical',
    label: 'SHIP',
    title: 'Shipboard sound: engine, thrusters, launches, impacts',
  },
  {
    bus: 'cockpit',
    label: 'CKPT',
    title: 'Cockpit cues: warnings, timers, autopilot confirmations',
  },
];

/** Per-bus volume and mute. The mixer remembers the settings between visits. */
export class AudioPanel {
  constructor(parent: HTMLElement, mixer: AudioMixer) {
    const root = document.createElement('div');
    root.className = 'audio-mix';
    for (const { bus, label, title } of ROWS) {
      const row = document.createElement('div');
      row.className = 'audio-row';
      row.title = title;
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.textContent = label;
      mute.classList.toggle('muted', mixer.muted(bus));
      // Keep keyboard focus on the game: space and arrows fly the ship.
      mute.addEventListener('mousedown', (ev) => ev.preventDefault());
      mute.addEventListener('click', () => {
        mixer.setMuted(bus, !mixer.muted(bus));
        mute.classList.toggle('muted', mixer.muted(bus));
      });
      const vol = document.createElement('input');
      vol.type = 'range';
      vol.min = '0';
      vol.max = '100';
      vol.value = String(Math.round(mixer.volume(bus) * 100));
      vol.setAttribute('aria-label', `${title} volume`);
      vol.addEventListener('input', () => mixer.setVolume(bus, Number(vol.value) / 100));
      vol.addEventListener('change', () => vol.blur());
      row.append(mute, vol);
      root.appendChild(row);
    }
    parent.appendChild(root);
  }
}
