import { beforeEach, describe, expect, it } from 'vitest';
import { VesselAdvisor } from './advisor/advisor';
import { AdvisoryChannel, type AdvisoryEvent } from './advisor/channel';
import { VOICE } from './advisor/config';
import { findPersona, PERSONAS } from './advisor/personas';
import { pickVoice, TtsPlayer, type Synth } from './ui/tts';

const PLACEHOLDER = /\{(\w+)\}/g;
const placeholders = (texts: string[]): Set<string> =>
  new Set(texts.flatMap((t) => [...t.matchAll(PLACEHOLDER)].map((m) => m[1])));

const voice = (name: string, lang = 'en-GB'): SpeechSynthesisVoice =>
  ({ name, lang }) as SpeechSynthesisVoice;

function fakeSynth(voices: SpeechSynthesisVoice[] = []) {
  const spoken: SpeechSynthesisUtterance[] = [];
  const state = { cancels: 0 };
  const synth: Synth = {
    speak: (u) => spoken.push(u),
    cancel: () => state.cancels++,
    getVoices: () => voices,
  };
  return { synth, spoken, state };
}

const utter = (text: string) => ({ text }) as SpeechSynthesisUtterance;

function event(over: Partial<AdvisoryEvent> = {}): Omit<AdvisoryEvent, 'seq'> {
  return {
    id: 'x',
    priority: 'status',
    rank: 4,
    text: 'hello',
    vessel: 0,
    speaker: 'ARGUS',
    simTime: 0,
    timestamp: 0,
    duration: 1,
    interrupt: false,
    ...over,
  };
}

describe('personas', () => {
  it('have unique ids and distinct speech settings', () => {
    expect(new Set(PERSONAS.map((p) => p.id)).size).toBe(PERSONAS.length);
    expect(PERSONAS.length).toBeGreaterThan(2);
    const sigs = PERSONAS.map((p) => `${p.speech.rate}/${p.speech.pitch}`);
    expect(new Set(sigs).size).toBe(PERSONAS.length);
  });

  it('only reword real lines, keeping the cue placeholders', () => {
    for (const p of PERSONAS) {
      for (const [id, variants] of Object.entries(p.lines)) {
        const base = VOICE.lines[id];
        expect(base, `${p.id}: unknown line ${id}`).toBeDefined();
        const allowed = placeholders(base.text);
        allowed.add('callsign');
        for (const used of placeholders(variants)) {
          expect(allowed.has(used), `${p.id}.${id} uses {${used}}`).toBe(true);
        }
        // Every value the base line reports is still reported.
        for (const need of placeholders(base.text)) {
          if (need === 'callsign') continue;
          for (const v of variants) expect(v, `${p.id}.${id}`).toContain(`{${need}}`);
        }
      }
    }
  });

  it('give each non-default persona fuller prose than the shipped lines', () => {
    const words = (t: string) => t.split(/\s+/).length;
    for (const p of PERSONAS.filter((x) => Object.keys(x.lines).length > 0)) {
      const ids = Object.keys(p.lines);
      const mine = ids.reduce((n, id) => n + words(p.lines[id][0]), 0);
      const base = ids.reduce((n, id) => n + words(VOICE.lines[id].text[0]), 0);
      expect(mine, p.id).toBeGreaterThan(base);
    }
  });

  it('fall back to the default for an unknown id', () => {
    expect(findPersona('nope').id).toBe('argus');
  });
});

describe('advisor persona wording', () => {
  it('speaks the persona variant and keeps shipped lines where none exists', () => {
    const ch = new AdvisoryChannel();
    const heard: AdvisoryEvent[] = [];
    ch.subscribe((e) => heard.push(e));
    const adv = new VesselAdvisor(ch);
    const marshal = findPersona('marshal');
    adv.setPersona(marshal);
    const snap = {
      simTime: 0,
      self: { id: 0, alive: true, shipClass: 0, throttle: 0, hp: 100, target: null },
      entities: [],
    };
    adv.announce({ id: 'ap.assist.on' }, snap as never, 0);
    adv.announce({ id: 'ap.phase.burn' }, snap as never, 10);
    expect(heard[0].text).toBe(marshal.lines['ap.assist.on'][0]);
    adv.setPersona(findPersona('argus'));
    adv.announce({ id: 'ap.assist.off' }, snap as never, 20);
    expect(heard.at(-1)?.text).toBe(VOICE.lines['ap.assist.off'].text[0]);
  });
});

describe('TtsPlayer', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  });

  it('is silent until enabled, then speaks with the persona settings', () => {
    const ch = new AdvisoryChannel();
    const { synth, spoken } = fakeSynth();
    const tts = new TtsPlayer(ch, synth, utter);
    ch.publish(event());
    expect(spoken).toHaveLength(0);
    tts.setEnabled(true);
    tts.setPersona(findPersona('halcyon'));
    ch.publish(event({ text: 'hi there' }));
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe('hi there');
    expect(spoken[0].rate).toBe(findPersona('halcyon').speech.rate);
    expect(spoken[0].pitch).toBe(findPersona('halcyon').speech.pitch);
  });

  it('cancels on interrupt lines and when switched off', () => {
    const ch = new AdvisoryChannel();
    const { synth, state } = fakeSynth();
    const tts = new TtsPlayer(ch, synth, utter);
    tts.setEnabled(true);
    ch.publish(event({ interrupt: true }));
    expect(state.cancels).toBe(1);
    tts.setEnabled(false);
    expect(state.cancels).toBe(2);
  });

  it('remembers the toggle and persona across instances', () => {
    const first = new TtsPlayer(new AdvisoryChannel(), fakeSynth().synth, utter);
    first.setEnabled(true);
    first.setPersona(findPersona('quill'));
    const second = new TtsPlayer(new AdvisoryChannel(), fakeSynth().synth, utter);
    expect(second.enabled).toBe(true);
    expect(second.persona.id).toBe('quill');
  });

  it('stays off with no speech support', () => {
    const tts = new TtsPlayer(new AdvisoryChannel(), null, utter);
    tts.setEnabled(true);
    expect(tts.supported).toBe(false);
    expect(tts.enabled).toBe(false);
  });
});

describe('pickVoice', () => {
  it('prefers hinted names within the language, else any voice of that language, else default', () => {
    const marshal = findPersona('marshal');
    const voices = [
      voice('Samantha', 'en-US'),
      voice('Microsoft David', 'en-US'),
      voice('Amelie', 'fr-FR'),
    ];
    expect(pickVoice(voices, marshal)?.name).toBe('Microsoft David');
    expect(pickVoice([voice('Amelie', 'fr-FR'), voice('Kate', 'en-GB')], marshal)?.name).toBe(
      'Kate',
    );
    expect(pickVoice([], marshal)).toBeNull();
  });
});
