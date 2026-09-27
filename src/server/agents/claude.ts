import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentAdapter, AgentEvent, HookResult, LaunchOpts } from './types.js';
import { hookCommand, writeNodeHook } from './hook.js';
import { resolveCommand, truncate } from './util.js';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest', 'PreToolUse', 'PostToolUse'];

/** Claude Code: hooks come in through a --settings file the office writes, spend from its transcript. */
export class ClaudeAgent implements AgentAdapter {
  readonly id = 'claude' as const;
  readonly label = 'Claude Code';
  readonly badge = 'C';
  readonly badgeColor = '#d97757';
  readonly path: string | null;
  readonly hooks = true;
  readonly bootViaHook = true;
  readonly trustsProgress = true;
  readonly transcriptUsage = true;
  readonly resumeExitsEarly = true;
  readonly titleIgnore = /^claude( code)?$/i;
  readonly screen = {
    setup: /trust this folder|Do you trust the files|Select login method|Choose the text style|Press Enter to continue|Bypass Permissions mode/i,
    loggedOut: /Not logged in\s*·\s*Run \/login|Invalid API key|Please run \/login/i,
    loginHint: "Claude isn't signed in on this machine — open the terminal and type /login",
  };
  private settingsPath = '';

  constructor(
    readonly cmd: string,
    readonly extraArgs: string[],
  ) {
    this.path = resolveCommand(cmd);
  }

  install(dataDir: string) {
    const nodeHook = writeNodeHook(dataDir);
    const hooks: Record<string, unknown[]> = {};
    for (const event of EVENTS) hooks[event] = [{ hooks: [{ type: 'command', command: hookCommand(this.id, event, nodeHook) }] }];
    this.settingsPath = path.join(dataDir, 'claude-hooks.json');
    writeFileSync(this.settingsPath, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
  }

  args({ prompt, resumeId }: LaunchOpts): string[] {
    const args = ['--settings', this.settingsPath, ...this.extraArgs];
    if (resumeId) args.push('--resume', resumeId);
    // `--` so a prompt like "- fix login" is never parsed as a CLI option.
    if (prompt) args.push('--', prompt);
    return args;
  }

  parseHook(event: string, payload: any): HookResult {
    const events: AgentEvent[] = [];
    switch (event) {
      case 'SessionStart':
        events.push({ type: 'sessionStart', clear: payload?.source === 'clear' });
        break;
      case 'UserPromptSubmit':
        events.push({ type: 'promptSubmit', prompt: typeof payload?.prompt === 'string' ? payload.prompt : undefined });
        break;
      case 'PreToolUse':
        events.push(payload?.tool_name === 'AskUserQuestion' ? { type: 'askUser' } : { type: 'toolStart', label: describeTool(payload) });
        break;
      case 'PostToolUse':
        events.push({ type: 'toolEnd' });
        break;
      case 'PermissionRequest':
        events.push({ type: 'permissionRequest', label: describeTool(payload) });
        break;
      case 'Notification':
        if (payload?.notification_type === 'permission_prompt') events.push({ type: 'permissionNotice' });
        else if (payload?.notification_type === 'idle_prompt') events.push({ type: 'idle' });
        break;
      case 'Stop':
        events.push({ type: 'stop' });
        break;
    }
    return {
      sessionId: typeof payload?.session_id === 'string' && payload.session_id ? payload.session_id : undefined,
      transcript: typeof payload?.transcript_path === 'string' ? payload.transcript_path : undefined,
      events,
    };
  }
}

function describeTool(payload: any): string {
  const name = payload?.tool_name ?? 'tool';
  const input = payload?.tool_input ?? {};
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? '';
  return truncate(detail ? `${name}: ${detail}` : String(name), 80);
}
