//! Thin wasm-bindgen facade over `orbit_sim::World`. JS sends commands and
//! reads flat `Float64Array` snapshots; it never mutates sim state directly.

use orbit_sim::{elements, AttitudeMode, OrbitSpec, Planet, World};
use wasm_bindgen::prelude::*;

/// Number of f64 values per entity in `Game::entities()`. Field order is
/// mirrored by `web/src/sim/bridge.ts`.
pub const ENTITY_STRIDE: usize = 23;

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
    /// fuel, fuel_max, delta_v, mode, target (-1 = none), hp, mass, max_accel.
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
                e.fuel,
                e.ship_class().fuel_mass,
                e.delta_v(),
                e.mode as u8 as f64,
                e.target.map_or(-1.0, |t| t as f64),
                e.hp,
                e.mass(),
                e.max_accel(),
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
