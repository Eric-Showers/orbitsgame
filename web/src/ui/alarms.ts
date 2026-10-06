import type { AdvisoryChannel } from '../advisor/channel';
import { VOICE } from '../advisor/config';
import { playerSnapshot } from '../advisor/snapshot';
import { evaluateConditions } from '../advisor/triggers';
import type { FlightSession } from '../sim/session';
import './alarms.css';

/** An alarm line that has fired stays lit this long (ms) unless its condition is still true. */
const FLASH_MS = 6000;

interface Kind {
  key: string;
  label: string;
  side: 'left' | 'right';
  /** Line id prefixes that light this icon. */
  ids: string[];
  svg: string;
}

const KINDS: Kind[] = [
  {
    key: 'impact',
    label: 'IMPACT',
    side: 'left',
    ids: ['hazard.'],
    svg: 'M12 3v12M7 11l5 5 5-5M4 20h16',
  },
  {
    key: 'heat',
    label: 'THERMAL',
    side: 'left',
    ids: ['heat.'],
    svg: 'M10 4a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0zM12 9v7',
  },
  {
    key: 'missile',
    label: 'MISSILE',
    side: 'right',
    ids: ['threat.missile'],
    svg: 'M12 2l3 7v8l-3 3-3-3V9zM9 14l-4 4M15 14l4 4',
  },
  {
    key: 'mine',
    label: 'MINE',
    side: 'right',
    ids: ['threat.mine'],
    svg: 'M12 7a5 5 0 1 0 .01 0M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2',
  },
  {
    key: 'hull',
    label: 'HULL',
    side: 'right',
    ids: ['damage.'],
    svg: 'M12 2l8 4.5v9L12 20l-8-4.5v-9zM12 6l-2 5 3 2-2 5',
  },
  {
    key: 'lost',
    label: 'LOST',
    side: 'right',
    ids: ['status.lost'],
    svg: 'M12 3a9 9 0 1 0 .01 0M8 8l8 8M16 8l-8 8',
  },
];

const kindOf = (id: string): Kind | undefined =>
  KINDS.find((k) => k.ids.some((p) => id.startsWith(p)));

const critical = (id: string): boolean => VOICE.lines[id]?.priority === 'critical';

/**
 * Flashing alarm icons either side of the top centre bar. An icon is lit while its hazard condition
 * holds (same latching as the vessel AI uses) and for a few seconds after an alarm line of its kind
 * is spoken, so one-shot alarms like hull hits still register. Alarm lines no longer go in the chat log.
 */
export class AlarmIcons {
  private icons = new Map<string, HTMLElement>();
  private latched = new Set<string>();
  private flashes = new Map<string, number>();
  private forSession: FlightSession | null = null;

  constructor(
    parent: HTMLElement,
    private session: () => FlightSession,
    channel: AdvisoryChannel,
  ) {
    const left = document.createElement('div');
    left.className = 'alarms alarms-left';
    const right = document.createElement('div');
    right.className = 'alarms alarms-right';
    for (const k of KINDS) {
      const icon = document.createElement('div');
      icon.className = 'alarm';
      icon.hidden = true;
      icon.title = k.label;
      icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${k.svg}"/></svg><span>${k.label}</span>`;
      (k.side === 'left' ? left : right).append(icon);
      this.icons.set(k.key, icon);
    }
    parent.append(left, right);
    channel.subscribe((ev) => {
      if (ev.category === 'alarm') this.flashes.set(ev.id, performance.now() + FLASH_MS);
    });
  }

  update(): void {
    const s = this.session();
    if (s !== this.forSession) {
      this.forSession = s;
      this.latched.clear();
      this.flashes.clear();
    }
    for (const c of evaluateConditions(playerSnapshot(s, []), VOICE.thresholds)) {
      if (c.on) this.latched.add(c.id);
      else if (!(c.hold ?? c.on)) this.latched.delete(c.id);
    }
    const now = performance.now();
    const lit = new Map<string, boolean>();
    const light = (id: string): void => {
      const k = kindOf(id);
      if (k && VOICE.lines[id]?.category === 'alarm')
        lit.set(k.key, (lit.get(k.key) ?? false) || critical(id));
    };
    this.latched.forEach(light);
    for (const [id, until] of this.flashes) {
      if (until > now) light(id);
      else this.flashes.delete(id);
    }
    for (const k of KINDS) {
      const icon = this.icons.get(k.key);
      if (!icon) continue;
      const sev = lit.get(k.key);
      icon.hidden = sev === undefined;
      icon.classList.toggle('crit', sev === true);
    }
  }
}
