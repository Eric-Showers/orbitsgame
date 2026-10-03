//! Deterministic orbital simulation core.
//!
//! All state is 3D (`Vec3`) even though gameplay is currently confined to the
//! z = 0 plane. Only IEEE-754 exact operations (+, -, *, /, sqrt) are used in
//! the integrator so native (server) and wasm32 (client) builds produce
//! bit-identical results. Transcendentals must go through `libm`.

pub mod vec3;

pub use vec3::Vec3;

use serde::{Deserialize, Serialize};

/// A point mass moving in the gravity field of a fixed central body.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Body {
    pub pos: Vec3,
    pub vel: Vec3,
}

/// Minimal two-body world: one fixed central mass, many orbiting bodies.
///
/// This is the smoke-test sim. The planned hybrid model (analytic Kepler
/// propagation while coasting, symplectic integration under thrust or near
/// encounters) will build on top of this.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct World {
    /// Gravitational parameter of the central body (G * M), in sim units.
    pub mu: f64,
    pub bodies: Vec<Body>,
    pub time: f64,
}

impl World {
    pub fn new(mu: f64) -> Self {
        Self {
            mu,
            bodies: Vec::new(),
            time: 0.0,
        }
    }

    /// Adds a body on a circular orbit of radius `r` in the xy-plane.
    pub fn add_circular_orbit(&mut self, r: f64) -> usize {
        let speed = (self.mu / r).sqrt();
        self.bodies.push(Body {
            pos: Vec3::new(r, 0.0, 0.0),
            vel: Vec3::new(0.0, speed, 0.0),
        });
        self.bodies.len() - 1
    }

    fn accel(&self, pos: Vec3) -> Vec3 {
        let r2 = pos.length_squared();
        let r = r2.sqrt();
        pos * (-self.mu / (r2 * r))
    }

    /// Advances the world by `dt` using velocity Verlet (kick-drift-kick),
    /// a second-order symplectic integrator.
    pub fn step(&mut self, dt: f64) {
        for i in 0..self.bodies.len() {
            let b = self.bodies[i];
            let v_half = b.vel + self.accel(b.pos) * (0.5 * dt);
            let pos = b.pos + v_half * dt;
            let vel = v_half + self.accel(pos) * (0.5 * dt);
            self.bodies[i] = Body { pos, vel };
        }
        self.time += dt;
    }

    /// Specific orbital energy of a body (kinetic + potential per unit mass).
    pub fn specific_energy(&self, i: usize) -> f64 {
        let b = &self.bodies[i];
        0.5 * b.vel.length_squared() - self.mu / b.pos.length()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circular_orbit_returns_to_start_after_one_period() {
        let mut w = World::new(1.0);
        let i = w.add_circular_orbit(1.0);
        let period = 2.0 * core::f64::consts::PI; // 2*pi*sqrt(r^3/mu)
        let steps = 10_000;
        let dt = period / steps as f64;
        for _ in 0..steps {
            w.step(dt);
        }
        let b = w.bodies[i];
        assert!(
            (b.pos - Vec3::new(1.0, 0.0, 0.0)).length() < 1e-3,
            "pos = {:?}",
            b.pos
        );
        assert!(b.pos.z.abs() < 1e-12, "planar orbit must stay in z = 0");
    }

    #[test]
    fn energy_is_conserved() {
        let mut w = World::new(398_600.0);
        let i = w.add_circular_orbit(7_000.0);
        let e0 = w.specific_energy(i);
        for _ in 0..100_000 {
            w.step(1.0);
        }
        let drift = ((w.specific_energy(i) - e0) / e0).abs();
        assert!(drift < 1e-6, "relative energy drift {drift}");
    }

    #[test]
    fn simulation_is_deterministic() {
        let run = || {
            let mut w = World::new(1.0);
            w.add_circular_orbit(1.3);
            for _ in 0..1000 {
                w.step(0.01);
            }
            w.bodies[0]
        };
        let (a, b) = (run(), run());
        assert_eq!(a.pos.x.to_bits(), b.pos.x.to_bits());
        assert_eq!(a.vel.y.to_bits(), b.vel.y.to_bits());
    }
}
