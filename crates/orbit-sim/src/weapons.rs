//! Self-guided munitions: missiles and space mines.
//!
//! Both are small craft with their own motor and a fixed delta-v budget
//! (`vessel::MISSILE`, `vessel::MINE`). A missile is launched at a target and
//! guides at once. A mine is released onto its layer's orbit and coasts
//! dormant until an enemy ship comes inside its trigger range; then it spends
//! its much smaller budget to rendezvous and detonate. When the budget runs
//! out a munition coasts on whatever orbit it is on, so a target can outrun
//! one by out-spending it.
//!
//! Guidance holds a closing speed along the line of sight and nulls relative
//! velocity across it. At combat ranges (a few km) the gravity difference
//! between munition and target is ~1e-5 of g, so this needs no Lambert solve.
//!
//! The module works on a plain entity slice: `World::step` integrates ships,
//! then calls [`step`] once per tick with the same `dt`.

use crate::vessel::{AttitudeMode, Entity, Kind, MunitionSpec, MINE, MISSILE};
use crate::world::{Event, EventKind};
use crate::{Planet, Vec3};

/// Time constant (s) over which guidance tries to remove velocity error.
const GUIDANCE_TAU: f64 = 0.5;
/// Closing-speed errors below this (m/s) are not worth a burn.
const GUIDANCE_DEADBAND: f64 = 0.05;
/// Predicted misses under this fraction of the blast radius need no correction.
const ZEM_TOLERANCE: f64 = 0.25;

fn index_of(entities: &[Entity], id: u32) -> Option<usize> {
    entities.iter().position(|e| e.id == id)
}

fn is_enemy_ship(e: &Entity, team: u8) -> bool {
    e.alive && e.kind == Kind::Ship && e.team != team
}

fn new_munition(id: u32, kind: Kind, owner: &Entity, vel: Vec3, target: Option<u32>) -> Entity {
    let spec = if kind == Kind::Missile {
        &MISSILE
    } else {
        &MINE
    };
    Entity {
        id,
        kind,
        team: owner.team,
        class: 0,
        alive: true,
        pos: owner.pos,
        vel,
        heading: owner.heading,
        throttle: 0.0,
        heat: 0.0,
        mode: AttitudeMode::Hold,
        rotate_input: 0.0,
        hp: 1.0,
        target,
        missiles: 0,
        mines: 0,
        ai: 0,
        // Seconds spent active (powered flight); drives the lifetime limit.
        ai_timer: 0.0,
        main_dv_left: spec.delta_v,
        rcs_dv_left: spec.rcs_dv,
        charge: if spec.battery_j > 0.0 { 1.0 } else { 0.0 },
        age: 0.0,
        active: kind == Kind::Missile,
        owner: Some(owner.id),
    }
}

/// Fires one missile from `shooter` at `target`, using `id` for the new
/// entity. Returns false (and changes nothing) if the shooter is not a live
/// ship with missiles left or the target is not alive.
pub fn launch_missile(
    entities: &mut Vec<Entity>,
    shooter: u32,
    target: u32,
    id: u32,
    events: &mut Vec<Event>,
) -> bool {
    let (Some(si), Some(ti)) = (index_of(entities, shooter), index_of(entities, target)) else {
        return false;
    };
    let (s, t) = (&entities[si], &entities[ti]);
    if !s.alive || s.kind != Kind::Ship || s.missiles == 0 || !t.alive || si == ti {
        return false;
    }
    let dir = (t.pos - s.pos).normalize_or_zero();
    let mut m = new_munition(
        id,
        Kind::Missile,
        s,
        s.vel + dir * MISSILE.eject_speed,
        Some(target),
    );
    if dir != Vec3::ZERO {
        m.heading = dir;
    }
    entities[si].missiles -= 1;
    events.push(Event {
        kind: EventKind::MissileLaunched,
        id,
        pos: m.pos,
    });
    entities.push(m);
    true
}

