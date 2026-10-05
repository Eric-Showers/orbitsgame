//! Thin wasm-bindgen facade over `orbit_sim::World`. JS sends commands and
//! reads flat `Float64Array` snapshots; it never mutates sim state directly.

use orbit_sim::vessel::{Kind, MINE, MISSILE, SHIP_CLASSES};
use orbit_sim::{elements, AttitudeMode, OrbitSpec, Planet, World};
use wasm_bindgen::prelude::*;

/// Number of f64 values per entity in `Game::entities()`. Field order is
/// mirrored by `web/src/sim/bridge.ts`.
pub const ENTITY_STRIDE: usize = 25;

#[wasm_bindgen]
pub struct Game {
    world: World,
}

#[wasm_bindgen]
impl Game {
    /// A world around the default scaled 600 km planet.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Game {
        Game {
            world: World::new(Planet::SCALED),
        }
    }

    pub fn planet_radius(&self) -> f64 {
        self.world.planet.radius
    }

    pub fn mu(&self) -> f64 {
        self.world.planet.mu
    }

    pub fn time(&self) -> f64 {
        self.world.time
    }

    pub fn planar(&self) -> bool {
        self.world.planar
    }

    pub fn entity_stride() -> usize {
        ENTITY_STRIDE
    }

    /// Spawns a ship on a planar prograde orbit given by periapsis/apoapsis
    /// altitudes (m above the surface), periapsis angle and true anomaly (rad).
    pub fn spawn_ship(
        &mut self,
        class: u8,
        team: u8,
        periapsis_alt: f64,
        apoapsis_alt: f64,
        arg_periapsis: f64,
        true_anomaly: f64,
    ) -> u32 {
        let r = self.world.planet.radius;
        let spec = OrbitSpec {
            periapsis: r + periapsis_alt,
            apoapsis: r + apoapsis_alt,
            arg_periapsis,
            true_anomaly,
        };
        self.world.spawn_ship_in_orbit(class, team, spec)
    }

    /// Sets a ship's missiles and mines.
    pub fn set_loadout(&mut self, id: u32, missiles: u32, mines: u32) {
        self.world.set_loadout(id, missiles, mines);
    }

    /// Static stats of ship class `class`: dry mass, thrust, slew rate, hp,
    /// missiles, mines, heat capacity (MJ), heat gain at full output (MW),
    /// radiator base and slope (MW), derate start (load fraction), minimum
    /// output at the limit. Empty if the class is unknown.
    pub fn class_stats(class: u8) -> Vec<f64> {
        SHIP_CLASSES.get(class as usize).map_or_else(Vec::new, |c| {
            vec![
                c.dry_mass,
                c.thrust,
                c.slew_rate,
                c.hp,
                c.missiles as f64,
                c.mines as f64,
                c.heat_capacity,
                c.heat_gain,
                c.radiate_base,
                c.radiate_slope,
                c.derate_start,
                c.min_output,
            ]
        })
    }

    /// Static stats of a munition (1 = missile, 2 = mine): mass, delta-v,
    /// accel, closing speed, blast radius, damage, arm time, trigger range,
    /// lifetime, eject speed, RCS delta-v, RCS accel, RCS turn rate, RCS
    /// turn cost, battery capacity (J), energy per m/s (J), solar power (W). Empty for other kinds.
    pub fn munition_stats(kind: u8) -> Vec<f64> {
        let m = match kind {
            1 => &MISSILE,
            2 => &MINE,
            _ => return Vec::new(),
        };
        vec![
            m.mass,
            m.delta_v,
            m.accel,
            m.closing_speed,
            m.blast_radius,
            m.damage,
            m.arm_time,
            m.trigger_range,
            m.lifetime,
            m.eject_speed,
            m.rcs_dv,
            m.rcs_accel,
            m.rcs_turn_rate,
            m.rcs_turn_cost,
            m.battery_j,
            m.energy_per_dv,
            m.solar_w,
        ]
    }

    /// Missiles and mines a ship carries: `[missiles, mines]`, empty if unknown.
    pub fn munitions_left(&self, id: u32) -> Vec<f64> {
        self.world
            .get(id)
            .map_or_else(Vec::new, |e| vec![e.missiles as f64, e.mines as f64])
    }

    /// RCS delta-v left on munition `id` (m/s), -1 if unknown or not a munition.
    pub fn rcs_delta_v(&self, id: u32) -> f64 {
        self.world
            .get(id)
            .filter(|e| e.munition().is_some())
            .map_or(-1.0, |e| e.rcs_dv_left)
    }

    /// Motor state of munition `id`: 0 idle (dormant or no target), 1 main
    /// motor burning, 2 coasting or RCS only, 3 out of all delta-v, 4 unknown.
    pub fn motor_status(&self, id: u32) -> u8 {
        let Some(e) = self.world.get(id).filter(|e| e.munition().is_some()) else {
            return 4;
        };
        if e.main_dv_left <= 0.0 && e.rcs_dv_left <= 0.0 {
            3
        } else if e.throttle > 0.0 {
            1
        } else if e.active {
            2
        } else {
            0
        }
    }

    pub fn set_throttle(&mut self, id: u32, throttle: f64) {
        self.world.set_throttle(id, throttle);
    }

    /// Returns false if the mode is unknown or currently unavailable.
    pub fn set_attitude(&mut self, id: u32, mode: u8) -> bool {
        AttitudeMode::from_u8(mode).is_some_and(|m| self.world.set_attitude(id, m))
    }

    pub fn set_rotate(&mut self, id: u32, input: f64) {
        self.world.set_rotate(id, input);
    }

    /// `target < 0` clears the target.
    pub fn set_target(&mut self, id: u32, target: i32) {
        self.world.set_target(id, u32::try_from(target).ok());
    }

    /// Fires a missile from `id` at its current target. Returns the missile's
    /// id, or -1 without a target or missiles left.
    pub fn launch_missile(&mut self, id: u32) -> i32 {
        self.world.launch_missile(id).map_or(-1, |m| m as i32)
    }

    /// Drops a mine from `id` onto its orbit. Returns the mine's id, or -1.
    pub fn drop_mine(&mut self, id: u32) -> i32 {
        self.world.drop_mine(id).map_or(-1, |m| m as i32)
    }

    /// Advances `n` fixed steps of `dt` seconds.
    pub fn step(&mut self, n: u32, dt: f64) {
        for _ in 0..n {
            self.world.step(dt);
        }
    }

    /// Flat snapshot, `ENTITY_STRIDE` values per entity:
    /// id, kind, team, class, alive, pos xyz, vel xyz, heading xyz, throttle,
    /// heat (MJ), heat_capacity (MJ), output_cap (0..1 of full thrust), mode,
    /// target (-1 = none), hp, mass, max_accel, delta_v (munitions only), battery charge (0..1, munitions with a battery).
    pub fn entities(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.world.entities.len() * ENTITY_STRIDE);
        for e in &self.world.entities {
            out.extend_from_slice(&[
                e.id as f64,
                e.kind as u8 as f64,
                e.team as f64,
                e.class as f64,
                if e.alive { 1.0 } else { 0.0 },
                e.pos.x,
                e.pos.y,
                e.pos.z,
                e.vel.x,
                e.vel.y,
                e.vel.z,
                e.heading.x,
                e.heading.y,
                e.heading.z,
                e.throttle,
                e.heat,
                if e.kind == Kind::Ship {
                    e.ship_class().heat_capacity
                } else {
                    0.0
                },
                e.output_cap(),
                e.mode as u8 as f64,
                e.target.map_or(-1.0, |t| t as f64),
                e.hp,
                e.mass(),
                e.max_accel(),
                e.delta_v(),
                e.charge,
            ]);
        }
        out
    }

    /// Orbit of entity `id` relative to the planet: semi-major axis,
    /// eccentricity, semi-latus rectum, periapsis radius, apoapsis radius,
    /// period, argument of periapsis, true anomaly. Empty if unknown.
    pub fn orbit(&self, id: u32) -> Vec<f64> {
        let Some(e) = self.world.get(id) else {
            return Vec::new();
        };
        let el = elements(self.world.planet.mu, e.pos, e.vel);
        vec![
            el.semi_major_axis,
            el.eccentricity,
            el.semi_latus_rectum,
            el.periapsis,
            el.apoapsis,
            el.period,
            el.arg_periapsis,
            el.true_anomaly,
        ]
    }

    /// Drains events since the last call: kind, id, x, y, z per event.
    pub fn take_events(&mut self) -> Vec<f64> {
        self.world
            .take_events()
            .iter()
            .flat_map(|e| [e.kind as u8 as f64, e.id as f64, e.pos.x, e.pos.y, e.pos.z])
            .collect()
    }
}

impl Default for Game {
    fn default() -> Self {
        Self::new()
    }
}
