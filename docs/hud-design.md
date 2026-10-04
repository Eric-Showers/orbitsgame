# HUD design

## What fighter HUDs teach us

1. **Information sits where the eyes already are.** A fighter HUD puts flight-critical symbology in the pilot's line of sight so no head-down glance breaks the OODA loop. Our "line of sight" is wherever the camera is focused (often a target, zoomed in), so anything that must be readable regardless of zoom or focus lives in fixed screen positions on the HUD, never on map labels that scroll away.
2. **Priority layering.** Level 1 is always on and never needs a mode change (survival: orbit shape, impact warning, thermal limit). Level 2 appears when its subject exists (target block when something is tracked, munition tracks when something is in flight). Level 3 is on demand (full numeric detail, per-munition table).
3. **Declutter.** Fighter HUDs have declutter modes (NAV / combat / landing). We offer FULL / COMBAT / MIN / OFF on one key. Nothing is ever removed from the sim data, only from the screen.
4. **Closure over absolutes.** Pilots watch rates and trends (closure, time-to-go) more than raw positions. Every target number comes paired with a time-to-event or a delta.
5. **Cautions escalate by colour only when they matter.** Dim cyan = informational, amber = approaching a limit, red = act now. Colour is never the only channel (the text also changes: `HOT`, `IMPACT`).
6. **Grouped by decision, not by subsystem.** Orient (where am I), Observe (what is it doing), Decide (can I kill it, can I afford to burn), Act (resources and weapon state).

## Mapping to orbital combat

| OODA step | Question                                  | HUD answer                                                                     |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| Observe   | What is my orbit, what is the target's?   | Own orbit strip, target orbit strip                                            |
| Orient    | How are we moving relative to each other? | Range, closing speed, relative velocity, time and distance of closest approach |
| Decide    | What does it cost to catch or match?      | Delta-v to match velocity now; thermal headroom; munition inventory and state  |
| Act       | Is my weapon working?                     | Per-munition rows, intercept lines in the view                                 |

## Layout (recommended: "Top strips, left resources, in-view tracks")

```
+--------------------------------------------------------------+
| mission objectives     [ OWN ORBIT strip, top centre ]   comms|
| (existing, top-left)   Ap 120.3km T-12:03 | Pe 78.1km T-44:00 | (existing)
|                        e 0.0123 | T 01:31:12 | alt, speed     |
|                        [ TARGET strip, below it, if tracked ] |
|                        Drone #3  range  closing  TCA  miss  dV |
|                        its Ap/Pe/e/T                           |
|                                                                |
|                  (flight view: ship, target, tracks)           |
|                                                                |
| [RESOURCES, left]                      [MUNITIONS, right]      |
|  thermal bar                           M12 dv 310  ->#3  4.2km |
|  missiles 6  mines 2                   m 7 bat 62% awake       |
|  [ARGUS pilot, existing]                                       |
| [ existing console ]                                           |
+--------------------------------------------------------------+
```

- **Always on (L1):** own orbit strip (Ap, Pe, time to each, e, period, altitude, speed), warning line (impact, thermal, depleted), resources block.
- **When tracked (L2):** target strip with its own orbit stats and the closure numbers. Delta-v to match is shown here because it is the cost of the Decide step.
- **When in flight (L2):** munition rows and in-view intercept graphics (line to the target, predicted closest-approach marker, kill-radius ring).
- **On demand (L3):** `I` toggles detail (adds per-munition rows beyond the nearest three, full orbit element list).
- **Declutter key:** `I` cycles FULL -> COMBAT -> MIN -> OFF. COMBAT hides the own-orbit secondary numbers and keeps target and munitions. MIN keeps only Ap, Pe, warnings and the thermal bar.

## Other layouts considered

**A. Dashboard cluster (all in the existing console).** Extend the NAV/TARGET modules with the new fields. Cheapest, but it stays at the bottom edge, away from the focus of attention, which is exactly the "hard to find AP/PE while zoomed in" complaint. Rejected.

**B. Central reticle HUD.** Draw everything around the focused object (rings and tapes centred on screen, like a gunsight). Best for line-of-sight, but the focus is often a target or a free camera, so numbers would orbit around objects that are not the player's ship, and they collide with the sprites at high zoom. Good for a later "gunsight" for munitions only.

**C. Top strips, left resources, in-view tracks (recommended).** Fixed screen positions that avoid the existing corners (mission top-left, comms top-right, ARGUS bottom-left), symbology for munitions drawn in the world view where the player is already looking.

## Data slots for the new physics

The HUD reads one adapter (`ui/hudData.ts`). Fields the Rust physics will publish are optional there:

- `heat`: fraction of the thermal limit (0..1) plus a rate. Until published, a stand-in is the current throttle.
- `missiles`/`mines` magazines: already exposed (`munitions_left`).
- Missile delta-v remaining (main motor) and RCS delta-v: today `deltaV` and `fuel` of the missile entity; the RCS slot shows `—` until published.
- Mine battery (0..1) and charge/drain rate: today `fuel/fuelMax` stand in; the rate slot shows `—`.
- Kill radius: from `munition_stats` blast radius (the sim's current mine value is 30 m; the 3 km world-building figure shows once the sim publishes it).

Per the design rule "no adversarial technology secrets", all of these are shown for every friendly or enemy munition, not only the player's.
