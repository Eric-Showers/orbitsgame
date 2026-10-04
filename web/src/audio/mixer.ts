import { SFX, type BusName, type Layer, type SfxConfig } from './config';

/** What the director drives. The WebAudio mixer implements it; tests use a recorder. */
export interface SfxSink {
  play(id: string, gain?: number): void;
  /** Sets a continuous loop's level (0..1) and a pitch/brightness control (0..1). */
  setLoop(name: 'engine' | 'rcs', level: number, tone?: number): void;
}

export type AudioBus = BusName | 'master';

interface Settings {
  volume: Record<AudioBus, number>;
  muted: Record<AudioBus, boolean>;
}

const STORAGE_KEY = 'orbits.audio';
const BUSES: AudioBus[] = ['master', 'physical', 'cockpit'];

function defaults(cfg: SfxConfig): Settings {
  return {
    volume: { master: cfg.buses.master, physical: cfg.buses.physical, cockpit: cfg.buses.cockpit },
    muted: { master: false, physical: false, cockpit: false },
  };
}

function load(cfg: SfxConfig): Settings {
  const s = defaults(cfg);
  try {
    const raw = JSON.parse(
      globalThis.localStorage?.getItem(STORAGE_KEY) ?? 'null',
    ) as Partial<Settings> | null;
    for (const b of BUSES) {
      const v = raw?.volume?.[b];
      if (typeof v === 'number' && v >= 0 && v <= 1) s.volume[b] = v;
      if (typeof raw?.muted?.[b] === 'boolean') s.muted[b] = raw.muted[b];
    }
  } catch {
    // Corrupt or unavailable storage: fall back to the shipped mix.
  }
  return s;
}

/**
 * WebAudio synth and mixer. Two buses (`physical` shipboard sound, `cockpit`
 * instrument cues) feed a master gain; volume and mute per bus are remembered.
 * Browsers only allow audio after a gesture, so the context is built on the
 * first key press or click; sounds requested before that are dropped.
 */
export class AudioMixer implements SfxSink {
  private settings: Settings;
  private ctx: AudioContext | null = null;
  private gains = new Map<AudioBus, GainNode>();
  private noise: AudioBuffer | null = null;
  private loops = new Map<string, { gain: GainNode; tone: (v: number) => void }>();

  constructor(private cfg: SfxConfig = SFX) {
    this.settings = load(cfg);
    const unlock = (): void => {
      this.unlock();
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('pointerdown', unlock);
    };
    window.addEventListener('keydown', unlock);
    window.addEventListener('pointerdown', unlock);
  }

  volume(bus: AudioBus): number {
    return this.settings.volume[bus];
  }

  muted(bus: AudioBus): boolean {
    return this.settings.muted[bus];
  }

  setVolume(bus: AudioBus, v: number): void {
    this.settings.volume[bus] = Math.max(0, Math.min(1, v));
    this.apply(bus);
    this.save();
  }

  setMuted(bus: AudioBus, m: boolean): void {
    this.settings.muted[bus] = m;
    this.apply(bus);
    this.save();
  }

  private save(): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Private mode: the mix lasts for this page only.
    }
  }

  private apply(bus: AudioBus): void {
    const g = this.gains.get(bus);
    if (!g || !this.ctx) return;
    const v = this.settings.muted[bus] ? 0 : this.settings.volume[bus];
    g.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  private unlock(): void {
    if (this.ctx) return;
    const Ctor =
      globalThis.AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.connect(ctx.destination);
    this.gains.set('master', master);
    for (const b of ['physical', 'cockpit'] as const) {
      const g = ctx.createGain();
      g.connect(master);
      this.gains.set(b, g);
    }
    for (const b of BUSES) {
      this.gains.get(b)!.gain.value = this.settings.muted[b] ? 0 : this.settings.volume[b];
    }
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startLoops(ctx);
    void ctx.resume();
  }

  private noiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    return src;
  }

  private startLoops(ctx: AudioContext): void {
    const phys = this.gains.get('physical')!;
    const eng = this.cfg.loops.engine;
    const engGain = ctx.createGain();
    engGain.gain.value = 0;
    const rumble = ctx.createOscillator();
    rumble.type = 'sawtooth';
    rumble.frequency.value = eng.baseFreq;
    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = 'lowpass';
    rumbleLp.frequency.value = 220;
    const hiss = this.noiseSource(ctx);
    const hissLp = ctx.createBiquadFilter();
    hissLp.type = 'lowpass';
    hissLp.frequency.value = eng.noiseLowpass;
    rumble.connect(rumbleLp).connect(engGain);
    hiss.connect(hissLp).connect(engGain);
    engGain.connect(phys);
    rumble.start();
    hiss.start();
    this.loops.set('engine', {
      gain: engGain,
      tone: (v) => {
        rumble.frequency.setTargetAtTime(eng.baseFreq + eng.freqRange * v, ctx.currentTime, 0.1);
        hissLp.frequency.setTargetAtTime(
          eng.noiseLowpass + eng.noiseLowpassRange * v,
          ctx.currentTime,
          0.1,
        );
      },
    });

    const rcs = this.cfg.loops.rcs;
    const rcsGain = ctx.createGain();
    rcsGain.gain.value = 0;
    const puff = this.noiseSource(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rcs.bandpass;
    bp.Q.value = rcs.q;
    puff.connect(bp).connect(rcsGain).connect(phys);
    puff.start();
    this.loops.set('rcs', { gain: rcsGain, tone: () => {} });
  }

  setLoop(name: 'engine' | 'rcs', level: number, tone = level): void {
    const loop = this.loops.get(name);
    if (!loop || !this.ctx) return;
    const spec = this.cfg.loops[name];
    loop.gain.gain.setTargetAtTime(
      spec.gain * Math.max(0, Math.min(1, level)),
      this.ctx.currentTime,
      spec.smoothing,
    );
    loop.tone(Math.max(0, Math.min(1, tone)));
  }

  play(id: string, gain = 1): void {
    const ctx = this.ctx;
    const spec = this.cfg.sounds[id];
    if (!ctx || !spec || gain <= 0 || ctx.state !== 'running') return;
    const out = ctx.createGain();
    out.gain.value = gain;
    out.connect(this.gains.get(spec.bus)!);
    const t0 = ctx.currentTime;
    for (const layer of spec.layers) this.layer(ctx, out, layer, t0);
  }

  private layer(ctx: AudioContext, out: AudioNode, l: Layer, t0: number): void {
    const start = t0 + (l.delay ?? 0);
    const end = start + l.dur;
    const attack = Math.min(l.attack ?? 0.005, l.dur / 2);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(l.gain, start + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    let src: AudioScheduledSourceNode;
    if (l.wave === 'noise') {
      const n = this.noiseSource(ctx);
      n.loop = false;
      n.loopStart = 0;
      src = n;
    } else {
      const osc = ctx.createOscillator();
      osc.type = l.wave;
      osc.frequency.setValueAtTime(l.freq ?? 440, start);
      if (l.freqEnd) osc.frequency.exponentialRampToValueAtTime(l.freqEnd, end);
      src = osc;
    }
    let node: AudioNode = src;
    if (l.filter) {
      const f = ctx.createBiquadFilter();
      f.type = l.filter.type;
      f.Q.value = l.filter.q ?? 1;
      f.frequency.setValueAtTime(l.filter.freq, start);
      if (l.filter.freqEnd) f.frequency.exponentialRampToValueAtTime(l.filter.freqEnd, end);
      node.connect(f);
      node = f;
    }
    node.connect(env).connect(out);
    src.start(start);
    src.stop(end + 0.05);
  }
}
