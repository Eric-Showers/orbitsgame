const KEY = 'orbits.commanderName';
export const DEFAULT_COMMANDER = 'Commander';
const MAX_LENGTH = 24;

/** Cleans what the player typed: no markup, single spaces, ALL CAPS softened so the voice says it as a word. */
export function cleanName(raw: string): string {
  const name = raw
    .replace(/[<>&"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LENGTH)
    .trim();
  if (name.length > 1 && name === name.toUpperCase() && /[A-Z]/.test(name)) {
    return name.charAt(0) + name.slice(1).toLowerCase();
  }
  return name;
}

/** Replaces the word "Commander" in a spoken line with the player's name. */
export function addressCommander(text: string, name: string): string {
  return name === DEFAULT_COMMANDER ? text : text.replace(/\bCommander\b/g, name);
}

/** The player's chosen name, remembered in this browser. Blank means the default title. */
export class CommanderName {
  private current: string;
  private listeners = new Set<(name: string) => void>();

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {
    let saved = '';
    try {
      saved = storage?.getItem(KEY) ?? '';
    } catch {
      // Private mode: no remembered name.
    }
    this.current = cleanName(saved) || DEFAULT_COMMANDER;
  }

  get name(): string {
    return this.current;
  }

  /** True when the player has entered a name of their own. */
  get custom(): boolean {
    return this.current !== DEFAULT_COMMANDER;
  }

  set(raw: string): void {
    const name = cleanName(raw) || DEFAULT_COMMANDER;
    if (name === this.current) return;
    this.current = name;
    try {
      this.storage?.setItem(KEY, this.custom ? name : '');
    } catch {
      // Storage full or blocked: the name lasts for this page only.
    }
    for (const l of this.listeners) l(name);
  }

  subscribe(fn: (name: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
