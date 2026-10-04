import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SFX } from './audio/config';
import { AudioMixer } from './audio/mixer';

/** Minimal AudioContext stand-in: accepts any graph call and records started sources. */
function fakeNode(started: string[]): unknown {
  const param = {
    value: 0,
    setValueAtTime: () => param,
    linearRampToValueAtTime: () => param,
    exponentialRampToValueAtTime: () => param,
    setTargetAtTime: () => param,
  };
  return {
    gain: param,
    frequency: param,
    Q: param,
    connect: (n: unknown) => n,
    start: () => started.push('start'),
    stop: () => {},
  };
}

class FakeContext {
  static started: string[] = [];
  state = 'running';
  currentTime = 0;
  sampleRate = 8000;
  destination = fakeNode([]);
  createGain = (): unknown => fakeNode([]);
  createOscillator = (): unknown => fakeNode(FakeContext.started);
  createBiquadFilter = (): unknown => fakeNode([]);
  createBufferSource = (): unknown => fakeNode(FakeContext.started);
  createBuffer = (_c: number, len: number): unknown => ({
    getChannelData: () => new Float32Array(len),
  });
  resume = (): Promise<void> => Promise.resolve();
}

const store = new Map<string, string>();
const listeners = new Map<string, () => void>();

beforeEach(() => {
  store.clear();
  listeners.clear();
  FakeContext.started = [];
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('window', {
    addEventListener: (ev: string, fn: () => void) => listeners.set(ev, fn),
    removeEventListener: (ev: string) => listeners.delete(ev),
  });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('AudioMixer', () => {
  it('builds every recipe and loop without error once unlocked', () => {
    const mixer = new AudioMixer();
    mixer.play('alarm.critical'); // before the first gesture: dropped, no throw
    expect(FakeContext.started).toEqual([]);
    listeners.get('keydown')!();
    expect(FakeContext.started.length).toBeGreaterThan(0);
    for (const id of Object.keys(SFX.sounds)) mixer.play(id, 0.5);
    mixer.setLoop('engine', 0.5);
    mixer.setLoop('rcs', 1);
  });

  it('remembers volume and mute per bus', () => {
    const a = new AudioMixer();
    expect(a.volume('cockpit')).toBe(SFX.buses.cockpit);
    a.setVolume('cockpit', 0.25);
    a.setMuted('physical', true);
    const b = new AudioMixer();
    expect(b.volume('cockpit')).toBe(0.25);
    expect(b.muted('physical')).toBe(true);
    expect(b.muted('cockpit')).toBe(false);
  });
});
