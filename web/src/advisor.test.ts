import { describe, expect, it } from 'vitest';
import { VesselAdvisor } from './advisor/advisor';
import { AdvisoryChannel, type AdvisoryEvent } from './advisor/channel';
import { fillTemplate, VOICE, type VoiceConfig } from './advisor/config';
import { SpeechQueue, type PendingLine } from './advisor/queue';
import {
  evaluateConditions,
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

  it('warns of rising drive heat, then the limit instead', () => {
    expect(on(snap({ self: ship({ heat: 600 }) }))).toEqual(['heat.high']);
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
    const cues = evaluateCues(s, snap(), T, { burnSeconds: 0, hullMax: 100 });
    expect(cues.map((c) => c.id)).toEqual(['status.splash', 'heat.derate', 'damage.hull']);
    expect(cues[0].vars?.target).toBe('Drone 3');
    expect(cues[2].vars?.hp).toBe('60%');
  });

  it('reports the orbit after a real burn, not a tap', () => {
    const prev = snap({ self: ship({ throttle: 1 }) });
    const now = snap();
    expect(evaluateCues(now, prev, T, { burnSeconds: 10, hullMax: 100 }).map((c) => c.id)).toEqual([
      'status.orbit',
    ]);
    expect(evaluateCues(now, prev, T, { burnSeconds: 1, hullMax: 100 })).toEqual([]);
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

function line(id: string, priority: PendingLine['priority']): PendingLine {
  return {
    id,
    priority,
    rank: VOICE.priorities[priority].rank,
    text: 'one two three',
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
    q.push(line('s', 'status'), 0);
    q.next(0);
    q.push(line('c', 'critical'), 0.1);
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
      ai.observe(snap({ self: ship({ heat }), simTime: t }), (t += 5));
    feed(0);
    feed(560);
    feed(570);
    feed(480); // inside hysteresis: still latched
    feed(560);
    expect(heard.map((e) => e.id)).toEqual(['status.online', 'heat.high']);
    feed(300); // clears
    feed(560); // re-arms, but the cooldown has not run out
    expect(heard.filter((e) => e.id === 'heat.high')).toHaveLength(1);
    t += 100;
    feed(300);
    feed(560);
    expect(heard.filter((e) => e.id === 'heat.high')).toHaveLength(2);
    const ev = heard[1];
    expect(ev).toMatchObject({ priority: 'warning', vessel: 0, speaker: 'ARGUS' });
    expect(ev.text).toContain('56%');
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
    ai.acknowledge({ id: 'target', ok: false }, s, 20);
    ai.acknowledge({ id: 'prograde', ok: true }, s, 30);
    ai.acknowledge({ id: 'warp-up', ok: true }, s, 40); // no line: stays quiet
    expect(heard.map((e) => e.id)).toEqual([
      'status.online',
      'ack.fire-missile.no_target',
      'ack.attitude.fail',
      'ack.prograde',
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
      expect(spec.text.length, id).toBeGreaterThan(0);
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
