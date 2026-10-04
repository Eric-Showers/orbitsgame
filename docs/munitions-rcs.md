# Missiles as advanced rockets

Missiles carry two independent delta-v budgets.

- **Main motor.** Throttleable from zero to full thrust, with instant start and stop. It only pushes along the missile's heading. Budget: `MISSILE.delta_v` (800 m/s).
- **RCS.** Attitude changes are near-instant, and small translations are possible. Each radian of turn costs `rcs_turn_cost` m/s, and each second of translation costs its acceleration. Budget: `MISSILE.rcs_dv` (60 m/s).

Guidance is unchanged. It still asks for a desired acceleration. The munition then turns toward that direction on RCS, burns the main motor along its heading, and covers any leftover with RCS translation.

## Defaults

| Field | Missile | Mine |
| --- | --- | --- |
| `rcs_dv` (m/s) | 60 | 100 |
| `rcs_accel` (m/s^2) | 1.5 | 3.0 |
| `rcs_turn_rate` (rad/s) | 6.0 | 3.0 |
| `rcs_turn_cost` (m/s/rad) | 4.0 | 1.0 |

Mines previously turned instantly. They now use the same RCS model, so the mine values were tuned so the mine-wake test still reaches its target.

## Status for the HUD

- `Game.rcs_delta_v(id)`: RCS delta-v left, m/s. Returns -1 for unknown or non-munition ids.
- `Game.motor_status(id)`: 0 idle (dormant or no target), 1 main motor burning, 2 coasting or RCS only, 3 out of all delta-v, 4 unknown.
- Main-motor delta-v remains in the entity snapshot's `delta_v` slot.
- `Game.munition_stats(1)` appends RCS delta-v, RCS accel, RCS turn rate and RCS turn cost. Existing indices are unchanged.

## How

Tuning lives in the `MISSILE` and `MINE` constants in `crates/orbit-sim/src/vessel.rs`. Trig uses `libm` to keep the simulation deterministic.
