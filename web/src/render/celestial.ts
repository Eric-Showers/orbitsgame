import config from './celestial.json';

export interface Vec2 {
  x: number;
  y: number;
}

export const CELESTIAL = config;

const DEG = Math.PI / 180;

/** Unit vector from the planet toward the sun, in the orbital frame, at sim time `t`. */
export function sunDirection(t: number, cfg = config.sun): Vec2 {
  const a = (cfg.angleDeg + (cfg.rateDegPerHour * t) / 3600) * DEG;
  return { x: Math.cos(a), y: Math.sin(a) };
}

/**
 * Moon position at sim time `t`: a circular, prograde orbit about the planet
 * whose period follows Kepler's third law for the planet's mu. Visual only;
 * the sim does not apply the moon's gravity.
 */
export function moonPosition(t: number, mu: number, cfg = config.moon): Vec2 {
  const n = Math.sqrt(mu / cfg.orbitRadius ** 3);
  const a = cfg.phaseDeg * DEG + n * t;
  return { x: cfg.orbitRadius * Math.cos(a), y: cfg.orbitRadius * Math.sin(a) };
}

export function moonPeriod(mu: number, cfg = config.moon): number {
  return 2 * Math.PI * Math.sqrt(cfg.orbitRadius ** 3 / mu);
}

/** True when `p` is inside the planet's cylindrical shadow (sun treated as infinitely distant). */
export function inPlanetShadow(p: Vec2, sunDir: Vec2, planetRadius: number): boolean {
  const along = p.x * sunDir.x + p.y * sunDir.y;
  if (along >= 0) return false;
  const across = -p.x * sunDir.y + p.y * sunDir.x;
  return Math.abs(across) < planetRadius;
}
