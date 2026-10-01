// Cursor: a plugin the office writes and loads per worker with --plugin-dir (see ../cursor.ts), so
// nothing in ~/.cursor is touched. It reports on /hooks/cursor. It has no hook for "ready" or
// "waiting for approval": both are read off its screen (see watch). Its stop hook reports each
// turn's tokens, a running total of which is kept as an estimate outside the office budget.
import { CURSOR_APPROVAL, CURSOR_LOGGED_OUT, CURSOR_READY, CURSOR_SETUP, CURSOR_TITLE, cursorArgs, normalizeCursorHook, writeCursorPlugin } from '../cursor.js';
import { addUsage, zeroUsage } from '../usage.js';
import type { WorkerHandle } from '../workers/types.js';
import { truncate } from '../workers/util.js';
import { withModel } from './model-args.js';
import type { ProviderAdapter } from './types.js';

interface CursorState {
  /** Turns whose tokens are already counted (its stop hook can arrive twice). */
  turns: string[];
  /** Its approval prompt is on screen: it's waiting on a human (it has no hook for that). */
  approval?: boolean;
  /** Its latest tool, to say what an approval prompt is about. */
  lastTool?: string;
}

interface CursorSetup {
  plugin: string;
}

function cursorHook(h: WorkerHandle<CursorState>, event: string, payload: unknown): boolean {
  const report = normalizeCursorHook(event, payload);
  if (!report) return false;
  const { info, state: s } = h;
  // Another conversation in the same terminal (/new): a new task and fresh totals.
  if (info.sessionId !== report.sessionId) {
    if (info.sessionId) {
      h.clearTask();
      info.usage = undefined;
      s.turns = [];
    }
    info.sessionId = report.sessionId;
    h.persist();
  }
  h.bootBlocked = false;
  switch (report.event) {
    case 'sessionStart':
      if (info.status === 'starting') h.setStatus('idle');
      break;
    case 'beforeSubmitPrompt':
      s.approval = false;
      if (report.prompt) {
        info.activity = truncate(report.prompt, 80);
        h.notePrompt(report.prompt);
      }
      h.setStatus('working');
      break;
    case 'preToolUse':
    case 'afterFileEdit':
      if (report.tool) {
        info.activity = truncate(report.tool, 80);
        s.lastTool = report.tool;
        h.noteTool(report.tool);
      }
      if (!s.approval) h.setStatus('working');
      break;
    case 'postToolUse':
    case 'postToolUseFailure':
      if (s.approval) {
        s.approval = false;
        h.leftNeedsInputAt = Date.now();
      }
      h.setStatus('working');
      break;
    case 'stop':
      s.approval = false;
      if (report.usage && !(report.generationId && s.turns.includes(report.generationId))) {
        if (report.generationId) s.turns = [...s.turns, report.generationId].slice(-50);
        info.usage = addUsage(info.usage ?? zeroUsage(), report.usage);
        info.usage.costKnown = true;
      }
      h.setStatus('done');
      break;
  }
  h.emit();
  h.persist();
  return true;
}

/**
 * Its screen says what its hooks don't: that it's up and taking input, stuck on a trust or login
 * screen, or waiting for someone to approve a tool.
 */
function watch(h: WorkerHandle<CursorState>, text: string) {
  const { info, state: s } = h;
  const status = info.status;
  // Only the bottom of what's drawn holds the prompt bar or an open approval: older output doesn't count.
  const bottom = text.replace(/\s+$/, '').split('\n').slice(-16).join('\n');
  if (status === 'working' || s.approval) {
    const open = CURSOR_APPROVAL.test(bottom);
    if (open && !s.approval) {
      s.approval = true;
      info.activity = `Wants permission: ${s.lastTool ?? 'a tool'}`;
      h.setStatus('needs_input');
    } else if (!open && s.approval) {
      s.approval = false;
      if (status === 'needs_input') h.setStatus('working');
    }
    return;
  }
  if (status !== 'starting' && status !== 'idle' && !(h.bootBlocked && status === 'needs_input')) return;
  const loggedOut = CURSOR_LOGGED_OUT.test(text);
  const blocked = loggedOut || (CURSOR_SETUP.test(text) && (status === 'starting' || h.bootBlocked));
  if (blocked && status !== 'needs_input') {
    h.bootBlocked = true;
    info.activity = loggedOut
      ? "Cursor isn't signed in on this machine — open the terminal and follow the login link"
      : 'Waiting on a setup prompt (trust / login) — open the terminal';
    h.setStatus('needs_input');
  } else if (!blocked && h.bootBlocked && status === 'needs_input') {
    h.bootBlocked = false;
    info.activity = undefined;
    h.setStatus('idle');
  } else if (!blocked && status === 'starting' && CURSOR_READY.test(bottom)) {
    h.setStatus('idle');
  }
}

export const cursor: ProviderAdapter<CursorState, CursorSetup> = {
  id: 'cursor',
  createState: () => ({ turns: [] }),
  prepare: ({ dataDir }) => ({ plugin: writeCursorPlugin(dataDir) }),
  launch({ h, args, prompt, resumeSessionId, setup }) {
    const { info } = h;
    // The worker's model replaces any in --agent-args, and goes in again on a resume: Cursor doesn't remember it.
    if (info.model) args = withModel(args, info.model);
    h.state.approval = false;
    return { args: cursorArgs(setup.plugin, args, resumeSessionId, prompt), rotateToken: true };
  },
  bootHint: 'Open the terminal: complete login or the trust prompt if Cursor asks',
  titleNoise: CURSOR_TITLE,
  hook: { strictJson: true, handle: cursorHook },
  screen: { watch },
  usage: { persisted: true },
};
