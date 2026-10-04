//! The simulated world: one planet plus every vessel, advanced in fixed steps.

use crate::orbit::{self, OrbitSpec};
use crate::vessel::{AttitudeMode, Entity, Kind, G0, SHIP_CLASSES};
use crate::{weapons, Planet, Vec3};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum EventKind {
    /// A vessel hit the planet surface.
    Crash = 0,
    /// A ship burned its last fuel.
    FuelOut = 1,
    MissileLaunched = 2,
    MineDropped = 3,
    /// A dormant mine detected an enemy and started its attack run.
    MineTriggered = 4,
    /// A munition's proximity fuse fired; `pos` is the blast centre.
    Detonation = 5,
    /// A ship was destroyed by a blast.
    ShipDestroyed = 6,
    /// A munition reached the end of its powered lifetime and self-destructed.
    Expired = 7,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub kind: EventKind,
    pub id: u32,
    pub pos: Vec3,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct World {
    pub planet: Planet,
    /// Keep gameplay in the z = 0 plane (out-of-plane modes are refused).
    pub planar: bool,
    pub entities: Vec<Entity>,
    pub time: f64,
    pub events: Vec<Event>,
    next_id: u32,
}

impl World {
    pub fn new(planet: Planet) -> Self {
        Self {
            planet,
            planar: true,
            entities: Vec::new(),
            time: 0.0,
            events: Vec::new(),
            next_id: 1,
        }
    }

    /// Spawns a ship of `class` (index into `SHIP_CLASSES`) with full tanks and
    /// its heading along prograde. Returns its id.
    pub fn spawn_ship(&mut self, class: u8, team: u8, pos: Vec3, vel: Vec3) -> u32 {
        let c = &SHIP_CLASSES[class as usize];
        let id = self.alloc_id();
        self.entities.push(Entity {
            id,
            kind: Kind::Ship,
            team,
            class,
            alive: true,
            pos,
            vel,
            heading: orbit::prograde(vel),
            throttle: 0.0,
            fuel: c.fuel_mass,
            mode: AttitudeMode::Hold,
            rotate_input: 0.0,
            hp: c.hp,
            target: None,
            missiles: c.missiles,
            mines: c.mines,
            ai: 0,
            ai_timer: 0.0,
            dv_left: 0.0,
            age: 0.0,
            active: false,
            owner: None,
        });
        id
    }

    pub fn spawn_ship_in_orbit(&mut self, class: u8, team: u8, orbit: OrbitSpec) -> u32 {
        let (pos, vel) = orbit.state(self.planet.mu);
        self.spawn_ship(class, team, pos, vel)
    }

    /// Overrides a ship's carried munitions and fuel (fraction of its class
    /// tank, clamped to [0, 1]). Used by missions to set the loadout.
    pub fn set_loadout(&mut self, id: u32, missiles: u32, mines: u32, fuel_fraction: f64) {
        if let Some(e) = self.get_mut(id).filter(|e| e.kind == Kind::Ship) {
            e.missiles = missiles;
            e.mines = mines;
            e.fuel = e.ship_class().fuel_mass * fuel_fraction.clamp(0.0, 1.0);
        }
    }

    pub fn get(&self, id: u32) -> Option<&Entity> {
        self.entities.iter().find(|e| e.id == id)
    }

    fn get_mut(&mut self, id: u32) -> Option<&mut Entity> {
        self.entities.iter_mut().find(|e| e.id == id)
    }

    pub fn set_throttle(&mut self, id: u32, throttle: f64) {
        if let Some(e) = self.get_mut(id) {
            e.throttle = throttle.clamp(0.0, 1.0);
        }
    }

    /// Selects an attitude hold mode. Returns false when the mode is not
    /// available (out of plane while planar, or needs a target the ship lacks).
    pub fn set_attitude(&mut self, id: u32, mode: AttitudeMode) -> bool {
        let planar = self.planar;
        let Some(e) = self.get_mut(id) else {
            return false;
        };
        if (planar && mode.is_out_of_plane()) || (mode.needs_target() && e.target.is_none()) {
            return false;
        }
        e.mode = mode;
        true
    }

    /// Manual rotation input in [-1, 1]. Any non-zero input drops to Hold mode.
    pub fn set_rotate(&mut self, id: u32, input: f64) {
        if let Some(e) = self.get_mut(id) {
            e.rotate_input = input.clamp(-1.0, 1.0);
            if e.rotate_input != 0.0 {
                e.mode = AttitudeMode::Hold;
            }
        }
    }

    pub fn set_target(&mut self, id: u32, target: Option<u32>) {
        if let Some(e) = self.get_mut(id) {
            e.target = target;
            if target.is_none() && e.mode.needs_target() {
                e.mode = AttitudeMode::Hold;
            }
        }
    }

    fn alloc_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Fires a missile from `shooter` at its current target. Returns the
    /// missile's id, or None without a live target or missiles left.
    pub fn launch_missile(&mut self, shooter: u32) -> Option<u32> {
        let target = self.get(shooter)?.target?;
        let id = self.alloc_id();
        weapons::launch_missile(&mut self.entities, shooter, target, id, &mut self.events)
            .then_some(id)
    }

    /// Drops a mine from `layer` onto its orbit. Returns the mine's id, or
    /// None if it has no mines left.
    pub fn drop_mine(&mut self, layer: u32) -> Option<u32> {
        let id = self.alloc_id();
        weapons::drop_mine(&mut self.entities, layer, id, &mut self.events).then_some(id)
    }

    pub fn take_events(&mut self) -> Vec<Event> {
        core::mem::take(&mut self.events)
    }

    /// Direction the attitude mode wants the ship to point, if any.
    fn desired_heading(&self, e: &Entity) -> Option<Vec3> {
        use AttitudeMode::*;
        let target = e.target.and_then(|t| self.get(t)).filter(|t| t.alive);
        let dir = match e.mode {
            Hold => return None,
            Prograde => orbit::prograde(e.vel),
            Retrograde => -orbit::prograde(e.vel),
            RadialOut => orbit::radial_out(e.pos),
            RadialIn => -orbit::radial_out(e.pos),
            Normal => orbit::normal(e.pos, e.vel),
            AntiNormal => -orbit::normal(e.pos, e.vel),
            Target => (target?.pos - e.pos).normalize_or_zero(),
            AntiTarget => (e.pos - target?.pos).normalize_or_zero(),
            TargetPrograde => (e.vel - target?.vel).normalize_or_zero(),
            TargetRetrograde => (target?.vel - e.vel).normalize_or_zero(),
        };
        let dir = if self.planar {
            dir.with_z(0.0).normalize_or_zero()
        } else {
            dir
        };
        (dir != Vec3::ZERO).then_some(dir)
    }

    /// Turns the heading toward the attitude mode's direction at the class slew rate.
    fn update_attitude(&mut self, i: usize, dt: f64) {
        let e = &self.entities[i];
        let max_turn = e.ship_class().slew_rate * dt;
        let heading = match self.desired_heading(e) {
            Some(want) => {
                let angle = e.heading.angle_to(want);
                if angle <= max_turn {
                    want
                } else {
                    let axis = e.heading.cross(want).normalize_or_zero();
                    let axis = if axis == Vec3::ZERO { Vec3::Z } else { axis };
                    e.heading.rotate_about(axis, max_turn).normalize_or_zero()
                }
            }
            None if e.rotate_input != 0.0 => e
                .heading
                .rotate_about(Vec3::Z, max_turn * e.rotate_input)
                .normalize_or_zero(),
            None => e.heading,
        };
        self.entities[i].heading = heading;
    }

    /// Engine acceleration this step; burns the fuel it uses.
    fn burn(&mut self, i: usize, dt: f64) -> Vec3 {
        let e = &mut self.entities[i];
        let c = e.ship_class();
        if e.throttle <= 0.0 || e.fuel <= 0.0 || c.thrust <= 0.0 {
            return Vec3::ZERO;
        }
        let mass = e.mass();
        let want_fuel = e.throttle * c.thrust / (c.isp * G0) * dt;
        let frac = (e.fuel / want_fuel).min(1.0);
        e.fuel -= want_fuel * frac;
        if e.fuel <= 0.0 {
            e.fuel = 0.0;
            self.events.push(Event {
                kind: EventKind::FuelOut,
                id: e.id,
                pos: e.pos,
            });
        }
        e.heading * (e.throttle * frac * c.thrust / mass)
    }

    fn gravity(&self, pos: Vec3) -> Vec3 {
        let r2 = pos.length_squared();
        pos * (-self.planet.mu / (r2 * r2.sqrt()))
    }

    /// Advances the world by `dt` seconds. Thrust is applied as a constant
    /// acceleration across a velocity Verlet step. Munitions fly themselves
    /// (see `weapons::step`) after the ships have moved.
    pub fn step(&mut self, dt: f64) {
        for i in 0..self.entities.len() {
            if !self.entities[i].alive || self.entities[i].kind != Kind::Ship {
                continue;
            }
            self.update_attitude(i, dt);
            let mut thrust = self.burn(i, dt);
            if self.planar {
                thrust = thrust.with_z(0.0);
            }
            let e = &self.entities[i];
            let v_half = e.vel + (self.gravity(e.pos) + thrust) * (0.5 * dt);
            let pos = e.pos + v_half * dt;
            let vel = v_half + (self.gravity(pos) + thrust) * (0.5 * dt);
            let e = &mut self.entities[i];
            e.pos = pos;
            e.vel = vel;
            if pos.length() < self.planet.radius {
                e.alive = false;
                e.throttle = 0.0;
                self.events.push(Event {
                    kind: EventKind::Crash,
                    id: e.id,
                    pos,
                });
            }
        }
        weapons::step(&mut self.entities, &self.planet, dt, &mut self.events);
        self.time += dt;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vessel::{BEACON, CORVETTE};
    use core::f64::consts::PI;

    const DT: f64 = 1.0 / 60.0;
    const LEO: f64 = 680_000.0;

    fn world_with_corvette() -> (World, u32) {
        let mut w = World::new(Planet::SCALED);
        let id = w.spawn_ship_in_orbit(CORVETTE, 0, OrbitSpec::circular(LEO, 0.0));
        (w, id)
    }

    #[test]
    fn coasting_ship_keeps_its_circular_orbit() {
        let (mut w, id) = world_with_corvette();
        let el = crate::elements(w.planet.mu, w.get(id).unwrap().pos, w.get(id).unwrap().vel);
        let steps = (el.period / DT) as usize;
        for _ in 0..steps {
            w.step(DT);
        }
        let s = w.get(id).unwrap();
        assert!(
            (s.pos.length() - LEO).abs() < 1.0,
            "radius drifted to {}",
            s.pos.length()
        );
        assert!(s.pos.z == 0.0);
    }

    #[test]
    fn prograde_burn_raises_apoapsis_and_matches_rocket_equation() {
        let (mut w, id) = world_with_corvette();
        let dv0 = w.get(id).unwrap().delta_v();
        let v0 = w.get(id).unwrap().vel.length();
        w.set_attitude(id, AttitudeMode::Prograde);
        w.set_throttle(id, 1.0);
        for _ in 0..(10.0 / DT) as usize {
            w.step(DT);
        }
        let s = w.get(id).unwrap();
        let spent = dv0 - s.delta_v();
        let el = crate::elements(w.planet.mu, s.pos, s.vel);
        assert!(el.apoapsis > LEO + 20_000.0, "apoapsis {}", el.apoapsis);
        // Over 10 s gravity barely changes speed in a circular orbit, so speed
        // gained should be close to the delta-v spent.
        let gained = s.vel.length() - v0;
        assert!(
            (gained - spent).abs() / spent < 0.02,
            "gained {gained} spent {spent}"
        );
    }

    #[test]
    fn burning_all_fuel_yields_class_delta_v_and_stops() {
        let (mut w, id) = world_with_corvette();
        let dv0 = w.get(id).unwrap().delta_v();
        assert!((1_400.0..1_600.0).contains(&dv0), "corvette dv {dv0}");
        w.set_attitude(id, AttitudeMode::Retrograde);
        w.set_throttle(id, 1.0);
        let mut fuel_out = false;
        for _ in 0..(300.0 / DT) as usize {
            w.step(DT);
            fuel_out |= w.take_events().iter().any(|e| e.kind == EventKind::FuelOut);
        }
        assert!(fuel_out);
        assert_eq!(w.get(id).unwrap().fuel, 0.0);
        assert_eq!(w.get(id).unwrap().delta_v(), 0.0);
    }

    #[test]
    fn attitude_slews_at_class_rate() {
        let (mut w, id) = world_with_corvette();
        w.set_attitude(id, AttitudeMode::Retrograde);
        w.step(1.0);
        let s = w.get(id).unwrap();
        let turned = orbit::prograde(s.vel).angle_to(s.heading);
        assert!(
            (turned - s.ship_class().slew_rate).abs() < 0.01,
            "turned {turned}"
        );
        for _ in 0..(PI / 0.5 / DT) as usize + 60 {
            w.step(DT);
        }
        let s = w.get(id).unwrap();
        // Lags one step of orbital rotation (~6e-5 rad).
        assert!(s.heading.angle_to(-s.vel) < 1e-4);
    }

    #[test]
    fn manual_rotation_drops_to_hold() {
        let (mut w, id) = world_with_corvette();
        w.set_attitude(id, AttitudeMode::Prograde);
        w.set_rotate(id, 1.0);
        assert_eq!(w.get(id).unwrap().mode, AttitudeMode::Hold);
        let h0 = w.get(id).unwrap().heading;
        w.step(1.0);
        let h1 = w.get(id).unwrap().heading;
        assert!(
            (h0.cross(h1).z - libm::sin(0.5)).abs() < 1e-9,
            "turned counter-clockwise"
        );
    }

    #[test]
    fn out_of_plane_and_targetless_modes_are_refused() {
        let (mut w, id) = world_with_corvette();
        assert!(!w.set_attitude(id, AttitudeMode::Normal));
        assert!(!w.set_attitude(id, AttitudeMode::TargetRetrograde));
        let beacon = w.spawn_ship_in_orbit(BEACON, 2, OrbitSpec::circular(LEO, 0.01));
        w.set_target(id, Some(beacon));
        assert!(w.set_attitude(id, AttitudeMode::Target));
        w.planar = false;
        assert!(w.set_attitude(id, AttitudeMode::Normal));
    }

    #[test]
    fn target_retrograde_burn_kills_relative_velocity() {
        let mut w = World::new(Planet::SCALED);
        let me = w.spawn_ship_in_orbit(CORVETTE, 0, OrbitSpec::circular(LEO, 0.0));
        let beacon = w.spawn_ship_in_orbit(BEACON, 2, OrbitSpec::circular(LEO, 0.0));
        w.entities[0].vel += Vec3::new(30.0, 0.0, 0.0);
        w.set_target(me, Some(beacon));
        w.set_attitude(me, AttitudeMode::TargetRetrograde);
        for _ in 0..(8.0 / DT) as usize {
            w.step(DT);
        }
        w.set_throttle(me, 0.5);
        for _ in 0..(20.0 / DT) as usize {
            let rel = w.get(me).unwrap().vel - w.get(beacon).unwrap().vel;
            if rel.length() < 0.5 {
                w.set_throttle(me, 0.0);
            }
            w.step(DT);
        }
        let rel = w.get(me).unwrap().vel - w.get(beacon).unwrap().vel;
        assert!(rel.length() < 1.0, "relative speed {}", rel.length());
    }

    #[test]
    fn deorbit_burn_crashes_into_planet() {
        let (mut w, id) = world_with_corvette();
        w.set_attitude(id, AttitudeMode::Retrograde);
        w.set_throttle(id, 1.0);
        let mut crashed = false;
        for _ in 0..(3_000.0 / DT) as usize {
            w.step(DT);
            crashed |= w.take_events().iter().any(|e| e.kind == EventKind::Crash);
            if crashed {
                break;
            }
        }
        assert!(crashed);
        assert!(!w.get(id).unwrap().alive);
    }

    #[test]
    fn loadout_override_sets_munitions_and_clamps_fuel() {
        let (mut w, id) = world_with_corvette();
        w.set_loadout(id, 1, 0, 0.5);
        let s = w.get(id).unwrap();
        assert_eq!((s.missiles, s.mines), (1, 0));
        assert_eq!(s.fuel, s.ship_class().fuel_mass * 0.5);
        w.set_loadout(id, 0, 0, 3.0);
        assert_eq!(
            w.get(id).unwrap().fuel,
            w.get(id).unwrap().ship_class().fuel_mass
        );
    }

    #[test]
    fn simulation_is_deterministic() {
        let run = || {
            let (mut w, id) = world_with_corvette();
            w.set_attitude(id, AttitudeMode::RadialOut);
            w.set_throttle(id, 0.7);
            for _ in 0..2_000 {
                w.step(DT);
            }
            w.get(id).unwrap().clone()
        };
        let (a, b) = (run(), run());
        assert_eq!(a.pos.x.to_bits(), b.pos.x.to_bits());
        assert_eq!(a.vel.y.to_bits(), b.vel.y.to_bits());
        assert_eq!(a.heading.x.to_bits(), b.heading.x.to_bits());
    }
}
