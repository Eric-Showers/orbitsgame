# Mines: solar-charged delivery drones

A mine is a slow, battery-powered drone. It is only the delivery vehicle for a
kinetic vehicle (KV), which is the only thing that kills.

## Behaviour

- Dormant mines charge in sunlight (not in the planet's shadow) and do not drain.
- A mine wakes when an enemy comes within 5 km. Once awake, its electric
  thruster works toward its target continuously, limited by battery charge.
- Inside 2.2 km the mine converts into its KV in place: same id, KV kind,
  launch event. The mine has no contact fuse.
- The KV is a mini-missile: a tenth of the missile's delta-v, caps its closing
  speed at 50 m/s by braking, and steers on a small RCS budget to null lateral
  error on the final approach.
- A target that outruns a KV escapes. A mine that never reaches 2.2 km is
  spent when its lifetime runs out.
- Missiles have no battery and keep their old guidance (no braking).

## Constants (`crates/orbit-sim/src/vessel.rs`)

| Item                                  | Value                            |
| ------------------------------------- | -------------------------------- |
| Mine battery                          | 1 MJ, starts full                |
| Battery per m/s of main-motor delta-v | 4 kJ                             |
| Solar power in sunlight               | 1 kW                             |
| Mine wake range                       | 5 km                             |
| KV launch range                       | 2.2 km                           |
| Mine main motor                       | 150 m/s, 8 m/s^2, lifetime 900 s |
| Mine RCS                              | 100 m/s, 3 m/s^2                 |
| KV delta-v                            | 80 m/s, 50 m/s^2                 |
| KV closing speed cap                  | 50 m/s (brakes)                  |
| KV RCS                                | 60 m/s, 3 m/s^2                  |
| KV lifetime                           | 120 s                            |
| KV blast                              | 40 m, 100 damage                 |

The sun is at 25 degrees from +x, read from `web/src/render/celestial.json`
through `withSunFromConfig` in `web/src/sim/bridge.ts`.

## Tuning changes made with this

- Mission `mine-corridor`: convoy lane stays at 86.5 km. Mines are laid at
  88.5 km, inside the 88-91 km corridor and about 2 km above the lane, so the
  convoy passes inside the KV launch range. The test drops mines at 88.5 km.
- Mission `mine-corridor` text describes the 5 km wake and the KV.
- Mission run: a KV counts as a mine in flight, and a KV blast counts as a
  mine kill. Without this, the objective failed the moment a mine converted.
- Autopilot `weapons.mineRangeFraction` 0.8 to 1.0. The autopilot test hostile
  moved from 77 km to 78 km.
- Practice scenario (`web/src/sim/session.ts`): the low drone starts 2 km below
  instead of 3 km.

## Open

- Battery, solar and KV numbers are untuned, chosen for playtesting.
- Sim constants live in Rust alongside the other munition constants. The sim
  has no JSON loader.
- The shared design doc (`/mnt/project-files/design/orbits-design.md`) was not
  reachable from this worktree, so these notes are in the branch.
