// Picks the line that best fits the moment. A line (or variant) may name the
// tags it needs; the more of them the situation satisfies, the better the
// fit. Pure apart from the injected random source, so it tests exactly.

import type { LineSpec, TagExpr, TextVariant } from './config';
import type { Situation } from './situation';

/** One thing the AI could say right now. */
export interface Candidate {
  /** Line id in `voice.json`. */
  id: string;
  text: string;
  /** Unique per variant, used for cooldowns and repeat tracking. */
  key: string;
  weight: number;
  /** Tags the variant requires, for scoring specificity. */
  tags: string[];
  cooldown?: number;
  once?: boolean;
}

/** Does `expr` hold for these tags? An absent expression always does. */
export function matches(expr: TagExpr | undefined, tags: ReadonlySet<string>): boolean {
  if (!expr) return true;
  if (expr.all && !expr.all.every((t) => tags.has(t))) return false;
  if (expr.any && expr.any.length > 0 && !expr.any.some((t) => tags.has(t))) return false;
  if (expr.none && expr.none.some((t) => tags.has(t))) return false;
  return true;
}

/** Tags an expression asks for (not its exclusions); each one raises specificity. */
export function positiveTags(expr: TagExpr | undefined): string[] {
  return [...(expr?.all ?? []), ...(expr?.any?.length ? [expr.any[0]] : [])];
}

/** `{slot}` names in a line. */
export function slotsOf(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

/**
 * Every variant of `spec` that `persona` may say in this situation. `plain` is
 * the untagged wording (the persona's own, if it has one), `spec.variants` the
 * tagged extras; both must pass the line's `when`, and every `{slot}` must
 * have a value.
 */
export function candidatesFor(
  id: string,
  spec: LineSpec,
  plain: readonly string[],
  persona: string,
  sit: Situation,
): Candidate[] {
  if (!matches(spec.when, sit.tags)) return [];
  const lineTags = positiveTags(spec.when);
  const known = (text: string): boolean => slotsOf(text).every((s) => s in sit.vars);
  const out: Candidate[] = [];
  plain.forEach((text, i) => {
    if (known(text)) out.push({ id, text, key: `${id}#${i}:${text}`, weight: 1, tags: lineTags });
  });
  (spec.variants ?? []).forEach((v: TextVariant, i) => {
    if (v.persona && !v.persona.includes(persona)) return;
    if (!matches(v.when, sit.tags) || !known(v.t)) return;
    out.push({
      id,
      text: v.t,
      key: `${id}@${i}:${v.t}`,
      weight: v.weight ?? 1,
      tags: [...lineTags, ...positiveTags(v.when)],
      cooldown: v.cooldown,
      once: v.once,
    });
  });
  return out;
}

export interface SelectorOptions {
  /** Variants used within this many seconds are passed over for fresh ones. */
  repeatWindow: number;
  /** Random draw among this many best-scoring candidates. */
  topChoices: number;
  /** Score added per required tag the situation satisfies. */
  specificity?: number;
  /** Tags that mark something happening (a fight, damage): a line using one gets an extra lift. */
  salient?: readonly string[];
  /** Extra score per salient tag a line uses. */
  salience?: number;
}

/** Chooses among candidates and remembers what it chose. */
export class LineSelector {
  private lastUsed = new Map<string, number>();
  private onceUsed = new Set<string>();

  constructor(
    private opts: SelectorOptions,
    private random: () => number = Math.random,
  ) {}

  reset(): void {
    this.lastUsed.clear();
    this.onceUsed.clear();
  }

  /** The best-fitting candidate, or null when none are eligible. Records the choice. */
  choose(cands: readonly Candidate[], now: number): Candidate | null {
    const spec = this.opts.specificity ?? 0.5;
    const scored: { c: Candidate; score: number }[] = [];
    for (const c of cands) {
      if (c.once && this.onceUsed.has(c.key)) continue;
      const used = this.lastUsed.get(c.key);
      if (used !== undefined && c.cooldown !== undefined && now - used < c.cooldown) continue;
      const hot = c.tags.filter((t) => this.opts.salient?.includes(t)).length;
      let score = c.weight + spec * c.tags.length + (this.opts.salience ?? 1) * hot;
      if (used !== undefined && now - used < this.opts.repeatWindow) score -= 10;
      scored.push({ c, score });
    }
    if (scored.length === 0) return null;
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, Math.max(1, this.opts.topChoices));
    // Weighted draw among the leaders; scores shifted so the weakest still has a chance.
    const floor = top[top.length - 1].score - 0.25;
    const weights = top.map((t) => t.score - floor);
    let r = this.random() * weights.reduce((a, b) => a + b, 0);
    let pick = top[0].c;
    for (let i = 0; i < top.length; i++) {
      r -= weights[i];
      if (r < 0) {
        pick = top[i].c;
        break;
      }
    }
    this.lastUsed.set(pick.key, now);
    if (pick.once) this.onceUsed.add(pick.key);
    return pick;
  }
}
