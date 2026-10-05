# Mines: solar-charged drones

Mines are slow autonomous drones. A battery powers their electric main motor,
and solar panels recharge it in sunlight, so a full mine can reach further
than a depleted one.

## Defaults (sim: `crates/orbit-sim/src/vessel.rs`, `MINE`)

| Parameter | Value | Notes |
| --- | --- | --- |
| Battery capacity | 1 MJ | Starts full when dropped. |
| Energy per m/s of main-motor delta-v | 4 kJ | Full battery equals 250 m/s, so the 150 m/s motor budget binds at full charge. |
| Solar power in sunlight | 1 kW | Full recharge from empty in about 17 minutes. |
| Eclipse | Planet cylinder | No charging while the planet hides the sun. |
| Wake / terminal trigger | 3 km | Was 5 km. The mine wakes inside 3 km and closes to its 30 m blast radius on RCS. |
| Main motor | 150 m/s, 8 m/s^2 | Unchanged. Now also capped by battery charge each tick. |
| RCS | 100 m/s, 3 m/s^2 | Unchanged, from the missile merge. Not drawn from the battery. |

Sun: 25 degrees from +x, read from `web/src/render/celestial.json` by
`withSunFromConfig` in `web/src/sim/bridge.ts`.

## Behaviour

- Dormant mines charge in sunlight and do not drain.
- Thrust is limited by both the motor budget and the charge left. An empty
  mine cannot burn its main motor but can still use RCS.
- Missiles have no battery and behave as before.

## Tuning changes made with this

- Mission `mine-corridor`: convoy lane moved from 86.5 km to 87 km so the
  convoy passes within the new 3 km trigger of mines at 89.5 km. Text now says
  3 km.
- Autopilot `weapons.mineRangeFraction` 0.8 to 1.0, since the trigger is now
  the full 3 km and the mine itself closes to contact.
- Practice scenario (`web/src/sim/session.ts`): the low drone starts 2 km
  below instead of 3 km, so a dropped mine can still catch it.
- Autopilot test hostile moved from 77 km to 78 km for the same reason.

## Open

- Battery and charge rates are chosen for playtesting, not balanced.
- Battery values live in Rust (`vessel.rs`) alongside the other munition
  constants, not in a JSON config file. The sim has no JSON loader.
- The design doc (`/mnt/project-files/design/orbits-design.md`) was not
  reachable from this worktree, so these notes are in the branch.
