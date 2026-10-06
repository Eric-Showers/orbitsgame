import data from './personas.json';

export interface Persona {
  id: string;
  name: string;
  /** What this AI calls itself on the bridge, e.g. ARGUS. Replaces `{callsign}` for the player's hull. */
  callsign: string;
  blurb: string;
  /** Kept for later development but not offered in the voice selector. */
  hidden?: boolean;
  speech: {
    /** SpeechSynthesisUtterance.rate */
    rate: number;
    /** SpeechSynthesisUtterance.pitch */
    pitch: number;
    volume: number;
    /** Reading pace used to time the speech queue. */
    wordsPerMinute: number;
  };
  voice: {
    lang: string;
    /** Substrings of installed voice names, tried in order. */
    hints: string[];
  };
  /** Replacement wording per `voice.json` line id; unlisted lines keep the shipped text. */
  lines: Record<string, string[]>;
}

interface PersonaData {
  default: string;
  personas: Persona[];
}

const personaData = data as PersonaData;

export const PERSONAS: Persona[] = personaData.personas;

export const DEFAULT_PERSONA: Persona =
  PERSONAS.find((p) => p.id === personaData.default) ?? PERSONAS[0];

/** Personas the player can pick. */
export const SELECTABLE_PERSONAS: Persona[] = PERSONAS.filter((p) => !p.hidden);

/** A saved choice, falling back to the default when that persona is hidden or gone. */
export function selectablePersona(id: string | null | undefined): Persona {
  return SELECTABLE_PERSONAS.find((p) => p.id === id) ?? DEFAULT_PERSONA;
}

export function findPersona(id: string | null | undefined): Persona {
  return PERSONAS.find((p) => p.id === id) ?? DEFAULT_PERSONA;
}
