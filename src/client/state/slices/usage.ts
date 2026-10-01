import type { PlanLimits, Usage, UsageState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    usage: UsageState;
    /** The Claude plan's 5-hour and weekly limits. */
    limits: PlanLimits;
    /** Cursor's own plan usage for the current billing cycle. */
    cursorLimits: PlanLimits;
  }
  interface Topics {
    usage: true;
    limits: true;
    cursorLimits: true;
  }
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, calls: 0 });

/** What the workers have spent, and how much of the plan's limits is left. */
export const usage: Slice = {
  init(s) {
    s.usage = { total: zeroUsage(), today: zeroUsage(), day: '', pauseHiring: false };
    s.limits = { windows: [], at: 0 };
    s.cursorLimits = { windows: [], at: 0 };
  },
  on: {
    welcome(s, m) {
      s.usage = m.usage;
      s.limits = m.limits;
      s.cursorLimits = m.cursorLimits;
      return ['usage', 'limits', 'cursorLimits'];
    },
    usage(s, m) {
      s.usage = m.state;
      return ['usage'];
    },
    limits(s, m) {
      s.limits = m.state;
      return ['limits'];
    },
    cursorLimits(s, m) {
      s.cursorLimits = m.state;
      return ['cursorLimits'];
    },
  },
};
