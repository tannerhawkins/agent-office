import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Usage } from '../shared/protocol.js';
import { priceOf } from './usage.js';

// Cursor's CLI (`cursor-agent`). How it behaves, and how that was found: docs/cursor-agent-notes.md.
// Its hooks come from a plugin the office writes and loads per worker with --plugin-dir, so nothing
// in ~/.cursor is touched. It has no hook for "ready" or "waiting for approval": both are read off
// its screen (CURSOR_READY, CURSOR_APPROVAL). Its stop hook reports each turn's tokens.

export const CURSOR_HOOK_EVENTS = [
  'sessionStart',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'afterFileEdit',
  'stop',
] as const;

export type CursorHookEventName = (typeof CURSOR_HOOK_EVENTS)[number];

/** The bounded event shape forwarded to the worker bridge. */
export interface CursorHookEvent {
  sessionId: string;
  event: CursorHookEventName;
  prompt?: string;
  tool?: string;
  toolUseId?: string;
  /** stop: completed, aborted or error. */
  status?: string;
  /** Identifies the turn, so a repeated stop is counted once. */
  generationId?: string;
  /** stop: this turn's tokens, priced as an estimate. */
  usage?: Usage;
}

/** The prompt bar is up: Cursor can take input. */
export const CURSOR_READY = /→ (Plan, search, build anything|Add a follow-up)/;
/** A tool is waiting for a human to approve it. */
export const CURSOR_APPROVAL = /Waiting for approval\.\.\.|Run this command\?|Skip & tell the agent what to do instead/;
export const CURSOR_SETUP = /Workspace Trust Required|Do you trust the contents of this directory/i;
export const CURSOR_LOGGED_OUT = /Press any key to log in|Signing in with the browser|Not logged in/i;
/** Its own name as a terminal title, which says nothing about the task. */
export const CURSOR_TITLE = /^cursor agent$/i;

const EVENT_SET = new Set<string>(CURSOR_HOOK_EVENTS);
const MAX_ID = 160;
const MAX_TEXT = 20_000;

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** What a tool call is about, from Cursor's tool vocabulary (Shell, Read, Grep, Glob, Edit...). */
function describeTool(name: string, input: unknown): string {
  const i = isRecord(input) ? input : {};
  const detail = [i.command, i.pattern, i.glob_pattern, i.path, i.file_path, i.target_file, i.url, i.query, i.description].find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
  const text = (detail ? `${name}: ${detail}` : name).replace(/\s+/g, ' ').trim();
  return text.length > MAX_ID ? `${text.slice(0, MAX_ID - 1)}…` : text;
}

/**
 * Validate and compact a Cursor hook payload. Unknown fields and message bodies are dropped; a
 * payload without a conversation id is refused.
 */
export function normalizeCursorHook(event: string, payload: unknown): CursorHookEvent | undefined {
  if (!EVENT_SET.has(event) || !isRecord(payload)) return undefined;
  const sessionId = bounded(payload.conversation_id, MAX_ID) ?? bounded(payload.session_id, MAX_ID);
  if (!sessionId) return undefined;
  const result: CursorHookEvent = { sessionId, event: event as CursorHookEventName };
  const generationId = bounded(payload.generation_id, MAX_ID);
  if (generationId) result.generationId = generationId;
  if (event === 'beforeSubmitPrompt') {
    const prompt = bounded(payload.prompt, MAX_TEXT);
    if (prompt) result.prompt = prompt;
  } else if (event === 'preToolUse' || event === 'postToolUse' || event === 'postToolUseFailure') {
    const name = bounded(payload.tool_name, MAX_ID);
    if (name) result.tool = describeTool(name, payload.tool_input);
    const toolUseId = bounded(payload.tool_use_id, MAX_ID);
    if (toolUseId) result.toolUseId = toolUseId;
  } else if (event === 'afterFileEdit') {
    const file = bounded(payload.file_path, 4096);
    if (file) result.tool = describeTool('Edit', { file_path: file });
  } else if (event === 'stop') {
    const status = bounded(payload.status, MAX_ID);
    if (status) result.status = status;
    const usage = cursorTurnUsage(typeof payload.model === 'string' ? payload.model : '', payload);
    if (usage) result.usage = usage;
  }
  return result;
}

/**
 * USD per million tokens — [input, output, cache read] — for the models Cursor offers, by their
 * providers' list prices. Rough on purpose: Cursor bills through its own plans, so this is only a
 * feel for the spend and always shown as an estimate. Claude models use usage.ts's own table;
 * anything unknown (including "auto") gets the dearest row here.
 */
const CURSOR_PRICES: [RegExp, [number, number, number]][] = [
  [/gemini.*flash/, [0.3, 2.5, 0.03]],
  [/gemini/, [1.25, 10, 0.125]],
  [/grok/, [3, 15, 0.75]],
  [/composer/, [1.25, 10, 0.125]],
  [/gpt|codex|\bo\d/, [1.25, 10, 0.125]],
];
const CURSOR_UNKNOWN: [number, number, number] = [3, 15, 0.75];

