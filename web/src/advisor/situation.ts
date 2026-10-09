// What is going on, as a set of tags the line selector can match. A pure
// function of the snapshot plus a little memory the advisor keeps; it never
// touches controls.

import { EntityKind, len, sub } from '../sim/bridge';
import { fmtDistance } from '../ui/format';
import type { VoiceConfig } from './config';
import { entityName, isHostile, type VesselSnapshot } from './triggers';

/** What the advisor remembers about the flight so far (real-time seconds, `-Infinity` = never). */
export interface SituationMemory {
  /** Real time now. */
  now: number;
  /** Real seconds since the last burn, maneuver, alarm or event. */
  quiet: number;
  hullMax: number;
  lastKill: number;
  kills: number;
  lastMiss: number;
  lastDamage: number;
  lastBurnEnd: number;
  /** Persona id, e.g. `argus`. */
  persona: string;
}

export interface Situation {
  tags: ReadonlySet<string>;
  /** Values for `{slot}`s in lines (already formatted for reading). */
  vars: Record<string, string>;
}

export function buildSituation(
  snap: VesselSnapshot,
  mem: SituationMemory,
  cfg: VoiceConfig,
): Situation {
  const { self, orbit, planetRadius: R } = snap;
  const s = cfg.situation;
  const t = cfg.thresholds;
  const tags = new Set<string>();
  const vars: Record<string, string> = {};
  const recent = (at: number): boolean => mem.now - at < s.recentSeconds;

  tags.add(`persona.${mem.persona}`);

  // Orbit shape and altitude.
  if (orbit) {
    const peAlt = orbit.periapsis - R;
    if (orbit.eccentricity >= 1) tags.add('orbit.escape');
    else
      tags.add(orbit.eccentricity < s.circularEccentricity ? 'orbit.circular' : 'orbit.elliptical');
    if (peAlt < s.lowAltitude) tags.add('orbit.low');
    if (peAlt >= s.highAltitude) tags.add('orbit.high');
    if (peAlt < 0) tags.add('orbit.impact');
    vars.pe = fmtDistance(peAlt);
    if (Number.isFinite(orbit.apoapsis)) vars.ap = fmtDistance(orbit.apoapsis - R);
  }
  vars.altitude = fmtDistance(len(self.pos) - R);

  // Ship state.
  const hull = mem.hullMax > 0 ? self.hp / mem.hullMax : 1;
  if (hull < cfg.lull.quipHullFraction) tags.add('hull.damaged');
  if (hull < s.hullCritical) tags.add('hull.critical');
  if (mem.hullMax > 0 && hull >= 0.999) tags.add('hull.pristine');
  const load = self.heatCapacity > 0 ? self.heat / self.heatCapacity : 0;
  if (load >= s.heatHigh) tags.add('heat.high');
  if (load < s.heatCool) tags.add('heat.cool');
  tags.add(self.throttle > 0 ? 'throttle.burning' : 'throttle.idle');
  if ((snap.warp ?? 1) >= cfg.lull.quipWarp) tags.add('warp.high');

  // Contacts.
  let hostiles = 0;
  let nearest = Infinity;
  for (const e of snap.entities) {
    if (!e.alive || e.id === self.id || !isHostile(self, e, t)) continue;
    const range = len(sub(e.pos, self.pos));
    if (e.kind === EntityKind.Ship) {
      hostiles++;
      nearest = Math.min(nearest, range);
    } else if (
      e.kind === EntityKind.Missile &&
      e.target === self.id &&
      range <= t.missileThreatRange
    ) {
      tags.add('missile.inbound');
    } else if (e.kind === EntityKind.Mine && range <= t.maneuverRange) {
      tags.add('mine.near');
    }
  }
  tags.add(
    hostiles === 0 ? 'hostile.none' : nearest <= t.maneuverRange ? 'hostile.near' : 'hostile.far',
  );
  const target = snap.entities.find((e) => e.id === self.target && e.alive);
  if (target) {
    tags.add('target.set');
    if (isHostile(self, target, t)) tags.add('hostile.hunting');
    vars.target = entityName(target);
    vars.range = fmtDistance(len(sub(target.pos, self.pos)));
  }

  // Mission.
  tags.add(snap.objective ? `mission.${snap.objective.kind}` : 'mission.none');

  // The player, as the AI has seen them behave.
  if (mem.quiet >= s.idleLongSeconds) tags.add('player.idle_long');
  if (mem.kills >= s.killStreak) tags.add('player.kill_streak');
  if (recent(mem.lastMiss)) tags.add('player.just_missed');
  if (recent(mem.lastDamage)) tags.add('player.recent_damage');
  if (recent(mem.lastBurnEnd)) tags.add('burn.recent');
  if (mem.now - mem.lastKill < cfg.lull.quipVictorySeconds) tags.add('player.just_killed');
  vars.kills = String(mem.kills);
  return { tags, vars };
}