/// Releases one mine from `layer` onto (very nearly) its current orbit.
/// Returns false if the layer is not a live ship with mines left.
pub fn drop_mine(entities: &mut Vec<Entity>, layer: u32, id: u32, events: &mut Vec<Event>) -> bool {
    let Some(li) = index_of(entities, layer) else {
        return false;
    };
    let l = &entities[li];
    if !l.alive || l.kind != Kind::Ship || l.mines == 0 {
        return false;
    }
    let out = l.pos.normalize_or_zero();
    // A radial kick gives a closed relative ellipse, so the mine stays near
    // the drop point instead of drifting along the orbit.
    let m = new_munition(id, Kind::Mine, l, l.vel + out * MINE.eject_speed, None);
    entities[li].mines -= 1;
    events.push(Event {
        kind: EventKind::MineDropped,
        id,
        pos: m.pos,
    });
    entities.push(m);
    true
}

/// Nearest live enemy ship to `pos` within `range`, by index.
fn nearest_enemy(entities: &[Entity], team: u8, pos: Vec3, range: f64) -> Option<usize> {
    let mut best = None;
    let mut best_d2 = range * range;
    for (i, e) in entities.iter().enumerate() {
        if is_enemy_ship(e, team) {
            let d2 = (e.pos - pos).length_squared();
            if d2 <= best_d2 {
                best_d2 = d2;
                best = Some(i);
            }
        }
    }
    best
}

/// Guidance acceleration toward `target` before motor limits.
///
/// Along the line of sight: speed up until closing at `spec.closing_speed`
/// (never brake; faster is fine). Across it: zero-effort-miss proportional
/// navigation, i.e. predict the miss if nobody burns from here and remove it
/// over the time to go. Misses already inside a fraction of the blast radius
/// are left alone so the motor does not chatter on the final approach.
fn guidance_accel(m: &Entity, spec: &MunitionSpec, target: &Entity) -> Vec3 {
    let rel_p = target.pos - m.pos;
    let rel_v = target.vel - m.vel;
    let los = rel_p.normalize_or_zero();
    let closing = -rel_v.dot(los);
    let mut accel = Vec3::ZERO;
    if spec.closing_speed - closing > GUIDANCE_DEADBAND {
        accel = los * ((spec.closing_speed - closing) / GUIDANCE_TAU);
    }
    let t_go = rel_p.length() / closing.max(spec.closing_speed);
    let zem = rel_p + rel_v * t_go;
    let zem_perp = zem - los * zem.dot(los);
    if zem_perp.length() > spec.blast_radius * ZEM_TOLERANCE {
        accel += zem_perp * (spec.nav_gain / (t_go * t_go));
    }
    accel
}

/// Decides who munition `i` is chasing this tick, waking or sleeping mines.
fn update_target(
    entities: &mut [Entity],
    i: usize,
    spec: &MunitionSpec,
    events: &mut Vec<Event>,
) -> Option<usize> {
    let m = &entities[i];
    let current = m
        .target
        .and_then(|t| index_of(entities, t))
        .filter(|&t| is_enemy_ship(&entities[t], m.team));
    match m.kind {
        Kind::Mine if !m.active => {
            if !m.is_armed() {
                return None;
            }
            let t = nearest_enemy(entities, m.team, m.pos, spec.trigger_range)?;
            let id = entities[t].id;
            let m = &mut entities[i];
            m.active = true;
            m.target = Some(id);
            events.push(Event {
                kind: EventKind::MineTriggered,
                id: m.id,
                pos: m.pos,
            });
            Some(t)
        }
        Kind::Mine => {
            let lose = spec.trigger_range * spec.lose_track;
            let t = current
                .filter(|&t| (entities[t].pos - m.pos).length() <= lose)
                .or_else(|| nearest_enemy(entities, m.team, m.pos, spec.trigger_range));
            let id = t.map(|t| entities[t].id);
            let m = &mut entities[i];
            m.target = id;
            if id.is_none() {
                // Lost the target: go back to sleep and keep the remaining budget.
                m.active = false;
                m.throttle = 0.0;
            }
            t
        }
        _ => {
            let t = current.or_else(|| nearest_enemy(entities, m.team, m.pos, f64::INFINITY));
            let id = t.map(|t| entities[t].id);
            entities[i].target = id;
            t
        }
    }
}

