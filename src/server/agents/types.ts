import type { AgentId, Usage } from '../../shared/protocol.js';

/**
 * What an agent's hooks tell the office, in one vocabulary for every agent. The worker's status
 * machine (WorkerManager.applyEvent) runs on these, so Claude and Cursor workers behave the same.
 */
export type AgentEvent =
  /** A conversation began; `clear` when it replaced the old one (/clear). */
  | { type: 'sessionStart'; clear?: boolean }
  | { type: 'promptSubmit'; prompt?: string }
  | { type: 'toolStart'; label: string }
  /** The agent asked the human a question (Claude's AskUserQuestion). */
  | { type: 'askUser' }
  | { type: 'toolEnd' }
  /** The agent is waiting for a human to approve a tool. */
  | { type: 'permissionRequest'; label: string }
  /** Claude's permission_prompt notification: may arrive late, after the prompt was answered. */
  | { type: 'permissionNotice' }
  /** The agent has been sitting at its prompt (Claude's idle_prompt notification). */
  | { type: 'idle' }
  /** The turn ended: finished, interrupted or failed. */
  | { type: 'stop' };

export interface HookResult {
  sessionId?: string;
  /** Transcript to read usage from (agents with transcriptUsage). */
  transcript?: string;
  events: AgentEvent[];
  /** Tokens this event reports itself (Cursor's stop hook). `key` makes a repeated delivery count once. */
  usage?: { key: string; usage: Usage };
}

export interface ScreenRules {
  /** A first-run screen (trust, onboarding) it shows before it can take a prompt. */
  setup?: RegExp;
  loggedOut?: RegExp;
  /** What the worker's card says while it's logged out. */
  loginHint: string;
  /** Its prompt bar is up: for agents whose hooks don't say when it's ready (bootViaHook false). */
  ready?: RegExp;
  /** An approval prompt is open, for agents with no hook that says so. */
  approval?: RegExp;
}

export interface LaunchOpts {
  prompt?: string;
  resumeId?: string;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly label: string;
  readonly badge: string;
  readonly badgeColor: string;
  readonly cmd: string;
  /** Extra args from the office's config. */
  readonly extraArgs: string[];
  /** Resolved binary, or null when it isn't on this machine (a login shell may still find it). */
  readonly path: string | null;
  /** Has hooks at all. Without them the worker is a plain terminal: idle, never working or done. */
  readonly hooks: boolean;
  /** A hook fires as soon as it can take input; still silent after a while means it's blocked. */
  readonly bootViaHook: boolean;
  /** Emits OSC 9;4 progress, which then drives working/done too (catches turns with no Stop hook). */
  readonly trustsProgress: boolean;
  /** Reads spend from the session transcript (Claude) rather than from hooks. */
  readonly transcriptUsage: boolean;
  /** Resuming a conversation it no longer has makes it exit at once; start a fresh one then. */
  readonly resumeExitsEarly: boolean;
  /** Terminal titles that just name the agent, not the task. */
  readonly titleIgnore?: RegExp;
  readonly screen: ScreenRules;
  /** Called once when the office starts: write hook settings and the like. */
  install(dataDir: string): void;
  /** Makes a session up front so its id is known before launch (and resume always works). */
  newSession?(cwd: string, env: Record<string, string>): Promise<string | undefined>;
  args(o: LaunchOpts): string[];
  parseHook(event: string, payload: any): HookResult;
}
