import { len, sub } from '../../sim/bridge';
import { angleOf, semiMajorFor, TAU, wrapTau } from '../orbitmath';
import { failed, infeasible, type Ctx, type Maneuver, type Plan, type Status } from '../types';
import { ApsisBurn, changeAltitude } from './apsis';
import { cannotFly, costVars, fmtDistance, usableDv } from './common';
import { MatchVelocity } from './match';

type Stage = 'altitude' | 'phasing' | 'match';
/** Progress band [start, span] each stage owns. */
const WEIGHT: Record<Stage, [number, number]> = {
  altitude: [0, 0.25],
  phasing: [0.25, 0.65],
  match: [0.9, 0.1],
};

interface Phasing {
  k: number;
  /** Radius of the phasing orbit's low point. */
  rLow: number;
  period: number;
  dv: number;
}

/**
 * Closes on a target that circles the planet at a similar altitude:
 *  1. Hohmann to the target's altitude if ours differs,
 *  2. a phasing orbit (drop, wait k laps, recircularize) that arrives `standoff`
 *     metres behind it,
 *  3. match velocity,
 * and repeats the phasing if the last lap left too much range.
 * Also serves as the intercept approach (a larger standoff).
 */
export class Rendezvous implements Maneuver {
  readonly kind: string;
  private stage: Stage = 'altitude';
  private child: Maneuver | null = null;
  private attempts = 0;

  constructor(
    private targetId: number,
    private standoff: number,
    readonly label = 'Rendezvous',
    kind = 'rendezvous',
  ) {
    this.kind = kind;
  }

  // ---- geometry -----------------------------------------------------------------

  private target(ctx: Ctx) {
    const t = ctx.entity(this.targetId);
    return t?.alive ? t : undefined;
  }

  /** Why this target cannot be approached by phasing, or null. */
  private obstacle(ctx: Ctx): string | null {
    const t = this.target(ctx);
    if (!t) return 'The target is gone.';
    const to = ctx.orbitOf(t.id);
    const rc = ctx.cfg.rendezvous;
    if (!to || !Number.isFinite(to.period)) return 'The target is not on a closed orbit.';
    if (to.eccentricity > rc.maxEccentricity) {
      return 'The target orbit is too eccentric for my phasing planner. Match orbits by hand.';
    }
    if (!ctx.orbit || !Number.isFinite(ctx.orbit.period)) return 'I am not on a closed orbit.';
    return null;
  }

  private targetRadius(ctx: Ctx): number {
    const to = ctx.orbitOf(this.targetId)!;
    return to.semiMajorAxis;
  }

  /** Phase angle by which the target leads us (rad, 0..2pi). */
  private lead(ctx: Ctx): number {
    const t = this.target(ctx)!;
    return wrapTau(angleOf(t.pos) - angleOf(ctx.self.pos));
  }

  /** Phasing orbit that turns a lead of `phi` (after the standoff) into zero. */
  private phasing(ctx: Ctx, R: number, phi: number): Phasing | null {
    const to = ctx.orbitOf(this.targetId)!;
    const minR = ctx.planetRadius + ctx.cfg.safety.minAltitude;
    for (let k = 1; k <= ctx.cfg.rendezvous.maxRevolutions; k++) {
      const period = to.period * (1 - phi / (TAU * k));
      const a = semiMajorFor(ctx.mu, period);
      const rLow = 2 * a - R;
      if (rLow >= minR) {
        const dv = Math.sqrt(ctx.mu / R) - Math.sqrt(ctx.mu * (2 / R - 1 / a));
        return { k, rLow, period, dv };
      }
    }
    return null;
  }

  private effectiveLead(ctx: Ctx, R: number): number {
    return wrapTau(this.lead(ctx) - this.standoff / R);
  }

  // ---- Maneuver -----------------------------------------------------------------

  plan(ctx: Ctx): Plan {
    const blocked = cannotFly(ctx) ?? this.obstacle(ctx);
    if (blocked) return infeasible(blocked);
    const t = this.target(ctx)!;
    const rc = ctx.cfg.rendezvous;
    const R = this.targetRadius(ctx);
    const here = ctx.orbit!;
    let dv = 0;
    let eta = 0;
    const needHohmann =
      Math.abs(here.apoapsis - R) > rc.altitudeTolerance ||
      Math.abs(here.periapsis - R) > rc.altitudeTolerance;
    if (needHohmann) {
      const alt = changeAltitude(R - ctx.planetRadius).plan(ctx);
      if (!alt.feasible) return alt;
      dv += alt.dv;
      eta += alt.eta;
    }
    const range = len(sub(t.pos, ctx.self.pos));
    if (range > rc.closeRange + this.standoff) {
      const ph = this.phasing(ctx, R, this.effectiveLead(ctx, R));
      if (!ph) return infeasible('There is no safe phasing orbit for that target right now.');
      dv += 2 * ph.dv;
      eta += ph.k * ph.period;
    }
    dv += len(sub(t.vel, ctx.self.vel));
    if (dv > usableDv(ctx)) return infeasible('Not enough fuel to reach that target.');
    eta += 30;
    return {
      feasible: true,
      nodes: [],
      dv,
      eta,
      vars: {
        ...costVars({ dv, eta }),
        range: fmtDistance(range),
        standoff: fmtDistance(this.standoff),
        laps: String(eta > 0 ? Math.max(1, Math.round(eta / here.period)) : 0),
      },
    };
  }

