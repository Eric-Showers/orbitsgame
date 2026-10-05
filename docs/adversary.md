# Adversary pilot AI

Scripted opponent in `web/src/adversary/`. Enabled per ship with `"ai": { "pilot": { "tier": 0-3 } }`; it replaces the old `evade` block. Gunner and miner firing are unchanged.

| Tier | Behaviour                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Passive. Holds its orbit.                                                                                                                 |
| 1    | Reactive. One radial burn per threat episode once a munition is inside `reactive.warnRange`.                                              |
| 2    | Anticipates. Slews early, ignites by predicted time to intercept, alternates sides, ignores spent munitions, returns to its patrol orbit. |
| 3    | As tier 2, and pursues its quarry to a standoff range when not under threat.                                                              |

Calibration (player fires into a gunboat): tier 0 and 1 are always hit; tier 2 dodges a salvo of two; tier 3 dodges at long range and is beatable once it has closed inside about 30 km.

All tuning lives in `adversary.json`. The pilot respects the heat model: it burns only below `heat.calmCeiling` except in an emergency, and cools below `heat.resumeBelow`. The pilot also caps time warp (`warp.*`) while it is burning or threatened.

## High-ground hook

`scoring.ts` exports `orbitalAdvantage(perception, mode)`, currently 0, weighted by `score.advantage` (0). `chooseCounter` already adds it to each candidate burn. When the high-ground design lands, implement it there and raise the weight; no other code needs to change.

## Missions 13-17

Kestrel (tier 1), Shrike (2), Hunter (3), Wolf Pack (3 + 2), Last Convoy (3 raider, protect the freighter). Each is proven winnable by a scripted salvo plan in `web/src/adversary.test.ts`.
