import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CameraRig } from './render/camera';
import { len } from './sim/bridge';
import { FlightSession } from './sim/session';
import { ACTIONS } from './ui/controls';
import { Game, initSync } from './wasm-pkg/orbit_wasm.js';

initSync({ module: readFileSync(new URL('./wasm-pkg/orbit_wasm_bg.wasm', import.meta.url)) });

describe('camera rig', () => {
  it('cycles ship, planet, then other ships, and wraps', () => {
    const s = new FlightSession(new Game());
    const rig = new CameraRig();
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      seen.push(rig.focus.kind);
      rig.cycle(s, 1);
    }
    expect(seen.slice(0, 2)).toEqual(['ship', 'planet']);
    expect(seen).toContain('entity');
    expect(seen.filter((k) => k === 'ship').length).toBeGreaterThan(1);
    rig.set({ kind: 'ship' });
    rig.cycle(s, -1);
    expect(rig.focus.kind).toBe('entity');
  });

  it('centres on the focus and follows it', () => {
    const s = new FlightSession(new Game());
    const rig = new CameraRig();
    expect(rig.center(s)).toMatchObject({ x: s.player().pos.x, y: s.player().pos.y });
    rig.set({ kind: 'planet' });
    expect(rig.center(s)).toMatchObject({ x: 0, y: 0 });
  });

  it('keeps a radial offset radial as the ship moves', () => {
    const s = new FlightSession(new Game());
    const rig = new CameraRig();
    const me = s.player().pos;
    const r = len(me);
    // Pan 'up' relative to the ship at the 3 o'clock position: radial = world +x.
    rig.panBy(s, 1000 * (me.x / r), 1000 * (me.y / r));
    const c = rig.center(s);
    expect(len(c) - r).toBeCloseTo(1000, 3);
    for (let t = 0; t < 600; t += 0.1) s.update(0.1);
    const now = s.player().pos;
    const c2 = rig.center(s);
    expect(len(c2) - len(now)).toBeCloseTo(1000, 3);
    rig.recentre(s);
    expect(rig.center(s)).toMatchObject({ x: now.x, y: now.y });
  });

  it('free camera detaches where it is and pans in world axes', () => {
    const s = new FlightSession(new Game());
    const rig = new CameraRig();
    rig.toggleFree(s);
    const start = rig.center(s);
    for (let t = 0; t < 300; t += 0.1) s.update(0.1);
    expect(rig.center(s)).toMatchObject({ x: start.x, y: start.y });
    rig.panBy(s, 500, -250);
    expect(rig.center(s).x).toBeCloseTo(start.x + 500, 6);
    expect(rig.center(s).y).toBeCloseTo(start.y - 250, 6);
    rig.toggleFree(s);
    expect(rig.focus.kind).toBe('ship');
  });

  it('falls back to the ship when the focused entity is gone', () => {
    const s = new FlightSession(new Game());
    const rig = new CameraRig();
    rig.set({ kind: 'entity', id: 99999 });
    expect(rig.center(s)).toMatchObject({ x: s.player().pos.x, y: s.player().pos.y });
  });
});

describe('control bindings', () => {
  it('never binds one key to two actions', () => {
    const seen = new Map<string, string>();
    for (const a of ACTIONS)
      for (const k of a.keys) {
        expect(seen.get(k), `${k}: ${a.id} vs ${seen.get(k)}`).toBeUndefined();
        seen.set(k, a.id);
      }
  });
});