/// True when the planet hides the sun from `pos` (cylindrical shadow).
fn in_shadow(pos: Vec3, sun: Vec3, radius: f64) -> bool {
    let along = pos.dot(sun);
    along < 0.0 && (pos - sun * along).length() < radius
}

fn gravity(mu: f64, pos: Vec3) -> Vec3 {
    let r2 = pos.length_squared();
    pos * (-mu / (r2 * r2.sqrt()))
}

/// Turns the munition toward `want` on RCS, then burns the main motor along
/// its heading and covers any residual with RCS translation. Returns the
/// acceleration applied this tick.
fn fly(m: &mut Entity, spec: &MunitionSpec, want: Vec3, dt: f64) -> Vec3 {
    let dir = want.normalize_or_zero();
    let cos = m.heading.dot(dir).clamp(-1.0, 1.0);
    let angle = cos.acos();
    if dir != Vec3::ZERO && angle > 0.0 && m.rcs_dv_left > 0.0 {
        let turn = angle
            .min(spec.rcs_turn_rate * dt)
            .min(m.rcs_dv_left / spec.rcs_turn_cost);
        let perp = (dir - m.heading * cos).normalize_or_zero();
        m.heading = (m.heading * libm::cos(turn) + perp * libm::sin(turn)).normalize_or_zero();
        m.rcs_dv_left = (m.rcs_dv_left - turn * spec.rcs_turn_cost).max(0.0);
    }

    let battery_dv = if spec.battery_j > 0.0 {
        m.charge * spec.battery_j / spec.energy_per_dv
    } else {
        f64::INFINITY
    };
    let thrust = m
        .heading
        .dot(want)
        .max(0.0)
        .min(spec.accel)
        .min(m.main_dv_left / dt)
        .min(battery_dv / dt);
    let spent = thrust * dt;
    m.main_dv_left = (m.main_dv_left - spent).max(0.0);
    if spec.battery_j > 0.0 {
        m.charge = (m.charge - spent * spec.energy_per_dv / spec.battery_j).max(0.0);
    }
    m.throttle = thrust / spec.accel;
    let main = m.heading * thrust;

    let residual = want - main;
    let r = residual.length();
    let mut trans = Vec3::ZERO;
    if r > 0.0 && m.rcs_dv_left > 0.0 {
        let a = r.min(spec.rcs_accel).min(m.rcs_dv_left / dt);
        trans = residual * (a / r);
        m.rcs_dv_left = (m.rcs_dv_left - a * dt).max(0.0);
    }
    main + trans
}

/// Advances every live munition by `dt`: targeting, guidance burns, motion,
/// lifetime, then proximity fuses. Call after ships have been moved for the
/// same tick; fuses treat each ship as moving in a straight line over `dt`.
pub fn step(entities: &mut [Entity], planet: &Planet, sun: Vec3, dt: f64, events: &mut Vec<Event>) {
    let mut moved = Vec::new();
    for i in 0..entities.len() {
        let Some(spec) = entities[i].munition().filter(|_| entities[i].alive) else {
            continue;
        };
        let target = update_target(entities, i, spec, events);
        let m = &entities[i];
        let mut want = Vec3::ZERO;
        if let (true, Some(t)) = (m.active, target) {
            want = guidance_accel(m, spec, &entities[t]);
        }
        let m = &mut entities[i];
        if spec.solar_w > 0.0 && !in_shadow(m.pos, sun, planet.radius) {
            m.charge = (m.charge + spec.solar_w * dt / spec.battery_j).min(1.0);
        }
        let accel = fly(m, spec, want, dt);
        let start = m.pos;
        let v_half = m.vel + (gravity(planet.mu, m.pos) + accel) * (0.5 * dt);
        m.pos += v_half * dt;
        m.vel = v_half + (gravity(planet.mu, m.pos) + accel) * (0.5 * dt);
        m.age += dt;
        if m.active {
            m.ai_timer += dt;
        }

        if m.pos.length() < planet.radius {
            m.alive = false;
            events.push(Event {
                kind: EventKind::Crash,
                id: m.id,
                pos: m.pos,
            });
        } else if m.ai_timer >= spec.lifetime {
            m.alive = false;
            events.push(Event {
                kind: EventKind::Expired,
                id: m.id,
                pos: m.pos,
            });
        } else {
            moved.push((i, start));
        }
    }
    for (i, start) in moved {
        fuse(entities, i, start, dt, events);
    }
}

