import { describe, expect, it } from 'vitest';
import type { AdvisoryEvent } from './advisor/channel';
import { SFX } from './audio/config';
import { SoundDirector, type FlightFrame } from './audio/director';
import type { SfxSink } from './audio/mixer';
import { SimEventKind } from './sim/bridge';

class Recorder implements SfxSink {
  plays: { id: string; gain: number }[] = [];
  loops: Record<string, number> = {};
  play(id: string, gain = 1): void {
    this.plays.push({ id, gain });
  }
  setLoop(name: 'engine' | 'rcs', level: number): void {
    this.loops[name] = level;
  }
  get ids(): string[] {
    return this.plays.map((p) => p.id);
  }
}

const frame = (over: Partial<FlightFrame> = {}): FlightFrame => ({
  dt: 1 / 60,
  simTime: 0,
  paused: false,
  alive: true,
  warp: 1,
  throttle: 0,
  heading: { x: 1, y: 0, z: 0 },
  pos: { x: 0, y: 0, z: 0 },
  pilotStatus: null,
  ...over,
});

const line = (id: string, priority: AdvisoryEvent['priority']): AdvisoryEvent => ({
  seq: 1,
  id,
  priority,
  rank: 0,
  text: '',
  vessel: 0,
  speaker: 'ARGUS',
  simTime: 0,
  timestamp: 0,
  duration: 1,
  interrupt: false,
});

function setup(): { rec: Recorder; dir: SoundDirector } {
  const rec = new Recorder();
  return { rec, dir: new SoundDirector(rec) };
}

describe('sound config', () => {
  it('every referenced sound has a recipe on a known bus', () => {
    const refs = [
      ...Object.values(SFX.simEvents),
      ...Object.values(SFX.advisory.priorities),
      ...Object.values(SFX.advisory.lines),
      SFX.advisory.ackSound,
      ...Object.values(SFX.pilot),
      SFX.timer.tick,
      SFX.timer.urgentTick,
    ];
    for (const id of refs) expect(SFX.sounds[id], id).toBeDefined();
    for (const s of Object.values(SFX.sounds)) expect(['physical', 'cockpit']).toContain(s.bus);
  });

  it('maps every sim event kind', () => {
    for (const name of Object.keys(SimEventKind).filter((k) => isNaN(Number(k))))
      expect(SFX.simEvents[name], name).toBeDefined();
  });
});

describe('shipboard sounds', () => {
  it('plays sim events and fades them with distance', () => {
    const { rec, dir } = setup();
    dir.onFrame(frame());
    dir.onSimEvents([
      { kind: SimEventKind.Detonation, id: 1, pos: { x: 100, y: 0, z: 0 } },
      { kind: SimEventKind.ShipDestroyed, id: 2, pos: { x: 200_000, y: 0, z: 0 } },
    ]);
    expect(rec.ids).toEqual(['detonation', 'ship.destroyed']);
    expect(rec.plays[0].gain).toBe(1);
    expect(rec.plays[1].gain).toBe(SFX.distance.minGain);
  });

  it('runs the engine loop with throttle and cuts it under high warp or pause', () => {
    const { rec, dir } = setup();
    dir.onFrame(frame({ throttle: 0.6 }));
    expect(rec.loops.engine).toBe(0.6);
    dir.onFrame(frame({ throttle: 0.6, warp: 50 }));
    expect(rec.loops.engine).toBe(0);
    dir.onFrame(frame({ throttle: 0.6, paused: true }));
    expect(rec.loops.engine).toBe(0);
    dir.onFrame(frame({ throttle: 0.6, alive: false }));
    expect(rec.loops.engine).toBe(0);
  });

  it('hisses thrusters only while the heading turns', () => {
    const { rec, dir } = setup();
    dir.onFrame(frame({ simTime: 0 }));
    dir.onFrame(frame({ simTime: 1 / 60 }));
    expect(rec.loops.rcs).toBe(0);
    const a = 0.3 / 60;
    dir.onFrame(frame({ simTime: 2 / 60, heading: { x: Math.cos(a), y: Math.sin(a), z: 0 } }));
    expect(rec.loops.rcs).toBeGreaterThan(0.5);
    dir.onFrame(frame({ simTime: 2 / 60, heading: { x: Math.cos(a), y: Math.sin(a), z: 0 } }));
    expect(rec.loops.rcs).toBe(0);
  });
});