  start(ctx: Ctx): void {
    this.attempts = 0;
    ctx.helm.setTarget(this.targetId);
    const R = this.targetRadius(ctx);
    const o = ctx.orbit!;
    const rc = ctx.cfg.rendezvous;
    const off =
      Math.abs(o.apoapsis - R) > rc.altitudeTolerance ||
      Math.abs(o.periapsis - R) > rc.altitudeTolerance;
    if (off && this.far(ctx)) this.enter(ctx, 'altitude');
    else this.enterPhasingOrMatch(ctx);
  }

  private far(ctx: Ctx): boolean {
    const t = this.target(ctx)!;
    return len(sub(t.pos, ctx.self.pos)) > ctx.cfg.rendezvous.closeRange + this.standoff;
  }

  private enterPhasingOrMatch(ctx: Ctx): void {
    if (this.far(ctx) && this.attempts < ctx.cfg.rendezvous.maxAttempts) {
      const R = this.targetRadius(ctx);
      const ph = this.phasing(ctx, R, this.effectiveLead(ctx, R));
      if (ph) {
        this.attempts++;
        this.stage = 'phasing';
        this.child = new PhasingOrbit(ph.rLow, ph.k, ph.period);
        this.child.start(ctx);
        return;
      }
    }
    this.enter(ctx, 'match');
  }

  private enter(ctx: Ctx, stage: Stage): void {
    this.stage = stage;
    if (stage === 'altitude') {
      this.child = changeAltitude(this.targetRadius(ctx) - ctx.planetRadius);
    } else {
      this.child = new MatchVelocity(this.targetId);
    }
    this.child.start(ctx);
  }

  execute(ctx: Ctx): Status {
    if (!this.child) return failed('Nothing to fly.');
    if (!this.target(ctx)) return failed('Lost the target.');
    const st = this.child.execute(ctx);
    if (st.state === 'failed') return st;
    const [base, span] = WEIGHT[this.stage];
    if (st.state === 'running') {
      return { ...st, phase: `${this.stage}.${st.phase}`, progress: base + span * st.progress };
    }
    const next = (note: string): Status => ({
      state: 'running',
      phase: 'next',
      progress: base + span,
      note,
      coast: 0,
    });
    if (this.stage === 'altitude') {
      this.enterPhasingOrMatch(ctx);
      return next('Altitude matched');
    }
    if (this.stage === 'phasing') {
      this.enter(ctx, 'match');
      return next('Phasing complete');
    }
    // Matched speed: check how close we got.
    const range = len(sub(this.target(ctx)!.pos, ctx.self.pos));
    const rc = ctx.cfg.rendezvous;
    if (Math.abs(range - this.standoff) > rc.rangeTolerance && this.far(ctx) && this.attempts < rc.maxAttempts) {
      this.enterPhasingOrMatch(ctx);
      return next('Adjusting phase');
    }
    return {
      state: 'done',
      phase: 'done',
      progress: 1,
      note: `On station, range ${fmtDistance(range)}`,
      coast: 0,
    };
  }

  abort(ctx: Ctx): void {
    this.child?.abort(ctx);
    ctx.helm.setThrottle(0);
  }
}

/** Drop to a lower orbit here, coast `k` laps, recircularize at the same point. */
class PhasingOrbit implements Maneuver {
  readonly kind = 'phasing';
  readonly label = 'Phasing orbit';
  private down: ApsisBurn;
  private up: ApsisBurn;
  private onUp = false;

  constructor(
    rLow: number,
    private k: number,
    private period: number,
  ) {
    this.down = new ApsisBurn('phasing.down', 'Phasing burn', 'now', rLow);
    this.up = new ApsisBurn(
      'phasing.up',
      'Recircularize',
      { time: () => (this.down.nodeTime ?? 0) + this.k * this.period },
      'circular',
    );
  }

  plan(): Plan {
    return infeasible('Planned by the rendezvous.');
  }

  start(ctx: Ctx): void {
    this.onUp = false;
    this.down.start(ctx);
  }

  execute(ctx: Ctx): Status {
    if (!this.onUp) {
      const st = this.down.execute(ctx);
      if (st.state !== 'done') return { ...st, progress: 0.05 * st.progress };
      this.onUp = true;
      this.up.start(ctx);
      return { state: 'running', phase: 'coast', progress: 0.05, note: 'Coasting', coast: 0 };
    }
    const st = this.up.execute(ctx);
    if (st.state !== 'running') return st;
    const lap = (ctx.time - (this.down.nodeTime ?? 0)) / (this.k * this.period);
    return { ...st, progress: Math.min(0.95, 0.05 + 0.9 * lap) };
  }

  abort(ctx: Ctx): void {
    this.down.abort(ctx);
    this.up.abort(ctx);
  }
}
