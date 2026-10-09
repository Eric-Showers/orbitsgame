import { describe, expect, it } from 'vitest';
import { VesselAdvisor } from './advisor/advisor';
import { AdvisoryChannel, type AdvisoryEvent } from './advisor/channel';
import { fillTemplate, speakableVars, twoSig, VOICE, type VoiceConfig } from './advisor/config';
import { guidanceAfter } from './advisor/guidance';
import { findPersona, PERSONAS } from './advisor/personas';
import { SpeechQueue, type PendingLine } from './advisor/queue';
import {
  currentReadings,
  evaluateConditions,
  evaluateManeuvers,
  evaluateStatus,
  evaluateCues,
  timeToRadius,
  type VesselSnapshot,
} from './advisor/triggers';
import {
  Attitude,
  BEACON,
  CORVETTE,
  DRONE,
  EntityKind,
  SimEventKind,
  type EntityView,
  type OrbitView,
} from './sim/bridge';
import { ACTIONS } from './ui/controls';

const R = 600_000;
const T = VOICE.thresholds;

function ship(over: Partial<EntityView> = {}): EntityView {
  return {
    id: 0,
    kind: EntityKind.Ship,
    team: 0,
    shipClass: CORVETTE,
    alive: true,
    pos: { x: R + 80_000, y: 0, z: 0 },
    vel: { x: 0, y: 2_100, z: 0 },
    heading: { x: 0, y: 1, z: 0 },
    throttle: 0,
    heat: 0,
    heatCapacity: 1000,
    outputCap: 1,
    deltaV: 0,
    mode: Attitude.Hold,
    target: null,
    hp: 100,
    mass: 10_000,
    maxAccel: 10,
    ...over,
  };
}

/** Entity `along` metres ahead of `self` on +y. */
function near(self: EntityView, along: number, over: Partial<EntityView>): EntityView {
  return ship({ ...over, pos: { ...self.pos, y: self.pos.y + along } });
}

const circular: OrbitView = {
  semiMajorAxis: R + 80_000,
  eccentricity: 0,
  semiLatusRectum: R + 80_000,
  periapsis: R + 80_000,
  apoapsis: R + 80_000,
  period: 3000,
  argPeriapsis: 0,
  trueAnomaly: 0,
};

function snap(over: Partial<VesselSnapshot> = {}): VesselSnapshot {
  const self = over.self ?? ship();
  return {
    simTime: 0,
    planetRadius: R,
    self,
    orbit: circular,
    entities: [self],
    events: [],
    ...over,
  };
}

const on = (s: VesselSnapshot): string[] =>
  evaluateConditions(s, T)
    .filter((c) => c.on)
    .map((c) => c.id);

/** Ellipse with periapsis `pe` and apoapsis `ap` (radii), at true anomaly `nu`. */
function ellipse(pe: number, ap: number, nu: number): OrbitView {
  const a = (pe + ap) / 2;
  const e = (ap - pe) / (ap + pe);
  const mu = 3.5316e12;
  return {
    semiMajorAxis: a,
    eccentricity: e,
    semiLatusRectum: a * (1 - e * e),
    periapsis: pe,
    apoapsis: ap,
    period: 2 * Math.PI * Math.sqrt((a * a * a) / mu),
    argPeriapsis: 0,
    trueAnomaly: nu,
  };
}

