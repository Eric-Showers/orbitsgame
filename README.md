# Orbits

A browser game built on real orbital mechanics, with space combat between
vessels whose balance comes from their designed capabilities and weapons.

## Architecture

| Path                  | What it is                                                               |
| --------------------- | ------------------------------------------------------------------------ |
| `crates/orbit-sim`    | Deterministic physics core (pure Rust, `f64`, `Vec3` everywhere).        |
| `crates/orbit-wasm`   | `wasm-bindgen` wrapper so the browser runs the exact same sim.           |
| `crates/orbit-server` | Authoritative multiplayer server (axum + websockets) using the same sim. |
| `web/`                | TypeScript + Vite + Three.js client.                                     |

Design decisions:

- **Rust core compiled to WASM**, shared by client and server, so multiplayer
  can rely on identical simulation results.
- **3D-capable, planar for now.** All state is 3D; gameplay is held at z = 0
  and viewed through an orthographic top-down Three.js camera.
- **Hybrid orbits (planned).** Analytic Kepler propagation while coasting,
  symplectic integration under thrust or near encounters. The smoke test
  currently uses velocity Verlet only.
- **Determinism rules.** The sim uses only IEEE-exact float ops
  (`+ - * / sqrt`) and a fixed timestep. Transcendentals (`sin`, `cos`,
  `atan2`, ...) must come from the `libm` crate; `clippy.toml` bans the `std`
  versions.

## Prerequisites

- Rust stable (pinned via `rust-toolchain.toml`, includes the
  `wasm32-unknown-unknown` target, rustfmt and clippy)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/)
- Node 20+ and npm

## Commands

Rust (from the repo root):

```sh
cargo test --workspace                              # sim + server tests
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all
cargo run -p orbit-server                           # http://127.0.0.1:3000/health, ws://127.0.0.1:3000/ws
```

Web (from `web/`):

```sh
npm install
npm run dev          # builds the WASM (dev) then starts Vite at http://localhost:5173
npm test             # builds the WASM then runs Vitest against it
npm run build        # release WASM + typecheck + production bundle in web/dist
npm run lint
npm run format       # or format:check
npm run wasm         # rebuild only the WASM package (release)
```

`npm run dev` opens a free-flight sandbox: your corvette in an 80 km circular
orbit around a 600 km planet, with a navigation beacon 25 km ahead to
practise rendezvous on. Rebuild the WASM
(`npm run wasm:dev`) after changing Rust code; Vite reloads automatically.

## Flight controls

Every console button has a keyboard key (shown in its corner).

| Group    | Action                                               | Keys                       |
| -------- | ---------------------------------------------------- | -------------------------- |
| Attitude | Prograde / Retrograde                                | `1` / `2`                  |
|          | Radial out / Radial in                               | `3` / `4`                  |
|          | Normal / Anti-normal (locked while flight is planar) | `5` / `6`                  |
|          | Target / Anti-target                                 | `7` / `8`                  |
|          | Target prograde / Target retrograde                  | `9` / `0`                  |
|          | Hold heading                                         | `H`                        |
|          | Rotate left / right (hold)                           | `A` / `D`                  |
| Engine   | Throttle up / down (hold)                            | `Shift`/`W`, `Ctrl`/`S`    |
|          | Full throttle / Cut                                  | `Z` / `X`                  |
| Target   | Next target / Clear                                  | `T` or `Tab` / `Backspace` |
| Weapons  | Fire missile at target / Drop mine on your orbit     | `F` / `M`                  |
| Time     | Pause                                                | `P` or `Space`             |
|          | Time warp down / up (max 4x while burning)           | `,` / `.`                  |
|          | Reset flight                                         | `R`                        |
| Camera   | Zoom in / out (or mouse wheel)                       | `+` / `-`                  |
|          | Toggle focus ship / planet                           | `C`                        |

Attitude modes turn the ship at its slew rate; the engine pushes along the
ship's heading, so point first, then burn. Fuel use follows the rocket
equation, and the console shows remaining delta-v.
