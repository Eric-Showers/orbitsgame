import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VesselAdvisor } from './advisor/advisor';
import { AdvisoryChannel, type AdvisoryEvent } from './advisor/channel';
import { VOICE } from './advisor/config';
import { objectiveAdvice, type ObjectiveView } from './advisor/objectives';
import { PERSONAS } from './advisor/personas';
import { playerSnapshot } from './advisor/snapshot';
import { loadMissions } from './missions/load';
import { MissionRun } from './missions/run';
import { Attitude } from './sim/bridge';
import { Game, initSync } from './wasm-pkg/orbit_wasm.js';

initSync({ module: readFileSync(new URL('./wasm-pkg/orbit_wasm_bg.wasm', import.meta.url)) });

const MISSIONS = loadMissions();
const O = VOICE.objective;

function advice(run: MissionRun): string | null {
  const view = run.objectiveView();
  const snap = playerSnapshot(run.session, [], view);
  return view ? (objectiveAdvice(snap, view, O)?.id ?? null) : null;
}

function burn(run: MissionRun, mode: Attitude, seconds: number): void {
  const s = run.session;
  s.setAttitude(mode);
  for (let t = 0; t < 3; t += 0.1) run.update(0.1); // turn first
  s.setThrottle(1);
  for (let t = 0; t < seconds; t += 0.1) run.update(0.1);
  s.setThrottle(0);
}

function coast(run: MissionRun, seconds: number): void {
  const end = run.session.time + seconds;
  while (run.session.time < end) run.update(0.1);
}

describe('mission objective advice on the first seven missions', () => {
  it('Raising Station: raise the far side, then round it out at apoapsis', () => {
    const run = new MissionRun(new Game(), MISSIONS[0]);
    expect(advice(run)).toBe('obj.orbit.raise');
    burn(run, Attitude.Prograde, 0.1);
    while (advice(run) === 'obj.orbit.raise') burn(run, Attitude.Prograde, 0.2);
    expect(advice(run)).toBe('obj.orbit.circularize_up');
    burn(run, Attitude.Prograde, 10); // far too long: apoapsis sails past the band
    expect(advice(run)).toBe('obj.orbit.overshoot_high');
  });

  it('Rendezvous at Station: lower to catch up, then raise to stay behind as we close', () => {
    const run = new MissionRun(new Game(), MISSIONS[1]);
    expect(advice(run)).toBe('obj.chase.lower');
    burn(run, Attitude.Retrograde, 3);
    expect(advice(run)).toBe('obj.chase.gaining');
    run.session.setWarp(3);
    let saw = '';
    for (let i = 0; i < 400 && !saw; i++) {
      coast(run, 5);
      if (advice(run) === 'obj.chase.overtake') saw = 'overtake';
    }
    expect(saw).toBe('overtake');
  });

  it('Two-Beacon Patrol: after the lead beacon, raise to let the tail beacon catch up', () => {
    const run = new MissionRun(new Game(), MISSIONS[2]);
    expect(advice(run)).toBe('obj.chase.lower');
    run.objectives[0].status = 'done'; // skip to the second leg
    run.objectives[1].status = 'active';
    expect(advice(run)).toBe('obj.chase.raise');
  });

  it('Live Fire: designate, then fire', () => {
    const run = new MissionRun(new Game(), MISSIONS[3]);
    expect(advice(run)).toBe('obj.destroy.designate');
    run.session.cycleTarget();
    expect(advice(run)).toBe('obj.destroy.fire');
  });

  it('Crossing Traffic: either drone counts as tracked, and crossers are waited for', () => {
    const run = new MissionRun(new Game(), MISSIONS[4]);
    expect(advice(run)).toBe('obj.destroy.designate');
    run.session.cycleTarget();
    expect(['obj.destroy.crossing', 'obj.destroy.fire']).toContain(advice(run));
  });

  it('Long Reach: lower to catch the distant drone', () => {
    const run = new MissionRun(new Game(), MISSIONS[5]);
    run.session.cycleTarget();
    expect(advice(run)).toBe('obj.chase.lower');
  });

  it('Operation Minefield: climb into the lane before laying mines', () => {
    const run = new MissionRun(new Game(), MISSIONS[6]);
    expect(advice(run)).toBe('obj.mine.raise');
  });
});

describe('objective line delivery', () => {
  const view: ObjectiveView = { kind: 'survive', remaining: 300 };

  function flight(): { heard: AdvisoryEvent[]; run: MissionRun; ai: VesselAdvisor } {
    const channel = new AdvisoryChannel();
    const heard: AdvisoryEvent[] = [];
    channel.subscribe((e) => heard.push(e));
    const ai = new VesselAdvisor(channel, VOICE, () => 0.99);
    return { heard, run: new MissionRun(new Game(), MISSIONS[1]), ai };
  }

  it('takes the lull slot ahead of quips but never says the same line twice running', () => {
    const { heard, run, ai } = flight();
    const snap = playerSnapshot(run.session, [], view);
    for (let t = 0; t <= 200; t += 0.5) ai.observe(snap, t);
    const slots = heard.filter((e) => e.category === 'objective' || e.category === 'quip');
    expect(slots[0].category).toBe('objective');
    expect(slots[0].id).toBe('obj.survive');
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].timestamp - slots[i - 1].timestamp).toBeGreaterThanOrEqual(30);
    }
    // Same advice every slot: it is said once, then banter fills the gaps.
    expect(slots.filter((e) => e.category === 'objective')).toHaveLength(1);
    expect(slots.length).toBeGreaterThanOrEqual(5);
  });

  it('speaks a changed situation at the next slot, then may return to the earlier one', () => {
    const { heard, run, ai } = flight();
    const s = run.session;
    let t = 0;
    const feed = (v: ObjectiveView, seconds: number): void => {
      for (const end = t + seconds; t < end; t += 0.5) ai.observe(playerSnapshot(s, [], v), t);
    };
    feed(view, 40);
    feed({ kind: 'mineZone', altitude: [88_000, 91_000], left: 3 }, 40);
    feed(view, 40);
    expect(heard.filter((e) => e.category === 'objective').map((e) => e.id)).toEqual([
      'obj.survive',
      'obj.mine.raise',
      'obj.survive',
    ]);
  });

  it('stays quiet about the objective while the engine burns', () => {
    const { heard, run, ai } = flight();
    run.session.setThrottle(1);
    const snap = playerSnapshot(run.session, [], view);
    for (let t = 0; t <= 60; t += 0.5) ai.observe(snap, t);
    expect(heard.some((e) => e.category === 'objective')).toBe(false);
  });

  it('every visible character has its own wording for every objective line', () => {
    const ids = Object.keys(VOICE.lines).filter((id) => id.startsWith('obj.'));
    expect(ids.length).toBeGreaterThanOrEqual(20);
    for (const p of PERSONAS.filter((x) => !x.hidden && x.id !== 'argus')) {
      for (const id of ids) expect(p.lines[id], `${p.id} ${id}`).toBeDefined();
    }
  });
});
