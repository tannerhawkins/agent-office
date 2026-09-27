import { mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { AgentAdapter, AgentEvent, HookResult, LaunchOpts } from './types.js';
import { hookCommand, writeNodeHook } from './hook.js';
import { resolveCommand, truncate } from './util.js';
import { cursorTurnUsage } from '../usage.js';

// How Cursor's CLI behaves, and how these were found: docs/cursor-agent-notes.md.
const EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'afterFileEdit', 'stop'];
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/**
 * Cursor's CLI (`cursor-agent`). Its hooks come from a plugin the office writes and loads with
 * --plugin-dir, so nothing in ~/.cursor is touched. It has no permission hook, so an open approval
 * prompt is spotted on its screen; its stop hook reports each turn's tokens, which are priced here.
 */
export class CursorAgent implements AgentAdapter {
  readonly id = 'cursor' as const;
  readonly label = 'Cursor';
  readonly badge = 'Cu';
  readonly badgeColor = '#1e1e1e';
  readonly path: string | null;
  readonly hooks = true;
  // sessionStart only fires with the first prompt, never when idle at boot or on resume.
  readonly bootViaHook = false;
  readonly trustsProgress = false;
  readonly transcriptUsage = false;
  // An unknown --resume id just opens a fresh chat.
  readonly resumeExitsEarly = false;
  readonly titleIgnore = /^cursor agent$/i;
  readonly screen = {
    setup: /Workspace Trust Required|Do you trust the contents of this directory/i,
    loggedOut: /Press any key to log in|Signing in with the browser|Not logged in/i,
    loginHint: "Cursor isn't signed in on this machine — open the terminal and follow the login link",
    ready: /→ (Plan, search, build anything|Add a follow-up)/,
    approval: /Waiting for approval\.\.\.|Run this command\?|Skip & tell the agent what to do instead/,
  };
  private pluginDir = '';

  constructor(
    readonly cmd: string,
    readonly extraArgs: string[],
  ) {
    this.path = resolveCommand(cmd);
  }

  install(dataDir: string) {
    const nodeHook = writeNodeHook(dataDir);
    this.pluginDir = path.join(dataDir, 'cursor-plugin');
    mkdirSync(path.join(this.pluginDir, '.cursor-plugin'), { recursive: true });
    mkdirSync(path.join(this.pluginDir, 'hooks'), { recursive: true });
    const manifest = { name: 'agent-office', description: 'Reports worker status to Agent Office', version: '1.0.0', author: { name: 'Agent Office' } };
    writeFileSync(path.join(this.pluginDir, '.cursor-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
    const hooks: Record<string, unknown[]> = {};
    for (const event of EVENTS) hooks[event] = [{ command: hookCommand(this.id, event, nodeHook), timeout: 5 }];
    writeFileSync(path.join(this.pluginDir, 'hooks', 'hooks.json'), JSON.stringify({ version: 1, hooks }, null, 2), { mode: 0o600 });
  }

  newSession(cwd: string, env: Record<string, string>): Promise<string | undefined> {
    return new Promise((resolve) => {
      execFile(this.path ?? this.cmd, ['create-chat'], { cwd, env, encoding: 'utf8', timeout: 20_000 }, (err, stdout) => {
        resolve(err ? undefined : UUID.exec(stdout)?.[0]);
      });
    });
  }

  args({ prompt, resumeId }: LaunchOpts): string[] {
    // --trust: the office already decided this directory is the project; its trust screen would only block.
    const args = ['--trust', '--plugin-dir', this.pluginDir, ...this.extraArgs];
    if (resumeId) args.push('--resume', resumeId);
    if (prompt) args.push('--', prompt);
    return args;
  }

  parseHook(event: string, payload: any): HookResult {
    const events: AgentEvent[] = [];
    let usage: HookResult['usage'];
    switch (event) {
      case 'sessionStart':
        events.push({ type: 'sessionStart' });
        break;
      case 'beforeSubmitPrompt':
        events.push({ type: 'promptSubmit', prompt: typeof payload?.prompt === 'string' ? payload.prompt : undefined });
        break;
      case 'preToolUse':
        events.push({ type: 'toolStart', label: describeTool(payload) });
        break;
      case 'postToolUse':
      case 'postToolUseFailure':
        events.push({ type: 'toolEnd' });
        break;
      case 'afterFileEdit':
        if (typeof payload?.file_path === 'string') events.push({ type: 'toolStart', label: truncate(`Edit: ${payload.file_path}`, 80) });
        break;
      case 'stop': {
        events.push({ type: 'stop' });
        const u = cursorTurnUsage(String(payload?.model ?? ''), payload);
        if (u) usage = { key: String(payload?.generation_id ?? ''), usage: u };
        break;
      }
    }
    const id = payload?.conversation_id ?? payload?.session_id;
    return { sessionId: typeof id === 'string' && id ? id : undefined, events, usage };
  }
}

function describeTool(payload: any): string {
  const name = payload?.tool_name ?? 'tool';
  const input = payload?.tool_input ?? {};
  const detail = input.command ?? input.pattern ?? input.glob_pattern ?? input.path ?? input.file_path ?? input.target_file ?? input.url ?? input.query ?? input.description ?? '';
  return truncate(detail ? `${name}: ${detail}` : String(name), 80);
}
