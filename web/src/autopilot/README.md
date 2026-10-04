# ARGUS autopilot: maneuver scripts

Deterministic scripts (no learned models) that fly the player's ship on the commander's confirmed order. Manual flight stays fully available and always wins.

## Layers

| Layer      | Files                                           | Job                                                                                                                                                                       |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Math       | `orbitmath.ts`                                  | Kepler propagation, time to apsis, phase angles, closest approach. Planar, prograde orbits.                                                                               |
| Primitives | `maneuvers/burn.ts`, `orient.ts`, `sequence.ts` | `BurnManeuver`: wait for node, align, burn with tapering throttle to a measured goal. `Sequence`: stages built lazily so later stages plan from where earlier ones ended. |
| Scripts    | `maneuvers/*.ts`                                | `circularize`, `changeAltitude` (Hohmann), `MatchVelocity`, `StationKeep`, `Rendezvous` (also the intercept approach), `Evade`, `LaunchMissile`, `DropMine`, `Orient`.    |
| Driver     | `pilot.ts`                                      | Holds one proposal and one running maneuver, ticks it from the sim step hook, auto-warps coasts, aborts on manual input.                                                  |
| Commander  | `intents.ts`, `speech.ts`, `ui/pilot.ts`        | Intent catalogue, ARGUS lines (`ap.*` in `advisor/voice.json`), confirm / cancel / abort card.                                                                            |

## Contract

```ts
interface Maneuver {
  plan(ctx): Plan; // pure: burn nodes, dv, eta, feasibility with a reason
  start(ctx): void; // latch decisions (node times, targets)
  execute(ctx): Status; // one control tick: helm commands + progress + `coast` seconds
  abort(ctx): void; // engine cut
}
```

`ctx` is a read-only world view plus a `Helm` that issues the same commands a commander has (attitude, throttle, target, fire, drop). Scripts never touch sim state any other way.

`Status.coast` says how many sim seconds the script can be left alone. The session splits sim steps at that boundary (`StepHook`), so a 100x warp coast wakes exactly at the next burn and burns run one step at a time.

## Manual override

`FlightSession.onManualInput` fires when the commander uses throttle, attitude, rotate or target controls. The pilot aborts at once and the ship keeps whatever the commander just set. Firing weapons by hand does not abort. AI assist off (persisted in `localStorage`, `orbits.aiAssist`) refuses every plan and aborts a running one.

## Tuning

Every gain and margin is in `autopilot.json` (see `config.ts` for what each means). Ship and munition stats come from the sim through `Game.class_stats` / `Game.munition_stats`, so no numbers are duplicated. ARGUS wording is in `advisor/voice.json`.

## Known limits (first slice)

- Planar play only: no plane matching. Retrograde orbits are not handled.
- Rendezvous phases against near-circular targets (`rendezvous.maxEccentricity`); eccentric targets are refused with a reason.
- Rendezvous across a large phase gap takes several orbits (the quickest phasing orbit within `phasingDvBudget` is chosen); auto-warp covers the wait.
- `Evade` burns radially (out, then in); it does not solve for the best escape direction.
- Station-keeping nulls drift and re-closes with a rendezvous; it does not hold a chosen offset.

## Testing

`web/src/autopilot.test.ts` flies each script headlessly against the real WASM sim through the same `FlightSession.update` loop the game uses, and asserts the goal is met within tolerance.
