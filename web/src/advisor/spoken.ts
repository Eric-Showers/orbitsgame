// Written lines are read out by plain text-to-speech engines, which guess at
// symbols and abbreviations. `spoken` spells out units and letters so the
// reading is unambiguous; the on-screen text stays as written.

const SPELLED: Record<string, string> = {
  AI: 'A I',
  HUD: 'H U D',
  UI: 'U I',
  ETA: 'E T A',
  RCS: 'reaction control',
  KV: 'kill vehicle',
  TCA: 'closest approach',
  GPS: 'G P S',
};

const plural = (n: string, one: string, many: string): string =>
  Number(n.replace(/,/g, '')) === 1 ? one : many;

/** The line as it should be read aloud: units in words, symbols spoken, initialisms spelled out. */
export function spoken(text: string): string {
  return text
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*km\/s\b/g, '$1 kilometers per second')
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*m\/s\b/g, '$1 meters per second')
    .replace(
      /(\d[\d,]*(?:\.\d+)?)\s*km\b/g,
      (_, n: string) => `${n} ${plural(n, 'kilometer', 'kilometers')}`,
    )
    .replace(
      /(\d[\d,]*(?:\.\d+)?)\s*m\b(?!\/)/g,
      (_, n: string) => `${n} ${plural(n, 'meter', 'meters')}`,
    )
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*%/g, '$1 percent')
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*°/g, '$1 degrees')
    .replace(/\bdelta-v\b|\bΔv\b|\bdv\b/gi, 'delta vee')
    .replace(/\b[A-Z]{2,4}\b/g, (m) => SPELLED[m] ?? m)
    .replace(/&/g, ' and ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Words that are all capitals but read as words (button names), so need no spelling. */
export const CAPITAL_WORDS = new Set([
  'CIRCULARIZE',
  'RENDEZVOUS',
  'FIRE',
  'CHECKED',
  'STAY',
  'WITH',
  'MATCH',
  'SPEED',
  'INTERCEPT',
  'EVADE',
  'GO',
  'TO',
  'ALTITUDE',
]);

/**
 * All-capital tokens in authored text that a speech engine could misread:
 * initialisms not covered by `spoken`, such as "SAM" or "ORB".
 */
export function unspokenAcronyms(text: string): string[] {
  const found = text.match(/\b[A-Z]{2,}\b/g) ?? [];
  return found.filter((w) => !CAPITAL_WORDS.has(w) && !(w in SPELLED) && !/^[A-Z]{5,}$/.test(w));
}
