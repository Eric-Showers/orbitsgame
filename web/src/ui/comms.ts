import type { AdvisoryChannel, AdvisoryEvent } from '../advisor/channel';
import { fmtDuration } from './format';
import './comms.css';

const MAX_LINES = 6;

/** Text log of the vessel AI's speech: the first listener on the advisory channel. */
export class CommsLog {
  readonly box: HTMLElement;
  private list: HTMLElement;
  private title: HTMLElement;

  constructor(root: HTMLElement, channel: AdvisoryChannel) {
    const box = (this.box = document.createElement('section'));
    box.className = 'comms';
    this.title = document.createElement('h2');
    this.title.className = 'comms-title';
    this.title.textContent = 'VESSEL AI';
    this.list = document.createElement('ol');
    this.list.className = 'comms-lines';
    box.append(this.title, this.list);
    root.appendChild(box);
    channel.subscribe((ev) => this.show(ev));
  }

  clear(): void {
    this.list.replaceChildren();
  }

  private show(ev: AdvisoryEvent): void {
    this.title.textContent = `VESSEL AI · ${ev.speaker}`;
    const li = document.createElement('li');
    li.className = `comms-line p-${ev.priority}`;
    const stamp = document.createElement('span');
    stamp.className = 'comms-time';
    stamp.textContent = fmtDuration(ev.simTime);
    const text = document.createElement('span');
    text.className = 'comms-text';
    text.textContent = ev.text;
    li.append(stamp, text);
    this.list.appendChild(li);
    while (this.list.children.length > MAX_LINES) this.list.firstElementChild?.remove();
  }
}
