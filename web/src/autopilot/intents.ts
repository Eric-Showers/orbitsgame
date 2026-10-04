// What the commander can ask ARGUS for. Each intent builds the maneuver
// script that does it; the UI lists these and never knows how they work.

import { changeAltitude, circularize } from './maneuvers/apsis';
import { Evade } from './maneuvers/evade';
import { MatchVelocity } from './maneuvers/match';
import { Rendezvous } from './maneuvers/rendezvous';
import { StationKeep } from './maneuvers/stationkeep';
import { DropMine, LaunchMissile } from './maneuvers/weapons';
import { PILOT_CONFIG, type PilotConfig } from './config';
import type { Maneuver } from './types';

export type IntentNeeds = 'none' | 'target' | 'altitude';
export type IntentGroup = 'orbit' | 'target' | 'combat';

export interface IntentArgs {
  target: number | null;
  /** Altitude entered by the commander (km). */
  altitudeKm: number;
}

export interface Intent {
  id: string;
  group: IntentGroup;
  label: string;
  /** Plain-language explanation for the tooltip. */
  title: string;
  needs: IntentNeeds;
  build(args: IntentArgs, cfg: PilotConfig): Maneuver;
}

const NO_TARGET = 'Select a target first (T).';

function withTarget(args: IntentArgs, make: (id: number) => Maneuver): Maneuver {
  if (args.target === null) throw new Error(NO_TARGET);
  return make(args.target);
}

export const INTENTS: Intent[] = [
  {
    id: 'circularize',
    group: 'orbit',
    label: 'CIRCULARIZE',
    title: 'Make your orbit a circle. The safest, most fuel-efficient place to sit.',
    needs: 'none',
    build: () => circularize('auto'),
  },
  {
    id: 'set-altitude',
    group: 'orbit',
    label: 'GO TO ALTITUDE',
    title: 'Climb or drop to a circular orbit at the altitude you enter (km). Two burns.',
    needs: 'altitude',
    build: (a) => changeAltitude(a.altitudeKm * 1000),
  },
  {
    id: 'rendezvous',
    group: 'target',
    label: 'RENDEZVOUS',
    title: 'Fly to your target and arrive alongside it, matched in speed.',
    needs: 'target',
    build: (a, cfg) => withTarget(a, (id) => new Rendezvous(id, cfg.rendezvous.standoff)),
  },
  {
    id: 'match-velocity',
    group: 'target',
    label: 'MATCH SPEED',
    title: 'Burn until you and the target are drifting together.',
    needs: 'target',
    build: (a) => withTarget(a, (id) => new MatchVelocity(id)),
  },
  {
    id: 'station-keep',
    group: 'target',
    label: 'STAY WITH',
    title: 'Keep station beside the target, correcting drift until you cancel.',
    needs: 'target',
    build: (a) => withTarget(a, (id) => new StationKeep(id)),
  },
  {
    id: 'intercept',
    group: 'combat',
    label: 'INTERCEPT',
    title: 'Close to missile range behind a hostile at matched speed.',
    needs: 'target',
    build: (a, cfg) =>
      withTarget(
        a,
        (id) => new Rendezvous(id, cfg.rendezvous.interceptStandoff, 'Intercept', 'intercept'),
      ),
  },
  {
    id: 'launch-missile',
    group: 'combat',
    label: 'FIRE (CHECKED)',
    title: 'Fire a missile at the target once ARGUS confirms it can reach it.',
    needs: 'target',
    build: (a) => withTarget(a, (id) => new LaunchMissile(id)),
  },
  {
    id: 'drop-mine',
    group: 'combat',
    label: 'LAY MINE (CHECKED)',
    title: 'Lay a mine only if a hostile will pass close enough to wake it.',
    needs: 'none',
    build: () => new DropMine(),
  },
  {
    id: 'evade',
    group: 'combat',
    label: 'EVADE',
    title: 'Dodge missiles locked on you: burns across their line of sight.',
    needs: 'none',
    build: () => new Evade(),
  },
];

export const intentById = (id: string): Intent | undefined => INTENTS.find((i) => i.id === id);

/** Builds an intent's maneuver, or the reason it cannot be built. */
export function buildIntent(
  intent: Intent,
  args: IntentArgs,
  cfg: PilotConfig = PILOT_CONFIG,
): Maneuver | string {
  try {
    return intent.build(args, cfg);
  } catch (e) {
    return e instanceof Error ? e.message : 'That is not possible.';
  }
}