describe('vessel AI conditions', () => {
  it('is quiet in a healthy circular orbit', () => {
    expect(on(snap())).toEqual([]);
  });

  it('alarms only at the drive heat limit (lower heat is status)', () => {
    expect(on(snap({ self: ship({ heat: 600 }) }))).toEqual([]);
    expect(on(snap({ self: ship({ heat: 900, outputCap: 0.5 }) }))).toEqual(['heat.limit']);
    expect(on(snap({ self: ship({ heat: 100 }) }))).toEqual([]); // heat.derate is a one-shot cue
  });

  it('flags a low periapsis, and an impact trajectory with time to impact', () => {
    expect(on(snap({ orbit: ellipse(R + 8_000, R + 80_000, Math.PI) }))).toEqual([
      'hazard.low_periapsis',
    ]);
    const impact = evaluateConditions(snap({ orbit: ellipse(R - 50_000, R + 80_000, 3) }), T);
    const hit = impact.find((c) => c.id === 'hazard.impact')!;
    expect(hit.on).toBe(true);
    expect(hit.vars?.t).toMatch(/minutes?/);
    // Just before ground contact it becomes the imminent warning.
    const late = on(snap({ orbit: ellipse(R - 50_000, R + 80_000, -1.6) }));
    expect(late).toContain('hazard.impact_imminent');
    expect(late).not.toContain('hazard.impact');
  });

  it('only calls missiles that are hostile and homing on us', () => {
    const me = ship();
    const msl = (team: number, target: number | null): EntityView =>
      near(me, 5_000, {
        id: 9,
        kind: EntityKind.Missile,
        team,
        target,
        vel: { x: 0, y: 1_900, z: 0 },
      });
    expect(on(snap({ self: me, entities: [me, msl(1, 0)] }))).toEqual(['threat.missile']);
    expect(on(snap({ self: me, entities: [me, msl(0, 0)] }))).toEqual([]);
    expect(on(snap({ self: me, entities: [me, msl(1, 42)] }))).toEqual([]);
    const c = evaluateConditions(snap({ self: me, entities: [me, msl(1, 0)] }), T);
    expect(c.find((x) => x.id === 'threat.missile')!.vars?.t).toBe('25 seconds');
  });

  it('warns of nearby dormant hostile mines but not our own', () => {
    const me = ship();
    const mine = (team: number): EntityView =>
      near(me, 4_000, { id: 7, kind: EntityKind.Mine, team, target: null });
    expect(on(snap({ self: me, entities: [me, mine(1)] }))).toEqual(['threat.mine_near']);
    expect(on(snap({ self: me, entities: [me, mine(0)] }))).toEqual([]);
    const awake = near(me, 4_000, { id: 7, kind: EntityKind.Mine, team: 1, target: 0 });
    expect(on(snap({ self: me, entities: [me, awake] }))).toEqual(['threat.mine_active']);
  });

  it('advises on the designated hostile target only', () => {
    const drone = ship({ id: 3, team: 1, shipClass: DRONE });
    const beacon = ship({ id: 4, team: 2, shipClass: BEACON });
    const me = ship({ target: 3 });
    const d = near(me, 10_000, drone);
    expect(on(snap({ self: me, entities: [me, d] }))).toEqual(['advise.target_in_range']);
    const fast = near(me, 10_000, { ...drone, vel: { x: 0, y: 2_000, z: 0 } });
    expect(on(snap({ self: me, entities: [me, fast] }))).toEqual([
      'advise.target_in_range',
      'advise.match_velocity',
    ]);
    const meB = ship({ target: 4 });
    expect(on(snap({ self: meB, entities: [meB, near(meB, 10_000, beacon)] }))).toEqual([]);
    // An undesignated hostile in range is not the AI's call to raise.
    expect(on(snap({ entities: [ship(), d] }))).toEqual([]);
  });
});

describe('vessel AI cues', () => {
  it('reports splash, our own loss, drive derating and hull damage', () => {
    const me = ship({ hp: 60 });
    const drone = ship({ id: 3, team: 1, shipClass: DRONE, alive: false });
    const ev = (kind: SimEventKind, id: number) => ({ kind, id, pos: me.pos });
    const s = snap({
      self: me,
      entities: [me, drone],
      events: [ev(SimEventKind.ShipDestroyed, 3), ev(SimEventKind.Overheat, 0)],
    });
    const cues = evaluateCues(s, snap(), T, { hullMax: 100 });
    expect(cues.map((c) => c.id)).toEqual(['status.splash', 'heat.derate', 'damage.hull']);
    expect(cues[0].vars?.target).toBe('Drone 3');
    expect(cues[2].vars?.hp).toBe('60%');
  });

  it('calls out a contact burning toward us once it has spent real delta-v', () => {
    const me = ship({ target: 3 });
    const tracks = new Map();
    // Drone 10 km ahead (+y), nose pointing back at us, engine lit.
    const burning = (time: number): VesselSnapshot => {
      const d = near(me, 10_000, {
        id: 3,
        team: 1,
        shipClass: DRONE,
        throttle: 1,
        maxAccel: 5,
        heading: { x: 0, y: -1, z: 0 },
      });
      return snap({ self: me, entities: [me, d], simTime: time });
    };
    let prev = burning(0);
    const heard: string[] = [];
    for (let t = 1; t <= 6; t++) {
      const s = burning(t);
      heard.push(...evaluateManeuvers(s, prev, tracks, T).map((c) => c.id));
      prev = s;
    }
    expect(heard).toEqual(['event.maneuver.toward']); // 15 m/s spent after 3 s, called once
  });

  it('ignores burns by unwatched friendly ships', () => {
    const me = ship();
    const friend = near(me, 5_000, { id: 4, team: 0, throttle: 1, maxAccel: 50 });
    const a = snap({ self: me, entities: [me, friend], simTime: 0 });
    const b = snap({ self: me, entities: [me, friend], simTime: 10 });
    expect(evaluateManeuvers(b, a, new Map(), T)).toEqual([]);
  });
});