describe('cockpit sounds', () => {
  it('raises alarms by priority, with per-line overrides', () => {
    const { rec, dir } = setup();
    dir.onAdvisory(line('fuel.low', 'warning'));
    dir.onAdvisory(line('threat.missile', 'critical'));
    dir.onAdvisory(line('advise.target_in_range', 'advise'));
    expect(rec.ids).toEqual(['alarm.warning', 'alarm.missile']);
  });

  it('blips for acknowledgements and flags refusals', () => {
    const { rec, dir } = setup();
    dir.onAdvisory(line('ack.prograde', 'ack'));
    dir.onFrame(frame({ dt: 1 }));
    dir.onAdvisory(line('ack.drop-mine.fail', 'ack'));
    expect(rec.ids).toEqual(['ack', 'ack.fail']);
  });

  it('leaves autopilot lines to the pilot events so nothing sounds twice', () => {
    const { rec, dir } = setup();
    dir.onAdvisory(line('ap.refused', 'warning'));
    dir.onAdvisory(line('status.lost', 'critical'));
    expect(rec.ids).toEqual([]);
  });

  it('rate-limits repeated alarms', () => {
    const { rec, dir } = setup();
    dir.onAdvisory(line('threat.mine_active', 'critical'));
    dir.onAdvisory(line('hazard.impact', 'critical'));
    dir.onFrame(frame({ dt: 0.5 }));
    dir.onAdvisory(line('fuel.out', 'critical'));
    expect(rec.ids).toEqual(['alarm.critical', 'alarm.impact']);
    dir.onFrame(frame({ dt: 3 }));
    dir.onAdvisory(line('fuel.out', 'critical'));
    expect(rec.ids).toEqual(['alarm.critical', 'alarm.impact', 'alarm.critical']);
  });

  it('confirms and aborts autopilot orders', () => {
    const { rec, dir } = setup();
    const maneuver = { kind: 'circularize', label: 'Circularize' } as never;
    dir.onPilot({ kind: 'started', maneuver });
    dir.onPilot({ kind: 'aborted', maneuver, cause: 'assist-off' });
    dir.onFrame(frame({ dt: 1 }));
    dir.onPilot({ kind: 'aborted', maneuver, cause: 'override' });
    dir.onPilot({ kind: 'phase', maneuver, phase: 'coast' });
    dir.onPilot({ kind: 'phase', maneuver, phase: 'burn' });
    dir.onPilot({ kind: 'done', maneuver });
    expect(rec.ids).toEqual(['ap.confirm', 'ap.abort', 'timer.go', 'ap.done']);
  });

  it('counts down the last seconds of a coast once per second', () => {
    const { rec, dir } = setup();
    const coast = (c: number, over: Partial<FlightFrame> = {}): void =>
      dir.onFrame(
        frame({
          dt: 0.1,
          pilotStatus: { state: 'running', phase: 'coast', progress: 0, note: '', coast: c },
          ...over,
        }),
      );
    coast(30);
    coast(10.4);
    coast(10.0);
    coast(9.6);
    expect(rec.ids).toEqual(['timer.tick']);
    coast(8.9);
    expect(rec.ids).toEqual(['timer.tick', 'timer.tick']);
    coast(2.5);
    expect(rec.ids.at(-1)).toBe('timer.tick.urgent');
    const n = rec.ids.length;
    coast(2.45);
    expect(rec.ids.length).toBe(n);
    coast(1.5, { warp: 10 });
    expect(rec.ids.length).toBe(n);
  });
});
