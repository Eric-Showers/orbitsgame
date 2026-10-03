//! Thin wasm-bindgen wrapper around `orbit_sim::World`.

use orbit_sim::World;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Sim {
    world: World,
}

#[wasm_bindgen]
impl Sim {
    #[wasm_bindgen(constructor)]
    pub fn new(mu: f64) -> Sim {
        Sim {
            world: World::new(mu),
        }
    }

    /// Adds a body on a circular orbit of radius `r`; returns its index.
    pub fn add_circular_orbit(&mut self, r: f64) -> usize {
        self.world.add_circular_orbit(r)
    }

    pub fn step(&mut self, dt: f64) {
        self.world.step(dt);
    }

    pub fn time(&self) -> f64 {
        self.world.time
    }

    pub fn body_count(&self) -> usize {
        self.world.bodies.len()
    }

    /// Positions packed as [x0, y0, z0, x1, y1, z1, ...] for cheap transfer to JS.
    pub fn positions(&self) -> Vec<f64> {
        self.world
            .bodies
            .iter()
            .flat_map(|b| [b.pos.x, b.pos.y, b.pos.z])
            .collect()
    }
}
