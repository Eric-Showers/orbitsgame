import { failed, type Ctx, type Maneuver, type Plan, type Status } from '../types';

/**
 * Runs maneuvers one after another. Stages are built when they are reached,
 * so a later stage plans from where the earlier ones left the ship.
 */
export class Sequence implements Maneuver {
  private index = 0;
  private current: Maneuver | null = null;

  constructor(
    readonly kind: string,
    readonly label: string,
    private stages: Array<(ctx: Ctx) => Maneuver>,
    /** Whole-sequence estimate from the current state. */
    private planner: (ctx: Ctx) => Plan,
  ) {}

  plan(ctx: Ctx): Plan {
    return this.planner(ctx);
  }

  start(ctx: Ctx): void {
    this.index = 0;
    this.enter(ctx);
  }

  private enter(ctx: Ctx): void {
    this.current = this.stages[this.index](ctx);
    this.current.start(ctx);
  }

  execute(ctx: Ctx): Status {
    if (!this.current) return failed('Nothing to fly.');
    const st = this.current.execute(ctx);
    const n = this.stages.length;
    if (st.state === 'failed') return st;
    if (st.state === 'done') {
      this.index++;
      if (this.index >= n) return { ...st, progress: 1 };
      this.enter(ctx);
      return {
        state: 'running',
        phase: 'next',
        progress: this.index / n,
        note: 'Next burn',
        coast: 0,
      };
    }
    return { ...st, progress: (this.index + st.progress) / n };
  }

  abort(ctx: Ctx): void {
    this.current?.abort(ctx);
  }
}