export function cursorPriceOf(model: string): [number, number, number] {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(m)) return priceOf(m);
  return CURSOR_PRICES.find(([re]) => re.test(m))?.[1] ?? CURSOR_UNKNOWN;
}

const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0);

/** One turn's tokens from Cursor's stop hook, priced as an estimate. Undefined when it reports none. */
export function cursorTurnUsage(model: string, p: Record<string, unknown>): Usage | undefined {
  const total = count(p.input_tokens);
  const output = count(p.output_tokens);
  const cacheRead = count(p.cache_read_tokens);
  const cacheWrite = count(p.cache_write_tokens);
  if (!total && !output) return undefined;
  // Cursor's input count includes the tokens read from the cache.
  const input = Math.max(0, total - cacheRead);
  const [pin, pout, pread] = cursorPriceOf(model);
  const cost = (input * pin + output * pout + cacheWrite * pin * 1.25 + cacheRead * pread) / 1e6;
  return { input, output, cacheWrite, cacheRead, cost, calls: 1, costKnown: true };
}

/** The worker's command line: office hooks, trust (the office already chose this directory), resume, prompt. */
export function cursorArgs(pluginDir: string, extra: string[], resumeId?: string, prompt?: string): string[] {
  const args = ['--trust', '--plugin-dir', pluginDir, ...extra];
  if (resumeId) args.push('--resume', resumeId);
  // `--` so a prompt like "- fix login" is never parsed as a CLI option.
  if (prompt) args.push('--', prompt);
  return args;
}

/** Writes the plugin Cursor loads with --plugin-dir: a manifest, and hooks that run the bridge helper. */
export function writeCursorPlugin(dataDir: string): string {
  const dir = path.join(dataDir, 'cursor-plugin');
  mkdirSync(path.join(dir, '.cursor-plugin'), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dir, 'hooks'), { recursive: true, mode: 0o700 });
  const helper = path.join(dir, 'agent-office-cursor-hook.cjs');
  writeFileSync(helper, CURSOR_HOOK_SOURCE, { mode: 0o600 });
  chmodSync(helper, 0o600);
  const manifest = { name: 'agent-office', description: 'Reports worker status to Agent Office', version: '1.0.0', author: { name: 'Agent Office' } };
  writeFileSync(path.join(dir, '.cursor-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const hooks: Record<string, unknown[]> = {};
  for (const event of CURSOR_HOOK_EVENTS) {
    const command = [process.execPath, helper, event].map(shellQuote).join(' ');
    hooks[event] = [{ command, timeout: 5 }];
  }
  writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ version: 1, hooks }, null, 2), { mode: 0o600 });
  return dir;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/**
 * The helper Cursor's hooks run. It forwards a bounded subset of the payload to the office and
 * prints nothing: Cursor reads a hook's output as a permission answer, and this must never give one.
 */
export const CURSOR_HOOK_SOURCE = String.raw`'use strict';
const MAX = 256 * 1024;
const event = process.argv[2];
let size = 0;
let overflow = false;
const chunks = [];
process.stdin.on('data', (chunk) => {
  if (overflow) return;
  size += chunk.length;
  if (size > MAX) { overflow = true; return; }
  chunks.push(chunk);
});
process.stdin.on('end', async () => {
  const base = process.env.AGENT_OFFICE_HOOK_URL;
  const token = process.env.AGENT_OFFICE_HOOK_TOKEN;
  const worker = process.env.AGENT_OFFICE_WORKER_ID;
  if (overflow || !base || !token || !worker || !event) return;
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const keep = ['conversation_id', 'session_id', 'generation_id', 'model', 'prompt', 'tool_name', 'tool_input', 'tool_use_id', 'file_path', 'status',
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
  const body = {};
  for (const k of keep) if (input[k] !== undefined) body[k] = input[k];
  if (body.tool_input && typeof body.tool_input === 'object') {
    const t = body.tool_input;
    const small = {};
    for (const k of ['command', 'pattern', 'glob_pattern', 'path', 'file_path', 'target_file', 'url', 'query', 'description']) {
      if (typeof t[k] === 'string') small[k] = t[k].slice(0, 500);
    }
    body.tool_input = small;
  }
  const send = async (tries) => {
    try {
      const url = new URL('/hooks/cursor', base);
      url.searchParams.set('worker', worker);
      url.searchParams.set('event', event);
      await fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      });
    } catch (err) {
      // The office restarting (a dev reload): try again a few times.
      if (tries > 1) { await new Promise((r) => setTimeout(r, 1000)); return send(tries - 1); }
    }
  };
  await send(4);
});
`;