describe('status reports', () => {
  const L = VOICE.lull;

  it('reports only what changed since the last report', () => {
    const base = snap();
    const last = currentReadings(base);
    expect(evaluateStatus(base, last, L).cues).toEqual([]);
    const raised = snap({ orbit: ellipse(R + 80_000, R + 120_000, 0) });
    const { cues, reported } = evaluateStatus(raised, last, L);
    expect(cues.map((c) => c.id)).toEqual(['status.orbit']);
    expect(cues[0].vars).toEqual({ pe: '80.0 km', ap: '120.0 km' });
    expect(evaluateStatus(raised, reported, L).cues).toEqual([]);
  });

  it('reports drive heat, then that it has cooled', () => {
    const last = currentReadings(snap());
    const hot = evaluateStatus(snap({ self: ship({ heat: 500 }) }), last, L);
    expect(hot.cues).toEqual([{ id: 'status.heat', vars: { pct: '50%' } }]);
    const cool = evaluateStatus(snap(), hot.reported, L);
    expect(cool.cues.map((c) => c.id)).toEqual(['status.heat_nominal']);
  });
});

describe('time to radius', () => {
  it('is half a period from apoapsis down to periapsis', () => {
    const o = ellipse(R + 10_000, R + 90_000, Math.PI);
    expect(timeToRadius(o, o.periapsis, 3.5316e12)).toBeCloseTo(o.period / 2, 3);
  });

  it('is null when the orbit never reaches the radius', () => {
    expect(timeToRadius(ellipse(R + 10_000, R + 90_000, 1), R, 3.5316e12)).toBeNull();
  });
});

function line(
  id: string,
  priority: PendingLine['priority'],
  category: PendingLine['category'] = 'event',
): PendingLine {
  return {
    id,
    priority,
    category,
    rank: VOICE.priorities[priority].rank,
    text: `${id} two three`,
    vessel: 0,
    speaker: 'ARGUS',
    simTime: 0,
  };
}

describe('speech queue', () => {
  it('speaks the most urgent line first and one at a time', () => {
    const q = new SpeechQueue(VOICE);
    q.push(line('a', 'status'), 0);
    q.push(line('b', 'warning'), 0);
    expect(q.next(0)?.id).toBe('b');
    expect(q.next(0.5)).toBeNull(); // still speaking
    expect(q.next(2)?.id).toBe('a');
  });

  it('lets critical lines interrupt, drops stale lines and replaces duplicates', () => {
    const q = new SpeechQueue(VOICE);
    q.push(line('s', 'status', 'status'), 0);
    q.next(0);
    q.push(line('c', 'critical', 'alarm'), 0.1);
    const c = q.next(0.1)!;
    expect(c.id).toBe('c');
    expect(c.interrupt).toBe(true);
    q.push(line('ack', 'ack'), 0);
    expect(q.next(10)).toBeNull(); // ack TTL is short
    q.push(line('w', 'warning'), 20);
    q.push(line('w', 'warning'), 20.5);
    expect(q.size).toBe(1);
  });

  it('caps the queue by dropping the least urgent', () => {
    const cfg: VoiceConfig = { ...VOICE, speech: { ...VOICE.speech, maxQueue: 2 } };
    const q = new SpeechQueue(cfg);
    q.push(line('s', 'status'), 0);
    q.push(line('w', 'warning'), 0);
    q.push(line('c', 'critical'), 0);
    expect(q.size).toBe(2);
    expect(q.next(0)?.id).toBe('c');
    expect(q.next(5)?.id).toBe('w');
  });
});

