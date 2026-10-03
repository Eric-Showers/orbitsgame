# Orbits

A browser game built on real orbital mechanics, with space combat between
vessels whose balance comes from their designed capabilities and weapons.

## Architecture

| Path                  | What it is                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| `crates/orbit-sim`    | Deterministic physics core (pure Rust, `f64`, `Vec3` everywhere).           |
| `crates/orbit-wasm`   | `wasm-bindgen` wrapper so the browser runs the exact same sim.             |
| `crates/orbit-server` | Authoritative multiplayer server (axum + websockets) using the same sim.   |
| `web/`                | TypeScript + Vite + Three.js client.                                        |

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

`npm run dev` shows the smoke test: a body on a circular orbit around a
central mass, integrated in Rust/WASM and drawn by Three.js. Rebuild the WASM
(`npm run wasm:dev`) after changing Rust code; Vite reloads automatically.
