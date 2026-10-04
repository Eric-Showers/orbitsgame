//! Vessel classes, munitions and the per-entity state the world simulates.

use crate::Vec3;
use serde::{Deserialize, Serialize};

/// Standard gravity, for the rocket equation (m/s^2).
pub const G0: f64 = 9.80665;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Kind {
    Ship = 0,
    Missile = 1,
    Mine = 2,
}

/// Attitude hold modes, named after their orbital-mechanics directions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum AttitudeMode {
    /// Keep the current heading (manual rotation applies).
    Hold = 0,
    Prograde = 1,
    Retrograde = 2,
    RadialOut = 3,
    RadialIn = 4,
    Normal = 5,
    AntiNormal = 6,
    /// Point at the target.
    Target = 7,
    AntiTarget = 8,
    /// Along velocity relative to the target.
    TargetPrograde = 9,
    /// Against velocity relative to the target: burning here kills relative speed.
    TargetRetrograde = 10,
}

impl AttitudeMode {
    pub fn from_u8(v: u8) -> Option<Self> {
        use AttitudeMode::*;
        Some(match v {
            0 => Hold,
            1 => Prograde,
            2 => Retrograde,
            3 => RadialOut,
            4 => RadialIn,
            5 => Normal,
            6 => AntiNormal,
            7 => Target,
            8 => AntiTarget,
            9 => TargetPrograde,
            10 => TargetRetrograde,
            _ => return None,
        })
    }

    /// Modes that leave the orbital plane.
    pub fn is_out_of_plane(self) -> bool {
        matches!(self, AttitudeMode::Normal | AttitudeMode::AntiNormal)
    }

    pub fn needs_target(self) -> bool {
        use AttitudeMode::*;
        matches!(
            self,
            Target | AntiTarget | TargetPrograde | TargetRetrograde
        )
    }
}

/// AI behaviour flags. Combine with `|`.
pub mod ai {
    pub const NONE: u8 = 0;
    /// Fires missiles at the nearest enemy ship in range.
    pub const GUNNER: u8 = 1;
    /// Drops mines periodically while an enemy is nearby.
    pub const MINER: u8 = 2;
    /// Burns across the line of sight of incoming missiles.
    pub const DODGER: u8 = 4;
}

/// Static stats of a ship class.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShipClass {
    pub name: &'static str,
    /// Hull and drive mass (kg). The fusion drive has no propellant limit.
    pub dry_mass: f64,
    /// Main engine thrust at full output (N).
    pub thrust: f64,
    /// Attitude slew rate (rad/s).
    pub slew_rate: f64,
    pub hp: f64,
    pub missiles: u32,
    pub mines: u32,
    /// Thermal limit of the drive (MJ). Zero means the ship has no drive heat model.
    pub heat_capacity: f64,
    /// Waste heat at full output (MW).
    pub heat_gain: f64,
    /// Radiator dissipation when cold (MW).
    pub radiate_base: f64,
    /// Extra dissipation at the thermal limit (MW); scales with load, hotter radiates faster.
    pub radiate_slope: f64,
    /// Load fraction (heat / capacity) above which output starts to derate.
    pub derate_start: f64,
    /// Output fraction the drive is held to at the thermal limit.
    pub min_output: f64,
}

pub const CORVETTE: u8 = 0;
pub const DRONE: u8 = 1;
pub const GUNBOAT: u8 = 2;
pub const MINELAYER: u8 = 3;
pub const BEACON: u8 = 4;

/// First-guess numbers; balance tuning lives here.
pub const SHIP_CLASSES: [ShipClass; 5] = [
    // Player corvette: 0.75 g at full output; thermal limit, not fuel, bounds sustained burns.
    ShipClass {
        name: "Corvette",
        dry_mass: 16_000.0,
        thrust: 120_000.0,
        slew_rate: 0.5,
        hp: 100.0,
        missiles: 4,
        mines: 3,
        heat_capacity: 600.0,
        heat_gain: 12.0,
        radiate_base: 1.80,
        radiate_slope: 6.0,
        derate_start: 0.6,
        min_output: 0.3,
    },
    // Unarmed target drone.
    ShipClass {
        name: "Drone",
        dry_mass: 5_000.0,
        thrust: 20_000.0,
        slew_rate: 0.3,
        hp: 50.0,
        missiles: 0,
        mines: 0,
        heat_capacity: 150.0,
        heat_gain: 3.0,
        radiate_base: 0.45,
        radiate_slope: 1.5,
        derate_start: 0.6,
        min_output: 0.3,
    },
    ShipClass {
        name: "Gunboat",
        dry_mass: 17_000.0,
        thrust: 100_000.0,
        slew_rate: 0.4,
        hp: 100.0,
        missiles: 4,
        mines: 0,
        heat_capacity: 500.0,
        heat_gain: 10.0,
        radiate_base: 1.50,
        radiate_slope: 5.0,
        derate_start: 0.6,
        min_output: 0.3,
    },
    ShipClass {
        name: "Minelayer",
        dry_mass: 19_000.0,
        thrust: 90_000.0,
        slew_rate: 0.35,
        hp: 120.0,
        missiles: 0,
        mines: 6,
        heat_capacity: 700.0,
        heat_gain: 14.0,
        radiate_base: 2.10,
        radiate_slope: 7.0,
        derate_start: 0.6,
        min_output: 0.3,
    },
    // Passive navigation beacon (rendezvous target), cannot be damaged in practice.
    ShipClass {
        name: "Beacon",
        dry_mass: 1_000.0,
        thrust: 0.0,
        slew_rate: 0.0,
        hp: 1.0e9,
        missiles: 0,
        mines: 0,
        heat_capacity: 0.0,
        heat_gain: 0.0,
        radiate_base: 0.00,
        radiate_slope: 0.0,
        derate_start: 1.0,
        min_output: 1.0,
    },
];

