import type { AgentAdapter, HookResult } from './types.js';
import { resolveCommand } from './util.js';

/** Any other --agent command: a plain shared terminal running it, with no hooks, status or spend. */
export class CustomAgent implements AgentAdapter {
  readonly id = 'custom' as const;
  readonly label: string;
  readonly badge = '›_';
  readonly badgeColor = '#6c757d';
  readonly path: string | null;
  readonly hooks = false;
  readonly bootViaHook = false;
  readonly trustsProgress = false;
  readonly transcriptUsage = false;
  readonly resumeExitsEarly = false;
  readonly screen = { loginHint: '' };

  constructor(
    readonly cmd: string,
    readonly extraArgs: string[],
  ) {
    this.path = resolveCommand(cmd);
    this.label = cmd.split('/').pop() || cmd;
  }

  install() {}

  args(): string[] {
    return [...this.extraArgs];
  }

  parseHook(): HookResult {
    return { events: [] };
  }
}
