# Propulsion: heat instead of fuel

Ships have no fuel limit. The fusion drive burns as long as it is asked to; heat is the constraint.

- Heat is stored per ship in MJ. At output `o` (0..1) the drive adds `heat_gain * o` MW.
- Radiators shed `radiate_base + radiate_slope * load` MW, where `load = heat / heat_capacity`.
- Output cap is 1 until `load > derate_start`, then falls linearly to `min_output` at load 1. Effective output is `min(throttle, cap)`.
- An `Overheat` sim event fires when load crosses `derate_start` upward.
- Munitions still carry their own delta-v budgets.

Tuning lives in the `SHIP_CLASSES` table in `crates/orbit-sim/src/vessel.rs` (the sim has no JSON config; this is the one place), with the `heat_*`, `radiate_*`, `derate_start` and `min_output` fields per class.

Client: WASM `entities()` stride 24 carries `heat`, `heatCapacity`, `outputCap`; `class_stats` carries the thermal constants. The autopilot's `burnSeconds` steps the same model, and `burnTooLong` replaces the old delta-v reserve check. The third mission star is `heatCeiling`: peak heat fraction must stay at or below it.
