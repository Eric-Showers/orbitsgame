import type { MissionDef } from './types';

const KEY = 'orbits.missions.v1';

/** Best star count per mission id, remembered in this browser only. */
export class Progress {
  private best: Record<string, number> = {};

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {
    try {
      this.best = JSON.parse(this.storage?.getItem(KEY) ?? '{}') ?? {};
    } catch {
      this.best = {};
    }
  }

  stars(id: string): number {
    return this.best[id] ?? 0;
  }

  /** The first mission is always open; each later one opens when the previous is won. */
  unlocked(missions: readonly MissionDef[], index: number): boolean {
    return index === 0 || this.stars(missions[index - 1]?.id) > 0;
  }

  record(id: string, stars: number): void {
    if (stars <= this.stars(id)) return;
    this.best[id] = stars;
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.best));
    } catch {
      // Storage full or blocked: progress lasts for this page only.
    }
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
