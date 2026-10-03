use serde::{Deserialize, Serialize};

/// Central body. Everything orbits a single planet for now.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Planet {
    /// Gravitational parameter G*M (m^3/s^2).
    pub mu: f64,
    /// Surface radius (m). Anything below it has crashed.
    pub radius: f64,
}

impl Planet {
    /// Default game world: a 600 km body with Kerbin's mu (design doc sec. 2.1).
    pub const SCALED: Planet = Planet { mu: 3.5316e12, radius: 600_000.0 };

    pub fn circular_speed(&self, r: f64) -> f64 {
        (self.mu / r).sqrt()
    }
}
