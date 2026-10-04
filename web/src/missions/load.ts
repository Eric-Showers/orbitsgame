import type { MissionDef, MissionFile, ObjectiveDef, OrbitDef } from './types';
import data from './missions.json';

export const SHIP_CLASS_INDEX = { corvette: 0, drone: 1, gunboat: 2, minelayer: 3, beacon: 4 };
export const TEAM_INDEX = { player: 0, enemy: 1, neutral: 2 };

/**
 * Checks the references and ranges the type system cannot (tags, objective
 * ids, ordering, band bounds). Returns human-readable problems; empty = valid.
 * Catches typos in hand-edited mission data before a mission is flown.
 */
export function validateMissions(file: MissionFile): string[] {
  const problems: string[] = [];
  if (file.version !== 1) problems.push(`unsupported mission file version ${file.version}`);
  const missionIds = new Set<string>();
  for (const m of file.missions) {
    const at = (msg: string): number => problems.push(`${m.id}: ${msg}`);
    if (missionIds.has(m.id)) at('duplicate mission id');
    missionIds.add(m.id);
    if (!(m.player.class in SHIP_CLASS_INDEX)) at(`unknown player class ${m.player.class}`);
    checkOrbit(m.player.orbit, 'player', at);

    const tags = new Set<string>();
    for (const s of m.ships) {
      if (s.tag === 'player' || tags.has(s.tag)) at(`ship tag ${s.tag} is reserved or duplicated`);
      tags.add(s.tag);
      if (!(s.class in SHIP_CLASS_INDEX)) at(`ship ${s.tag}: unknown class ${s.class}`);
      if (!(s.team in TEAM_INDEX)) at(`ship ${s.tag}: unknown team ${s.team}`);
      checkOrbit(s.orbit, `ship ${s.tag}`, at);
    }

    const objIds = new Set<string>();
    if (m.objectives.length === 0) at('has no objectives');
    for (const o of m.objectives) {
      if (objIds.has(o.id)) at(`duplicate objective id ${o.id}`);
      if (o.after !== undefined && !objIds.has(o.after)) {
        at(`objective ${o.id}: "after" must name an earlier objective, got ${o.after}`);
      }
      objIds.add(o.id);
      for (const t of objectiveTags(o)) {
        if (!tags.has(t)) at(`objective ${o.id}: unknown ship tag ${t}`);
      }
      for (const [name, r] of objectiveRanges(o)) {
        if (!(r[0] <= r[1])) at(`objective ${o.id}: ${name} range [${r}] is reversed`);
      }
    }
    for (const s of m.ships) {
      const after = s.spawn?.afterObjective;
      if (after !== undefined && !objIds.has(after)) {
        at(`ship ${s.tag}: spawns after unknown objective ${after}`);
      }
    }
    for (const t of m.fail?.protect ?? []) {
      if (!tags.has(t)) at(`protect: unknown ship tag ${t}`);
    }
  }
  return problems;
}

function checkOrbit(o: OrbitDef, who: string, at: (msg: string) => void): void {
  if (!(o.pe > 0)) at(`${who}: orbit pe must be a positive altitude`);
  if (o.ap !== undefined && o.ap < o.pe) at(`${who}: orbit ap is below pe`);
  if (o.phaseDeg !== undefined && o.lead !== undefined)
    at(`${who}: give phaseDeg or lead, not both`);
}

function objectiveTags(o: ObjectiveDef): string[] {
  if (o.type === 'rendezvous') return [o.target];
  if (o.type === 'destroy') return o.targets;
  return [];
}

function objectiveRanges(o: ObjectiveDef): [string, [number, number]][] {
  if (o.type === 'orbit') {
    return [
      ['pe', o.pe],
      ['ap', o.ap],
    ];
  }
  if (o.type === 'mineZone') return [['altitude', o.altitude]];
  return [];
}

/** Whether missions unlock in order (`lockProgression` in missions.json; default open). */
export const LOCK_PROGRESSION = (data as MissionFile).lockProgression ?? false;

/** The campaign ladder from `missions.json`, in order. Throws if the data is invalid. */
export function loadMissions(file: MissionFile = data as MissionFile): MissionDef[] {
  const problems = validateMissions(file);
  if (problems.length > 0) throw new Error(`Invalid mission data:\n${problems.join('\n')}`);
  return file.missions;
}
