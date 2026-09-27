import type { AgentId, AgentOption } from '../../shared/protocol.js';
import type { AgentConfig } from '../config.js';
import type { AgentAdapter } from './types.js';
import { ClaudeAgent } from './claude.js';
import { CursorAgent } from './cursor.js';
import { CustomAgent } from './custom.js';

export type { AgentAdapter, AgentEvent, HookResult } from './types.js';

export type Agents = Map<AgentId, AgentAdapter>;

/** One adapter per configured agent, with its hook settings written to the office's data dir. */
export function createAgents(cfg: Partial<Record<AgentId, AgentConfig>>, dataDir: string): Agents {
  const agents: Agents = new Map();
  if (cfg.claude) agents.set('claude', new ClaudeAgent(cfg.claude.cmd, cfg.claude.args));
  if (cfg.cursor) agents.set('cursor', new CursorAgent(cfg.cursor.cmd, cfg.cursor.args));
  if (cfg.custom) agents.set('custom', new CustomAgent(cfg.custom.cmd, cfg.custom.args));
  for (const a of agents.values()) a.install(dataDir);
  return agents;
}

export function agentOptions(agents: Agents): AgentOption[] {
  return [...agents.values()].map((a) => ({
    id: a.id,
    label: a.label,
    badge: a.badge,
    badgeColor: a.badgeColor,
    cmd: [a.cmd, ...a.extraArgs].join(' '),
    available: a.path !== null,
  }));
}

/** The agent's command line for the startup banner. */
export function describeAgent(a: AgentAdapter): string {
  return [a.path ?? `${a.cmd} (not found)`, ...a.extraArgs].join(' ');
}