describe('vessel advisor', () => {
  function rig(): { ai: VesselAdvisor; heard: AdvisoryEvent[] } {
    const channel = new AdvisoryChannel();
    const heard: AdvisoryEvent[] = [];
    channel.subscribe((e) => heard.push(e));
    return { ai: new VesselAdvisor(channel), heard };
  }

  it('greets, then warns once per crossing with hysteresis and cooldown', () => {
    const { ai, heard } = rig();
    let t = 0;
    const feed = (heat: number): void =>
      ai.observe(snap({ self: ship({ heat, throttle: 1 }), simTime: t }), (t += 5));
    feed(0);
    feed(850);
    feed(860);
    feed(780); // inside hysteresis: still latched
    feed(850);
    expect(heard.map((e) => e.id)).toEqual(['status.online', 'heat.limit']);
    feed(500); // clears
    feed(850); // re-arms, but the cooldown has not run out
    expect(heard.filter((e) => e.id === 'heat.limit')).toHaveLength(1);
    t += 100;
    feed(500);
    feed(850);
    expect(heard.filter((e) => e.id === 'heat.limit')).toHaveLength(2);
    const ev = heard[1];
    expect(ev).toMatchObject({
      priority: 'warning',
      category: 'alarm',
      vessel: 0,
      speaker: 'ARGUS',
    });
    expect(ev.text).toContain('85%');
  });

  it('repeats an inbound-missile call while the threat lasts', () => {
    const { ai, heard } = rig();
    const me = ship();
    const msl = near(me, 5_000, { id: 9, kind: EntityKind.Missile, team: 1, target: 0 });
    for (let t = 0; t <= 20; t += 1) ai.observe(snap({ self: me, entities: [me, msl] }), t);
    expect(heard.filter((e) => e.id === 'threat.missile').length).toBe(3); // t = 0, 8, 16
  });

  it('acknowledges orders, including refusals', () => {
    const { ai, heard } = rig();
    const s = snap();
    ai.observe(s, 0);
    ai.acknowledge({ id: 'fire-missile', ok: false }, s, 10);
    ai.acknowledge({ id: 'drop-mine', ok: false }, s, 20);
    // Engine and heading orders are not called out.
    ai.acknowledge({ id: 'prograde', ok: true }, s, 30);
    ai.acknowledge({ id: 'throttle-full', ok: true }, s, 31);
    ai.acknowledge({ id: 'target', ok: false }, s, 32);
    ai.acknowledge({ id: 'warp-up', ok: true }, s, 40);
    expect(heard.map((e) => e.id)).toEqual([
      'status.online',
      'ack.fire-missile.no_target',
      'ack.drop-mine.fail',
    ]);
  });

  it('only reads the sim (frozen snapshots are fine)', () => {
    const { ai } = rig();
    const deep = <T>(o: T): T => {
      Object.values(o as object).forEach((v) => v && typeof v === 'object' && deep(v));
      return Object.freeze(o);
    };
    const me = ship({ heat: 50, target: 3 });
    const s = deep(snap({ self: me, entities: [me, near(me, 9_000, { id: 3, team: 1 })] }));
    expect(() => ai.observe(s, 0)).not.toThrow();
  });
});

describe('voice data', () => {
  it('has text, a known priority and only valid timings for every line', () => {
    for (const [id, spec] of Object.entries(VOICE.lines)) {
      expect(spec.text.length + (spec.variants?.length ?? 0), id).toBeGreaterThan(0);
      expect(VOICE.priorities[spec.priority], id).toBeDefined();
      expect(spec.cooldown ?? 0, id).toBeGreaterThanOrEqual(0);
    }
  });

  it('has a line for every condition and cue the triggers can raise', () => {
    const ids = evaluateConditions(
      snap({ self: ship({ target: 3 }), entities: [ship({ id: 3, team: 1 })] }),
      T,
    ).map((c) => c.id);
    for (const id of [
      ...ids,
      'heat.derate',
      'status.lost',
      'status.splash',
      'status.orbit',
      'damage.hull',
    ])
      expect(VOICE.lines[id], id).toBeDefined();
  });

  it('acknowledges only real control actions', () => {
    const actionIds = new Set(ACTIONS.map((a) => a.id));
    for (const id of Object.keys(VOICE.lines).filter((k) => k.startsWith('ack.'))) {
      const action = id.slice(4).split('.')[0];
      if (action !== 'attitude') expect(actionIds.has(action), id).toBe(true);
    }
  });

  it('fills placeholders and leaves unknown ones', () => {
    expect(fillTemplate('{a} and {b}', { a: 'x' })).toBe('x and {b}');
  });
});

