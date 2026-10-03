//! Deterministic orbital simulation core.
//!
//! All state is 3D (`Vec3`) even though gameplay is currently confined to the
//! z = 0 plane. Only IEEE-754 exact operations (+, -, *, /, sqrt) are used in
//! the integrator so native (server) and wasm32 (client) builds produce
//! bit-identical results. Transcendentals must go through `libm`.

pub mod orbit;
pub mod planet;
pub mod vec3;
pub mod vessel;
pub mod world;

pub use orbit::{elements, Elements, OrbitSpec};
pub use planet::Planet;
pub use vec3::Vec3;
pub use vessel::{AttitudeMode, Entity, Kind};
pub use world::{Event, EventKind, World};
