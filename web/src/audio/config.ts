import data from './sfx.json';

export type BusName = 'physical' | 'cockpit';
export type Wave = 'sine' | 'square' | 'sawtooth' | 'triangle' | 'noise';

export interface Layer {
  wave: Wave;
  /** Hz; ignored for noise. */
  freq?: number;
  /** Glide to this pitch (or filter frequency) over the layer. */
  freqEnd?: number;
  dur: number;
  gain: number;
  attack?: number;
  /** Seconds after the sound starts. */
  delay?: number;
  filter?: {
    type: 'lowpass' | 'highpass' | 'bandpass';
    freq: number;
    freqEnd?: number;
    q?: number;
  };
}

export interface SoundSpec {
  bus: BusName;
  layers: Layer[];
}

export interface LoopSpec {
  maxWarp: number;
  smoothing: number;
  gain: number;
  [key: string]: number;
}

export interface SfxConfig {
  buses: { master: number; physical: number; cockpit: number };
  distance: { refMeters: number; minGain: number };
  simEvents: Record<string, string>;
  advisory: {
    priorities: Record<string, string>;
    lines: Record<string, string>;
    ackPrefix: string;
    ackSound: string;
    ignorePrefixes: string[];
  };
  pilot: Record<string, string>;
  timer: {
    countdownSeconds: number;
    tickEverySeconds: number;
    urgentBelowSeconds: number;
    tick: string;
    urgentTick: string;
    maxWarp: number;
  };
  cooldown: Record<string, number>;
  loops: { engine: LoopSpec; rcs: LoopSpec };
  sounds: Record<string, SoundSpec>;
}

/** Every sound recipe, mix level, cooldown and trigger mapping, as data. */
export const SFX = data as SfxConfig;