describe('speech queue pruning', () => {
  const topical = (
    id: string,
    priority: PendingLine['priority'],
    extra: Partial<PendingLine>,
  ): PendingLine => ({ ...line(id, priority), ...extra });

  it('replaces older lines of the same topic', () => {
    const q = new SpeechQueue(VOICE);
    q.push(topical('ack.prograde', 'ack', { topic: 'ack' }), 0);
    q.push(topical('ack.retrograde', 'ack', { topic: 'ack' }), 0.1);
    expect(q.size).toBe(1);
    expect(q.next(0.1)?.id).toBe('ack.retrograde');
  });

  it('lets a result wipe stale progress and a new order wipe stale guidance', () => {
    const q = new SpeechQueue(VOICE);
    q.push(topical('ap.phase.burn', 'order', { topic: 'ap.progress' }), 0);
    q.push(topical('guide.old', 'guide', { topic: 'guide' }), 0);
    q.push(topical('ap.done', 'order', { topic: 'ap.result', drops: ['ap.progress'] }), 1);
    expect(q.size).toBe(2);
    q.push(topical('ap.start', 'order', { topic: 'ap.progress', drops: ['guide'] }), 2);
    expect(q.size).toBe(2);
    expect(q.next(2)?.id).toBe('ap.done');
    expect(q.next(5)?.id).toBe('ap.start');
  });

  it('honours a per-line ttl', () => {
    const q = new SpeechQueue(VOICE);
    q.push(topical('p', 'order', { ttl: 3 }), 0);
    expect(q.next(4)).toBeNull();
  });

  it('sheds the oldest status lines when the backlog runs long, never alerts', () => {
    const cfg: VoiceConfig = { ...VOICE, speech: { ...VOICE.speech, maxBacklogSeconds: 3 } };
    const q = new SpeechQueue(cfg);
    q.push({ ...line('w', 'warning'), text: 'a b c d e f g h i j k l m n o p' }, 0);
    for (let i = 0; i < 6; i++) q.push({ ...line(`s${i}`, 'status'), text: 'a b c d e f g h' }, 0);
    expect(q.size).toBeLessThanOrEqual(3);
    const ids: string[] = [];
    for (let t = 0; t < 40; t += 3) {
      const ev = q.next(t);
      if (ev) ids.push(ev.id);
    }
    expect(ids[0]).toBe('w');
    expect(ids).toContain('s5'); // newest survives
    expect(ids).not.toContain('s0');
  });

  it('does not let several quick maneuvers pile up progress lines', () => {
    const channel = new AdvisoryChannel();
    const heard: AdvisoryEvent[] = [];
    channel.subscribe((e) => heard.push(e));
    const ai = new VesselAdvisor(channel);
    const s = snap();
    ai.observe(s, 0);
    ai.flush(30);
    heard.length = 0;
    for (const id of ['ap.start', 'ap.phase.coast', 'ap.phase.burn', 'ap.done.circularize']) {
      ai.announce({ id, vars: { label: 'x', pe: '1 km', ap: '2 km' } }, s, 100);
    }
    for (let t = 100; t < 160; t += 0.5) ai.flush(t);
    expect(heard.map((e) => e.id)).toEqual(['ap.start', 'ap.done.circularize']);
  });
});

describe('player and AI names', () => {
  function rig(name: string, persona?: string): { ai: VesselAdvisor; heard: AdvisoryEvent[] } {
    const channel = new AdvisoryChannel();
    const heard: AdvisoryEvent[] = [];
    channel.subscribe((e) => heard.push(e));
    const ai = new VesselAdvisor(channel);
    ai.setCommander(name);
    if (persona) ai.setPersona(findPersona(persona));
    return { ai, heard };
  }

  it('each AI introduces itself by its own name', () => {
    for (const id of ['argus', 'halcyon', 'marshal', 'quill']) {
      const { ai, heard } = rig('Eric', id);
      ai.observe(snap(), 0);
      const callsign = findPersona(id).callsign;
      expect(heard[0].speaker).toBe(callsign);
      expect(heard[0].text).toContain(callsign);
    }
  });

  it('uses a chosen name on routine lines, spaced out', () => {
    const { ai, heard } = rig('Eric');
    const s = snap();
    ai.observe(s, 0);
    ai.acknowledge({ id: 'fire-missile', ok: false }, s, 10);
    ai.acknowledge({ id: 'target-clear', ok: true }, s, 20);
    ai.acknowledge({ id: 'drop-mine', ok: false }, s, 30);
    const named = heard.filter((e) => e.text.includes('Eric')).length;
    expect(named).toBeGreaterThanOrEqual(2);
    expect(named).toBeLessThan(heard.length + 1);
    expect(heard.every((e) => !/Commander/.test(e.text))).toBe(true);
  });

  it('keeps the default title from repeating on back-to-back lines', () => {
    const { ai, heard } = rig('Commander', 'halcyon');
    const s = snap();
    ai.observe(s, 0);
    ai.announce({ id: 'ap.aborted.override' }, s, 10);
    ai.announce({ id: 'ap.propose.evade', vars: { count: '1' } }, s, 20);
    ai.flush(40);
    expect(heard.filter((e) => /Commander/.test(e.text)).length).toBeLessThan(heard.length);
  });
});