/// Fraction of the step in [0, 1] at which `d0 + u * t` is shortest, and that distance.
fn closest_approach(d0: Vec3, u: Vec3) -> (f64, f64) {
    let uu = u.length_squared();
    let t = if uu > 0.0 {
        (-d0.dot(u) / uu).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (t, (d0 + u * t).length())
}

/// Proximity fuse: detonates munition `i` if any enemy ship passed within its
/// blast radius during the step (swept, so fast munitions cannot tunnel).
/// The blast damages every ship inside the radius, friend or foe.
fn fuse(entities: &mut [Entity], i: usize, m0: Vec3, dt: f64, events: &mut Vec<Event>) {
    let m = &entities[i];
    if !m.alive || !m.active || !m.is_armed() {
        return;
    }
    let spec = m.munition().expect("fuse only runs on munitions");
    let m1 = m.pos;
    let mut hit: Option<f64> = None;
    for s in entities.iter().filter(|s| is_enemy_ship(s, m.team)) {
        let s0 = s.pos - s.vel * dt;
        let d0 = m0 - s0;
        let (t, d) = closest_approach(d0, (m1 - s.pos) - d0);
        if d <= spec.blast_radius && hit.is_none_or(|h| t < h) {
            hit = Some(t);
        }
    }
    let Some(t) = hit else {
        return;
    };
    let at = m0 + (m1 - m0) * t;
    let id = m.id;
    entities[i].alive = false;
    entities[i].throttle = 0.0;
    events.push(Event {
        kind: EventKind::Detonation,
        id,
        pos: at,
    });
    for s in entities.iter_mut() {
        if !s.alive || s.kind != Kind::Ship {
            continue;
        }
        let s_at = s.pos - s.vel * (dt * (1.0 - t));
        if (s_at - at).length() <= spec.blast_radius {
            s.hp -= spec.damage;
            if s.hp <= 0.0 {
                s.alive = false;
                s.throttle = 0.0;
                events.push(Event {
                    kind: EventKind::ShipDestroyed,
                    id: s.id,
                    pos: s.pos,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbit::OrbitSpec;
    use crate::vessel::{BEACON, CORVETTE, DRONE, GUNBOAT, SHIP_CLASSES};

    const PLANET: Planet = Planet::SCALED;
    const R: f64 = 680_000.0;
    const DT: f64 = 1.0 / 60.0;
    const SUN: Vec3 = Vec3::new(1.0, 0.0, 0.0);

    fn ship(id: u32, class: u8, team: u8, pos: Vec3, vel: Vec3) -> Entity {
        let c = &SHIP_CLASSES[class as usize];
        Entity {
            id,
            kind: Kind::Ship,
            team,
            class,
            alive: true,
            pos,
            vel,
            heading: vel.normalize_or_zero(),
            throttle: 0.0,
            heat: 0.0,
            mode: AttitudeMode::Hold,
            rotate_input: 0.0,
            hp: c.hp,
            target: None,
            missiles: c.missiles,
            mines: c.mines,
            ai: 0,
            ai_timer: 0.0,
            main_dv_left: 0.0,
            rcs_dv_left: 0.0,
            charge: 0.0,
            age: 0.0,
            active: false,
            owner: None,
        }
    }

    /// Ship on the circular orbit of radius `r`, `along` metres ahead of the +x axis.
    fn orbiting(id: u32, class: u8, team: u8, r: f64, along: f64) -> Entity {
        let (pos, vel) = OrbitSpec::circular(r, along / r).state(PLANET.mu);
        ship(id, class, team, pos, vel)
    }

    fn get(es: &[Entity], id: u32) -> &Entity {
        es.iter().find(|e| e.id == id).unwrap()
    }

    /// Coasts ships under gravity, then steps munitions, for `secs` seconds.
    fn run(es: &mut [Entity], secs: f64, events: &mut Vec<Event>) {
        for _ in 0..(secs / DT) as usize {
            for s in es.iter_mut().filter(|s| s.alive && s.kind == Kind::Ship) {
                let v_half = s.vel + gravity(PLANET.mu, s.pos) * (0.5 * DT);
                s.pos += v_half * DT;
                s.vel = v_half + gravity(PLANET.mu, s.pos) * (0.5 * DT);
            }
            step(es, &PLANET, SUN, DT, events);
        }
    }

    fn has(events: &[Event], kind: EventKind, id: u32) -> bool {
        events.iter().any(|e| e.kind == kind && e.id == id)
    }

    #[test]
    fn missile_destroys_target_ahead_on_same_orbit() {
        let mut es = vec![
            orbiting(1, CORVETTE, 0, R, 0.0),
            orbiting(2, DRONE, 1, R, 10_000.0),
        ];
        let mut ev = Vec::new();
        assert!(launch_missile(&mut es, 1, 2, 10, &mut ev));
        assert_eq!(get(&es, 1).missiles, 3);
        run(&mut es, 120.0, &mut ev);
        assert!(has(&ev, EventKind::Detonation, 10), "{ev:?}");
        assert!(has(&ev, EventKind::ShipDestroyed, 2));
        assert!(!get(&es, 2).alive);
        assert!(get(&es, 1).alive, "shooter must survive its own missile");
        let m = get(&es, 10);
        assert!(!m.alive && m.main_dv_left < MISSILE.delta_v && m.main_dv_left >= 0.0);
    }

    #[test]
    fn dormant_mine_coasts_near_its_drop_point() {
        let mut es = vec![orbiting(1, CORVETTE, 0, R, 0.0)];
        let mut ev = Vec::new();
        assert!(drop_mine(&mut es, 1, 10, &mut ev));
        assert_eq!(get(&es, 1).mines, 2);
        let mut max_sep: f64 = 0.0;
        for _ in 0..60 {
            run(&mut es, 10.0, &mut ev);
            max_sep = max_sep.max((get(&es, 10).pos - get(&es, 1).pos).length());
        }
        let m = get(&es, 10);
        assert!(m.alive && !m.active);
        assert_eq!(
            m.main_dv_left, MINE.delta_v,
            "a sleeping mine spends nothing"
        );
        // 1 m/s radial kick at n = 3.4e-3 rad/s: relative ellipse ~ 2v/n = 600 m.
        assert!(
            max_sep > 50.0 && max_sep < 1_500.0,
            "max separation {max_sep}"
        );
    }

    #[test]
    fn mine_wakes_and_kills_enemy_drifting_into_range() {
        // A drone 3 km lower drifts ahead at ~15 m/s and passes under the mine.
        let mut es = vec![
            orbiting(1, CORVETTE, 0, R, 0.0),
            orbiting(2, DRONE, 1, R - 3_000.0, -8_000.0),
        ];
        let mut ev = Vec::new();
        assert!(drop_mine(&mut es, 1, 10, &mut ev));
        run(&mut es, 900.0, &mut ev);
        assert!(has(&ev, EventKind::MineTriggered, 10), "{ev:?}");
        assert!(has(&ev, EventKind::ShipDestroyed, 2), "{ev:?}");
        assert!(get(&es, 1).alive);
    }

    #[test]
    fn mine_ignores_friendly_ships() {
        let mut es = vec![
            orbiting(1, CORVETTE, 0, R, 0.0),
            orbiting(2, DRONE, 0, R - 3_000.0, -8_000.0),
        ];
        let mut ev = Vec::new();
        drop_mine(&mut es, 1, 10, &mut ev);
        run(&mut es, 900.0, &mut ev);
        assert!(!has(&ev, EventKind::MineTriggered, 10));
        assert!(get(&es, 2).alive);
        assert_eq!(get(&es, 10).main_dv_left, MINE.delta_v);
    }

    #[test]
    fn fast_target_outruns_mine_budget() {
        let corvette = orbiting(1, CORVETTE, 0, R, 0.0);
        let v = corvette.vel;
        // Passes 3 km wide at 600 m/s: far more than the mine's 150 m/s can match.
        let enemy = ship(
            2,
            GUNBOAT,
            1,
            Vec3::new(R + 3_000.0, -8_000.0, 0.0),
            v + Vec3::new(0.0, 600.0, 0.0),
        );
        let mut es = vec![corvette, enemy];
        let mut ev = Vec::new();
        drop_mine(&mut es, 1, 10, &mut ev);
        run(&mut es, 60.0, &mut ev);
        assert!(has(&ev, EventKind::MineTriggered, 10));
        assert!(!has(&ev, EventKind::Detonation, 10));
        let g = get(&es, 2);
        assert!(g.alive && g.hp == SHIP_CLASSES[GUNBOAT as usize].hp);
        let m = get(&es, 10);
        assert!(m.main_dv_left >= 0.0 && m.main_dv_left < MINE.delta_v);
    }

    #[test]
    fn missile_runs_dry_against_receding_target_then_expires() {
        let mut es = vec![
            orbiting(1, CORVETTE, 0, R, 0.0),
            orbiting(2, DRONE, 1, R, 20_000.0),
        ];
        es[1].vel = es[1].vel + es[1].vel.normalize_or_zero() * 2_000.0;
        let mut ev = Vec::new();
        launch_missile(&mut es, 1, 2, 10, &mut ev);
        run(&mut es, MISSILE.lifetime + 1.0, &mut ev);
        assert!(get(&es, 2).alive);
        assert!(has(&ev, EventKind::Expired, 10));
        assert_eq!(get(&es, 10).main_dv_left, 0.0);
    }

    #[test]
    fn ammo_limits_and_bad_launches() {
        let mut es = vec![
            orbiting(1, CORVETTE, 0, R, 0.0),
            orbiting(2, DRONE, 1, R, 5_000.0),
        ];
        let mut ev = Vec::new();
        for id in 10..14 {
            assert!(launch_missile(&mut es, 1, 2, id, &mut ev));
        }
        assert!(
            !launch_missile(&mut es, 1, 2, 14, &mut ev),
            "corvette carries 4"
        );
        assert!(
            !launch_missile(&mut es, 2, 1, 15, &mut ev),
            "drone is unarmed"
        );
        assert!(!drop_mine(&mut es, 2, 16, &mut ev));
        assert!(!launch_missile(&mut es, 1, 1, 17, &mut ev) || get(&es, 1).missiles == 0);
        assert!(!launch_missile(&mut es, 1, 99, 18, &mut ev));
        assert_eq!(es.len(), 6);
    }

    #[test]
    fn blast_damages_friendly_ships_in_radius() {
        let drone = orbiting(2, DRONE, 1, R, 10_000.0);
        let mut wingman = ship(
            3,
            GUNBOAT,
            0,
            drone.pos + Vec3::new(15.0, 0.0, 0.0),
            drone.vel,
        );
        wingman.hp = 100.0;
        let mut es = vec![orbiting(1, CORVETTE, 0, R, 0.0), drone, wingman];
        let mut ev = Vec::new();
        launch_missile(&mut es, 1, 2, 10, &mut ev);
        run(&mut es, 120.0, &mut ev);
        assert!(!get(&es, 2).alive);
        assert_eq!(get(&es, 3).hp, 100.0 - MISSILE.damage);
    }

    #[test]
    fn munitions_are_deterministic() {
        let go = || {
            let mut es = vec![
                orbiting(1, CORVETTE, 0, R, 0.0),
                orbiting(2, DRONE, 1, R, 30_000.0),
            ];
            let mut ev = Vec::new();
            launch_missile(&mut es, 1, 2, 10, &mut ev);
            run(&mut es, 20.0, &mut ev);
            let m = get(&es, 10).clone();
            (
                m.pos.x.to_bits(),
                m.vel.y.to_bits(),
                m.main_dv_left.to_bits(),
            )
        };
        assert_eq!(go(), go());
    }

    #[test]
    fn mine_charges_in_sun_and_not_in_shadow() {
        let sunlit = Vec3::new(R + 1_000_000.0, 0.0, 0.0);
        let mut es = vec![orbiting(1, 3, 1, R + 40_000.0, 0.0)];
        assert!(drop_mine(&mut es, 1, 10, &mut Vec::new()));
        es.last_mut().unwrap().charge = 0.5;
        es.last_mut().unwrap().pos = sunlit.with_z(0.0);
        let mut ev = Vec::new();
        step(&mut es, &PLANET, SUN, DT, &mut ev);
        assert!(get(&es, 10).charge > 0.5);

        let shadowed = Vec3::new(-(R + 1_000_000.0), 0.0, 0.0);
        let mut es = vec![orbiting(1, 3, 1, R + 40_000.0, 0.0)];
        assert!(drop_mine(&mut es, 1, 10, &mut Vec::new()));
        es.last_mut().unwrap().charge = 0.5;
        es.last_mut().unwrap().pos = shadowed;
        step(&mut es, &PLANET, SUN, DT, &mut Vec::new());
        assert_eq!(get(&es, 10).charge, 0.5);
    }

    #[test]
    fn low_battery_limits_mine_thrust() {
        let mut e = ship(10, 3, 2, Vec3::ZERO, Vec3::ZERO);
        e.kind = Kind::Mine;
        e.active = true;
        e.heading = Vec3::new(1.0, 0.0, 0.0);
        e.main_dv_left = MINE.delta_v;
        e.rcs_dv_left = 0.0;
        e.charge = 0.0;
        let a_empty = fly(&mut e.clone(), &MINE, Vec3::new(1.0, 0.0, 0.0), DT).length();
        e.charge = 1.0;
        let a_full = fly(&mut e, &MINE, Vec3::new(1.0, 0.0, 0.0), DT).length();
        assert_eq!(a_empty, 0.0);
        assert!(a_full > 0.0 && a_full <= MINE.accel + 1e-9);
    }

    #[test]
    fn world_fires_at_target_and_flies_munitions_once() {
        use crate::World;
        let mut w = World::new(PLANET);
        let me = w.spawn_ship_in_orbit(CORVETTE, 0, OrbitSpec::circular(R, 0.0));
        let drone = w.spawn_ship_in_orbit(DRONE, 1, OrbitSpec::circular(R, 10_000.0 / R));
        assert_eq!(w.launch_missile(me), None, "no target selected");
        w.set_target(me, Some(drone));
        let missile = w.launch_missile(me).unwrap();
        let mine = w.drop_mine(me).unwrap();
        // A sleeping mine must coast exactly like a ship on the same orbit would.
        let (p0, v0) = (w.get(mine).unwrap().pos, w.get(mine).unwrap().vel);
        let mut probe = vec![ship(99, BEACON, 2, p0, v0)];
        for _ in 0..600 {
            w.step(DT);
            run(&mut probe, DT, &mut Vec::new());
        }
        assert_eq!(w.get(mine).unwrap().pos, probe[0].pos);
        for _ in 0..(120.0 / DT) as usize {
            w.step(DT);
        }
        let ev = w.take_events();
        assert!(has(&ev, EventKind::Detonation, missile), "{ev:?}");
        assert!(!w.get(drone).unwrap().alive);
        assert_eq!(w.get(me).unwrap().missiles, 3);
        assert_eq!(w.get(me).unwrap().mines, 2);
    }
}
