//! Orbital elements and the local orbital frame.

use crate::Vec3;
use core::f64::consts::PI;
use serde::{Deserialize, Serialize};

/// Shape of an orbit derived from a state vector. Radii are measured from the
/// planet centre; `apoapsis` and `period` are infinite for escape orbits.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Elements {
    pub semi_major_axis: f64,
    pub eccentricity: f64,
    /// Semi-latus rectum: the conic is r(theta) = p / (1 + e cos(theta - omega)).
    pub semi_latus_rectum: f64,
    pub periapsis: f64,
    pub apoapsis: f64,
    pub period: f64,
    /// Angle of the periapsis direction in the xy-plane (omega).
    pub arg_periapsis: f64,
    pub true_anomaly: f64,
    /// Specific orbital energy (J/kg).
    pub energy: f64,
}

pub fn elements(mu: f64, r: Vec3, v: Vec3) -> Elements {
    let rmag = r.length();
    let h = r.cross(v);
    let energy = 0.5 * v.length_squared() - mu / rmag;
    let e_vec = v.cross(h) * (1.0 / mu) - r * (1.0 / rmag);
    let ecc = e_vec.length();
    let p = h.length_squared() / mu;
    let periapsis = p / (1.0 + ecc);
    let (semi_major_axis, apoapsis, period) = if ecc < 1.0 {
        let a = -mu / (2.0 * energy);
        (a, p / (1.0 - ecc), 2.0 * PI * (a * a * a / mu).sqrt())
    } else {
        (f64::INFINITY, f64::INFINITY, f64::INFINITY)
    };
    let (arg_periapsis, true_anomaly) = if ecc > 1e-9 {
        let hn = h.normalize_or_zero();
        let nu = libm::atan2(e_vec.cross(r).dot(hn), e_vec.dot(r));
        (libm::atan2(e_vec.y, e_vec.x), nu)
    } else {
        // Circular: measure from the x axis.
        (0.0, libm::atan2(r.y, r.x))
    };
    Elements {
        semi_major_axis,
        eccentricity: ecc,
        semi_latus_rectum: p,
        periapsis,
        apoapsis,
        period,
        arg_periapsis,
        true_anomaly,
        energy,
    }
}

/// Planar, prograde (counter-clockwise) orbit described by its periapsis and
/// apoapsis radii, the periapsis angle and the body's true anomaly.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct OrbitSpec {
    pub periapsis: f64,
    pub apoapsis: f64,
    pub arg_periapsis: f64,
    pub true_anomaly: f64,
}

impl OrbitSpec {
    pub fn circular(radius: f64, angle: f64) -> Self {
        Self {
            periapsis: radius,
            apoapsis: radius,
            arg_periapsis: 0.0,
            true_anomaly: angle,
        }
    }

    pub fn state(&self, mu: f64) -> (Vec3, Vec3) {
        let (rp, ra) = (self.periapsis, self.apoapsis);
        let e = (ra - rp) / (ra + rp);
        let p = 0.5 * (rp + ra) * (1.0 - e * e);
        let (s, c) = (libm::sin(self.true_anomaly), libm::cos(self.true_anomaly));
        let r = p / (1.0 + e * c);
        let vs = (mu / p).sqrt();
        let pos = Vec3::new(r * c, r * s, 0.0);
        let vel = Vec3::new(-vs * s, vs * (e + c), 0.0);
        (
            pos.rotate_about(Vec3::Z, self.arg_periapsis),
            vel.rotate_about(Vec3::Z, self.arg_periapsis),
        )
    }
}

/// Local orbital frame directions (all unit vectors).
pub fn prograde(v: Vec3) -> Vec3 {
    v.normalize_or_zero()
}

pub fn radial_out(r: Vec3) -> Vec3 {
    r.normalize_or_zero()
}

pub fn normal(r: Vec3, v: Vec3) -> Vec3 {
    r.cross(v).normalize_or_zero()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Planet;

    #[test]
    fn spec_round_trips_through_elements() {
        let mu = Planet::SCALED.mu;
        let spec = OrbitSpec {
            periapsis: 680_000.0,
            apoapsis: 900_000.0,
            arg_periapsis: 0.7,
            true_anomaly: 2.0,
        };
        let (r, v) = spec.state(mu);
        let el = elements(mu, r, v);
        assert!((el.periapsis - spec.periapsis).abs() < 1e-6);
        assert!((el.apoapsis - spec.apoapsis).abs() < 1e-6);
        assert!((el.arg_periapsis - 0.7).abs() < 1e-9);
        assert!((el.true_anomaly - 2.0).abs() < 1e-9);
    }

    #[test]
    fn circular_orbit_has_zero_eccentricity_and_expected_period() {
        let pl = Planet::SCALED;
        let r = 680_000.0;
        let (pos, vel) = OrbitSpec::circular(r, 0.3).state(pl.mu);
        let el = elements(pl.mu, pos, vel);
        assert!(el.eccentricity < 1e-12);
        let expected = 2.0 * PI * (r * r * r / pl.mu).sqrt();
        assert!((el.period - expected).abs() < 1e-6);
    }

    #[test]
    fn escape_velocity_gives_open_orbit() {
        let mu = Planet::SCALED.mu;
        let r = Vec3::new(700_000.0, 0.0, 0.0);
        let v = Vec3::new(0.0, (2.0 * mu / 700_000.0).sqrt() * 1.1, 0.0);
        let el = elements(mu, r, v);
        assert!(el.eccentricity > 1.0);
        assert!(el.apoapsis.is_infinite());
    }
}