describe('next-step guidance', () => {
  it('points at MATCH SPEED when still closing after a maneuver', () => {
    const me = ship({ target: 3 });
    const tgt = near(me, 9_000, { id: 3, team: 1, vel: { x: 0, y: 2_300, z: 0 } });
    const cue = guidanceAfter('circularize', snap({ self: me, entities: [me, tgt] }), T);
    expect(cue?.id).toBe('guide.match_speed');
    expect(VOICE.lines['guide.match_speed'].text.join(' ')).toContain('MATCH SPEED');
  });

  it('suggests RENDEZVOUS with a target and designating without one', () => {
    const me = ship({ target: 3 });
    const tgt = near(me, 9_000, { id: 3, team: 1 });
    expect(guidanceAfter('circularize', snap({ self: me, entities: [me, tgt] }), T)?.id).toBe(
      'guide.rendezvous',
    );
    expect(guidanceAfter('altitude', snap(), T)?.id).toBe('guide.designate');
  });

  it('offers a shot at a hostile after matching speed, and a hold otherwise', () => {
    const me = ship({ target: 3 });
    const foe = near(me, 2_000, { id: 3, team: 1 });
    const friend = near(me, 2_000, { id: 3, team: 0 });
    expect(guidanceAfter('rendezvous', snap({ self: me, entities: [me, foe] }), T)?.id).toBe(
      'guide.fire_or_hold',
    );
    expect(guidanceAfter('rendezvous', snap({ self: me, entities: [me, friend] }), T)?.id).toBe(
      'guide.hold_station',
    );
  });

  it('is spoken as guidance, and acting on the helm clears it', () => {
    const channel = new AdvisoryChannel();
    const heard: AdvisoryEvent[] = [];
    channel.subscribe((e) => heard.push(e));
    const ai = new VesselAdvisor(channel);
    ai.setCommander('Eric');
    const s = snap();
    ai.observe(s, 0);
    ai.flush(30);
    heard.length = 0;
    ai.announce({ id: 'ap.done.circularize', vars: { pe: '1 km', ap: '2 km' } }, s, 100);
    ai.guide('circularize', s, 100);
    ai.acknowledge({ id: 'prograde', ok: true }, s, 100.5);
    for (let t = 100; t < 130; t += 0.5) ai.flush(t);
    expect(heard.some((e) => e.priority === 'guide')).toBe(false);
    heard.length = 0;
    ai.guide('circularize', s, 200);
    ai.flush(200);
    expect(heard[0]).toMatchObject({ priority: 'guide', id: 'guide.designate' });
    expect(heard[0].text).toContain('Eric');
  });
});