/// Static stats of a self-guided munition.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MunitionSpec {
    pub mass: f64,
    pub delta_v: f64,
    /// Max acceleration of its motor (m/s^2).
    pub accel: f64,
    /// Closing speed the guidance tries to hold toward its target (m/s).
    pub closing_speed: f64,
    /// Proximity-fuse and blast radius (m).
    pub blast_radius: f64,
    pub damage: f64,
    /// Seconds after release before it can trigger or detonate.
    pub arm_time: f64,
    /// Mines wake up when an enemy comes within this range (m).
    pub trigger_range: f64,
    /// Self-destruct after this many seconds of flight once active.
    pub lifetime: f64,
    /// Proportional navigation constant (design doc sec. 3.5: N = 3-5).
    /// Higher steers harder late in the run and spends delta-v sooner.
    pub nav_gain: f64,
    /// Release speed (m/s): missiles toward the target, mines radially out.
    pub eject_speed: f64,
    /// An active mine gives up when its target is this many trigger ranges
    /// away (missiles never give up).
    pub lose_track: f64,
}

pub const MISSILE: MunitionSpec = MunitionSpec {
    mass: 60.0,
    delta_v: 800.0,
    accel: 50.0,
    closing_speed: 400.0,
    blast_radius: 40.0,
    damage: 50.0,
    arm_time: 1.0,
    trigger_range: 0.0,
    lifetime: 600.0,
    nav_gain: 3.0,
    eject_speed: 5.0,
    lose_track: 0.0,
};

pub const MINE: MunitionSpec = MunitionSpec {
    mass: 40.0,
    delta_v: 150.0,
    accel: 8.0,
    closing_speed: 60.0,
    blast_radius: 30.0,
    damage: 100.0,
    arm_time: 5.0,
    trigger_range: 5_000.0,
    lifetime: 300.0,
    nav_gain: 3.0,
    eject_speed: 1.0,
    lose_track: 2.0,
};

/// One simulated object: a ship, a missile or a mine.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entity {
    pub id: u32,
    pub kind: Kind,
    pub team: u8,
    /// Index into `SHIP_CLASSES` (ships only).
    pub class: u8,
    pub alive: bool,
    pub pos: Vec3,
    pub vel: Vec3,
    /// Unit vector the main engine points along.
    pub heading: Vec3,
    pub throttle: f64,
    /// Stored drive heat (MJ), ships only.
    pub heat: f64,
    pub mode: AttitudeMode,
    /// Manual rotation input in [-1, 1] (counter-clockwise positive).
    pub rotate_input: f64,
    pub hp: f64,
    pub target: Option<u32>,
    pub missiles: u32,
    pub mines: u32,
    pub ai: u8,
    pub ai_timer: f64,
    /// Munitions: remaining delta-v, time since release, whether a mine woke up.
    pub dv_left: f64,
    pub age: f64,
    pub active: bool,
    pub owner: Option<u32>,
}

impl Entity {
    pub fn ship_class(&self) -> &'static ShipClass {
        &SHIP_CLASSES[self.class as usize]
    }

    pub fn munition(&self) -> Option<&'static MunitionSpec> {
        match self.kind {
            Kind::Ship => None,
            Kind::Missile => Some(&MISSILE),
            Kind::Mine => Some(&MINE),
        }
    }

    /// Current mass including fuel and carried munitions (ships only).
    pub fn mass(&self) -> f64 {
        match self.munition() {
            Some(m) => m.mass,
            None => {
                let c = self.ship_class();
                c.dry_mass + self.missiles as f64 * MISSILE.mass + self.mines as f64 * MINE.mass
            }
        }
    }

    /// Remaining motor delta-v for munitions; ships have an unlimited drive and report 0.
    pub fn delta_v(&self) -> f64 {
        match self.kind {
            Kind::Ship => 0.0,
            _ => self.dv_left,
        }
    }

    /// Fraction of full thrust the drive can deliver at its current heat.
    pub fn output_cap(&self) -> f64 {
        let c = self.ship_class();
        if self.kind != Kind::Ship || c.heat_capacity <= 0.0 {
            return 1.0;
        }
        let load = (self.heat / c.heat_capacity).clamp(0.0, 1.0);
        if load <= c.derate_start {
            1.0
        } else {
            1.0 - (1.0 - c.min_output) * (load - c.derate_start) / (1.0 - c.derate_start)
        }
    }

    /// Main engine acceleration at full throttle with the current mass.
    pub fn max_accel(&self) -> f64 {
        match self.munition() {
            Some(m) => m.accel,
            None => self.ship_class().thrust / self.mass(),
        }
    }

    pub fn is_armed(&self) -> bool {
        self.munition().is_some_and(|m| self.age >= m.arm_time)
    }
}
