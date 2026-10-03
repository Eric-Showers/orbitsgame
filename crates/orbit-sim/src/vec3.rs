use core::ops::{Add, AddAssign, Mul, Neg, Sub, SubAssign};
use serde::{Deserialize, Serialize};

/// Double-precision 3D vector. Used for all positions and velocities.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const ZERO: Self = Self::new(0.0, 0.0, 0.0);

    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    pub fn dot(self, o: Self) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    pub fn cross(self, o: Self) -> Self {
        Self::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }

    pub fn length_squared(self) -> f64 {
        self.dot(self)
    }

    pub fn length(self) -> f64 {
        self.length_squared().sqrt()
    }
}

impl Add for Vec3 {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        Self::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}

impl AddAssign for Vec3 {
    fn add_assign(&mut self, o: Self) {
        *self = *self + o;
    }
}

impl Sub for Vec3 {
    type Output = Self;
    fn sub(self, o: Self) -> Self {
        Self::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}

impl SubAssign for Vec3 {
    fn sub_assign(&mut self, o: Self) {
        *self = *self - o;
    }
}

impl Mul<f64> for Vec3 {
    type Output = Self;
    fn mul(self, s: f64) -> Self {
        Self::new(self.x * s, self.y * s, self.z * s)
    }
}

impl Neg for Vec3 {
    type Output = Self;
    fn neg(self) -> Self {
        Self::new(-self.x, -self.y, -self.z)
    }
}

impl Vec3 {
    pub const Z: Self = Self::new(0.0, 0.0, 1.0);

    /// Unit vector in the same direction, or zero for a zero vector.
    pub fn normalize_or_zero(self) -> Self {
        let len = self.length();
        if len > 0.0 {
            self * (1.0 / len)
        } else {
            Self::ZERO
        }
    }

    /// Rotates `self` by `angle` radians about the unit `axis` (Rodrigues).
    pub fn rotate_about(self, axis: Self, angle: f64) -> Self {
        let (s, c) = (libm::sin(angle), libm::cos(angle));
        self * c + axis.cross(self) * s + axis * (axis.dot(self) * (1.0 - c))
    }

    /// Angle in radians between two vectors.
    pub fn angle_to(self, o: Self) -> f64 {
        let denom = self.length() * o.length();
        if denom == 0.0 {
            return 0.0;
        }
        libm::acos((self.dot(o) / denom).clamp(-1.0, 1.0))
    }

    pub fn with_z(self, z: f64) -> Self {
        Self::new(self.x, self.y, z)
    }
}
