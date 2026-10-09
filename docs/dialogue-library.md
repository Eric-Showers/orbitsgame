# Ship AI dialogue library

How the vessel AI picks what to say, and how to add lines. Code: `web/src/advisor/`, wording: `voice.json` and `personas.json`.

## Line kinds

- **Fixed lines** (alarms, events, helm, acknowledgements): chosen by id, rotated in order. Never gated by the selector.
- **Quips** (category `quip`): chosen by the line selector from every `quip.*` line that fits the moment.
- **Debrief** (`debrief.*`): spoken one line at a time after a burn ends, in place of the plain orbit report. See `debrief.ts`.

## Tagged variants

A line has `text` (plain strings, fit any moment) and optional `variants`:

```json
"quip.combat": {
  "priority": "quip", "category": "quip", "text": [],
  "variants": [
    { "t": "{kills} down. At this rate the logbook will need a second page.",
      "when": { "all": ["player.kill_streak"] }, "persona": ["argus"] }
  ]
}
```

- `when`: `all` (every tag), `any` (at least one), `none` (excluded). A line-level `when` applies to every variant.
- `weight` (default 1), `cooldown` (seconds before the same variant again), `once` (once per flight), `persona` (only these personas).
- `{slot}` values come from the situation (`target`, `range`, `kills`, `altitude`, `pe`, `ap`); a variant whose slot has no value is skipped.
- Score = weight + 0.5 per required tag + 1 per salient tag (`situation.salientTags`), minus a penalty for recent use; the selector draws at random among the best few.
- A persona with its own `lines[id]` replaces the plain `text` of that id; tagged variants still apply unless limited to other personas.

Tags are derived in `situation.ts`: `orbit.*`, `hull.*`, `heat.*`, `hostile.*`, `target.set`, `mission.<kind>`, `player.*`, `burn.recent`, `warp.high`, `persona.<id>`. Thresholds live under `situation` in `voice.json`.

## Written for text-to-speech

Lines are read by simple speech engines. Write so the reading is unambiguous:

- No initialisms or abbreviations ("AI", "ETA", "RCS"); write the words. A test fails on unrecognized all-capital tokens.
- Units and symbols are expanded at speech time by `spoken()` (`km` to kilometers, `m/s` to meters per second, `%` to percent), so measurements can be authored as `{range}` slots.
- Keep lines short; a test caps length.