describe('dialogue categories and lulls', () => {
  function rig(random = () => 0.99): { ai: VesselAdvisor; heard: AdvisoryEvent[] } {
    const channel = new AdvisoryChannel();
    const heard: AdvisoryEvent[] = [];
    channel.subscribe((e) => heard.push(e));
    return { ai: new VesselAdvisor(channel, VOICE, random), heard };
  }
  const raised = ellipse(R + 80_000, R + 150_000, 0);

  it('gives every line exactly one known category', () => {
    for (const [id, spec] of Object.entries(VOICE.lines)) {
      expect(VOICE.categories[spec.category], id).toBeDefined();
    }
    for (const c of ['alarm', 'event', 'status', 'quip'] as const) {
      expect(
        Object.values(VOICE.lines).some((l) => l.category === c),
        c,
      ).toBe(true);
    }
  });

  it('has no engine or heading call-outs', () => {
    const banned =
      /^(ack\.(prograde|retrograde|radial|hold|throttle|target$|anti-target|target-pro|target-retro)|ap\.phase\.)/;
    expect(Object.keys(VOICE.lines).filter((id) => banned.test(id))).toEqual([]);
  });

  it('holds the new orbit report until the burn is over and the action dies down', () => {
    const { ai, heard } = rig();
    ai.observe(snap(), 0);
    // Burning: the orbit changes but nothing is reported.
    for (let t = 1; t <= 20; t++)
      ai.observe(snap({ self: ship({ throttle: 1 }), orbit: raised }), t);
    expect(heard.some((e) => e.category === 'status' && e.id !== 'status.online')).toBe(false);
    // Engine off: still quiet until the lull is long enough.
    ai.observe(snap({ orbit: raised }), 21);
    expect(heard.some((e) => e.id.startsWith('debrief.'))).toBe(false);
    for (let t = 22; t <= 30; t++) ai.observe(snap({ orbit: raised }), t);
    const report = heard.filter((e) => e.id === 'debrief.orbit');
    expect(report).toHaveLength(1);
    expect(report[0].timestamp).toBeGreaterThanOrEqual(20 + VOICE.lull.quietSeconds);
    expect(report[0].category).toBe('status');
  });

  it('debriefs a finished burn one line at a time, then quips only after the last', () => {
    const { ai, heard } = rig();
    const me = ship({ target: 3 });
    const friend = near(me, 40_000, { id: 3, team: 0 });
    const burn = (t: number) =>
      ai.observe(snap({ self: { ...me, throttle: 1 }, orbit: raised, entities: [me, friend] }), t);
    ai.observe(snap({ self: me, entities: [me, friend] }), 0);
    for (let t = 1; t <= 5; t++) burn(t);
    for (let t = 6; t <= 80; t += 0.5)
      ai.observe(snap({ self: me, orbit: raised, entities: [me, friend] }), t);
    const ids = heard.map((e) => e.id);
    const debrief = ids.filter((id) => id.startsWith('debrief.'));
    expect(debrief[0]).toBe('debrief.orbit');
    expect(debrief.some((id) => id.startsWith('debrief.next_'))).toBe(true);
    expect(debrief.some((id) => id.startsWith('debrief.approach.'))).toBe(true);
    expect(ids).not.toContain('status.orbit');
    const lastDebrief = ids
      .map((id, i) => (id.startsWith('debrief.') ? i : -1))
      .reduce((a, b) => Math.max(a, b));
    const firstQuip = ids.findIndex((id) => id.startsWith('quip.'));
    expect(firstQuip === -1 || firstQuip > lastDebrief).toBe(true);
    // Spoken in the persona's order, never overlapping.
    const lines = heard.filter((e) => e.id.startsWith('debrief.'));
    for (let i = 1; i < lines.length; i++)
      expect(lines[i].timestamp).toBeGreaterThanOrEqual(
        lines[i - 1].timestamp + lines[i - 1].duration,
      );
  });

  it('drops an unfinished debrief when the next burn starts', () => {
    const { ai, heard } = rig();
    ai.observe(snap(), 0);
    for (let t = 1; t <= 5; t++)
      ai.observe(snap({ self: ship({ throttle: 1 }), orbit: raised }), t);
    for (let t = 6; t <= 11; t += 0.5) ai.observe(snap({ orbit: raised }), t);
    for (let t = 12; t <= 60; t++)
      ai.observe(snap({ self: ship({ throttle: 1 }), orbit: raised }), t);
    const n = heard.filter((e) => e.id.startsWith('debrief.')).length;
    for (let t = 61; t <= 70; t++)
      ai.observe(snap({ self: ship({ throttle: 1 }), orbit: raised }), t);
    expect(heard.filter((e) => e.id.startsWith('debrief.'))).toHaveLength(n);
  });

  it('reports at once when the commander warps after changing orbit', () => {
    const { ai, heard } = rig();
    ai.observe(snap(), 0);
    for (let t = 1; t <= 10; t++)
      ai.observe(snap({ self: ship({ throttle: 1 }), orbit: raised }), t);
    const coasting = snap({ orbit: raised, warp: 10 });
    ai.observe(coasting, 11);
    ai.acknowledge({ id: 'warp-up', ok: true }, coasting, 11.2);
    ai.observe(coasting, 11.3);
    expect(heard.at(-1)).toMatchObject({ id: 'debrief.orbit', timestamp: 11.3 });
  });

  it('quips only in a lull, after the status report, at most once per 30 s', () => {
    const { ai, heard } = rig();
    ai.observe(snap(), 0);
    for (let t = 1; t <= 5; t++)
      ai.observe(snap({ self: ship({ throttle: 1 }), orbit: raised }), t);
    for (let t = 6; t <= 120; t += 0.5) ai.observe(snap({ orbit: raised }), t);
    const ids = heard.map((e) => e.id);
    const firstQuip = ids.findIndex((id) => id.startsWith('quip.'));
    expect(firstQuip).toBeGreaterThan(ids.indexOf('debrief.orbit'));
    const quips = heard.filter((e) => e.category === 'quip');
    expect(quips.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < quips.length; i++) {
      expect(quips[i].timestamp - quips[i - 1].timestamp).toBeGreaterThanOrEqual(30);
    }
    // No quips while the engine is lit.
    const n = quips.length;
    for (let t = 121; t <= 200; t++)
      ai.observe(snap({ self: ship({ throttle: 1 }), orbit: raised }), t);
    expect(heard.filter((e) => e.category === 'quip')).toHaveLength(n);
  });

  it('picks quips that fit the moment and does not repeat until the pool is used', () => {
    const { ai, heard } = rig(() => 0); // always prefer a fitting pool
    const me = ship({ target: 3 });
    const foe = near(me, 50_000, { id: 3, team: 1, shipClass: DRONE });
    for (let t = 0; t <= 400; t++) ai.observe(snap({ self: me, entities: [me, foe] }), t);
    const quips = heard.filter((e) => e.category === 'quip');
    // Lines tagged for the hunt lead (other fitting lines mix in), and none repeats while fresh ones remain.
    const fits = (id: string): boolean => id === 'quip.hunting' || id === 'quip.combat';
    expect(quips.slice(0, 8).filter((e) => fits(e.id)).length).toBeGreaterThanOrEqual(4);
    const texts = quips.slice(0, 8).map((e) => e.text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(quips.some((e) => e.text.includes('Drone 3'))).toBe(true);
  });

  it('paces each category on its own gap in the queue', () => {
    const q = new SpeechQueue(VOICE);
    q.push(line('q1', 'quip', 'quip'), 0);
    expect(q.next(0)?.id).toBe('q1');
    q.push(line('q2', 'quip', 'quip'), 5);
    q.push(line('e1', 'advise', 'event'), 5);
    expect(q.next(5)?.id).toBe('e1');
    expect(q.next(9)).toBeNull(); // the quip waits out its gap (and its TTL)
  });

  it('gives every character a big quip book', () => {
    for (const p of PERSONAS) {
      const count = Object.keys(VOICE.lines)
        .filter((id) => id.startsWith('quip.'))
        .reduce(
          (n, id) =>
            n +
            (p.lines[id] ?? VOICE.lines[id].text).length +
            (VOICE.lines[id].variants ?? []).filter((v) => !v.persona || v.persona.includes(p.id))
              .length,
          0,
        );
      expect(count, p.id).toBeGreaterThanOrEqual(40);
    }
  });
});

describe('speech polish', () => {
  it('rounds spoken measurements to two significant figures, never names', () => {
    expect(
      ['25.4', '129.8', '1234', '0.43', '2.0', '100', '7'].map((n) => twoSig(Number(n))),
    ).toEqual(['25', '130', '1,200', '0.43', '2', '100', '7']);
    expect(
      speakableVars({
        range: '25.4 km',
        relv: '83.8 m/s',
        target: 'Drone 123',
        band: '88.0 km to 91.0 km',
      }),
    ).toEqual({ range: '25 km', relv: '84 m/s', target: 'Drone 123', band: '88 km to 91 km' });
  });

  it('never says the same line twice running, except alarms', () => {
    const q = new SpeechQueue(VOICE);
    q.push(line('event.x', 'advise'), 0);
    expect(q.next(0)?.id).toBe('event.x');
    q.push({ ...line('event.x', 'advise'), text: 'different words' }, 5);
    expect(q.next(5)).toBeNull();
    q.push(line('threat.missile', 'critical', 'alarm'), 10);
    expect(q.next(10)?.id).toBe('threat.missile');
    q.push(line('threat.missile', 'critical', 'alarm'), 20);
    expect(q.next(20)?.id).toBe('threat.missile');
  });
});
