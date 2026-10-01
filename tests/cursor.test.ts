import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CURSOR_APPROVAL,
  CURSOR_HOOK_EVENTS,
  CURSOR_LOGGED_OUT,
  CURSOR_READY,
  CURSOR_SETUP,
  cursorArgs,
  cursorPriceOf,
  cursorTurnUsage,
  normalizeCursorHook,
  writeCursorPlugin,
} from '../src/server/cursor.js';
import { configuredProvider, providerCommand } from '../src/server/agents.js';

test('cursor-agent is its own provider and runs as cursor-agent, never the editor', () => {
  assert.equal(configuredProvider('/Users/me/.local/bin/cursor-agent'), 'cursor');
  assert.equal(configuredProvider('cursor'), 'custom');
  assert.equal(providerCommand('cursor', 'claude'), 'cursor-agent');
  assert.equal(providerCommand('codex', 'claude'), 'codex');
});

test('Cursor hooks are bounded to known events and a conversation id', () => {
  assert.equal(normalizeCursorHook('sessionStart', {}), undefined);
  assert.equal(normalizeCursorHook('beforeShellExecution', { conversation_id: 'c1' }), undefined);
  assert.equal(normalizeCursorHook('stop', []), undefined);
  assert.deepEqual(normalizeCursorHook('beforeSubmitPrompt', { conversation_id: 'c1', generation_id: 'g1', prompt: ' fix it ', secret: 'x' }), {
    sessionId: 'c1',
    event: 'beforeSubmitPrompt',
    generationId: 'g1',
    prompt: 'fix it',
  });
  const tool = normalizeCursorHook('preToolUse', { session_id: 'c1', tool_name: 'Shell', tool_input: { command: 'npm test' }, tool_use_id: 't1' });
  assert.equal(tool?.tool, 'Shell: npm test');
  assert.equal(tool?.toolUseId, 't1');
  assert.equal(normalizeCursorHook('afterFileEdit', { conversation_id: 'c1', file_path: '/repo/a.ts' })?.tool, 'Edit: /repo/a.ts');
});

test("Cursor's stop hook turns into one priced turn; aborted turns carry no tokens", () => {
  // The numbers from a real turn (docs/cursor-agent-notes.md): input includes the cache reads.
  const stop = normalizeCursorHook('stop', {
    conversation_id: 'c1', generation_id: 'g1', status: 'completed', model: 'gpt-5.3-codex-low-fast',
    input_tokens: 36293, output_tokens: 248, cache_read_tokens: 16896, cache_write_tokens: 0,
  });
  assert.equal(stop?.status, 'completed');
  assert.deepEqual({ ...stop?.usage, cost: undefined }, { input: 19397, output: 248, cacheWrite: 0, cacheRead: 16896, cost: undefined, calls: 1, costKnown: true });
  assert.ok(stop!.usage!.cost > 0.02 && stop!.usage!.cost < 0.04);
  assert.equal(normalizeCursorHook('stop', { conversation_id: 'c1', status: 'aborted' })?.usage, undefined);
  assert.equal(cursorTurnUsage('x', { input_tokens: -5, output_tokens: 'lots' }), undefined);
  // Claude models are priced from the office's Claude table; unknown ones get the dearest row.
  assert.deepEqual(cursorPriceOf('claude-opus-5-5'), [4, 20, 0.2]);
  assert.deepEqual(cursorPriceOf('auto'), [3, 15, 0.75]);
});

test('Cursor workers trust the project, load the office plugin, and keep prompts out of option parsing', () => {
  assert.deepEqual(cursorArgs('/data/cursor-plugin', ['--model', 'x']), ['--trust', '--plugin-dir', '/data/cursor-plugin', '--model', 'x']);
  assert.deepEqual(cursorArgs('/p', [], 'chat-1', '- fix login'), ['--trust', '--plugin-dir', '/p', '--resume', 'chat-1', '--', '- fix login']);
});

test('what Cursor shows on screen is recognised (from a real session)', () => {
  assert.ok(CURSOR_READY.test('  → Plan, search, build anything'));
  assert.ok(CURSOR_READY.test('  → Add a follow-up                         ctrl+c to stop'));
  assert.ok(CURSOR_APPROVAL.test('  $ rm junk2.txt Waiting for approval...\n Run this command?\n Not in allowlist: rm'));
  assert.ok(!CURSOR_APPROVAL.test('  $ rm junk2.txt 218ms\n ⠠⠜ Running  89 tokens'));
  assert.ok(CURSOR_SETUP.test('  │  ⚠ Workspace Trust Required'));
  assert.ok(CURSOR_LOGGED_OUT.test('   Press any key to log in...'));
});

test('the plugin hooks every event and its helper forwards a bounded payload, printing nothing', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-cursor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plugin = writeCursorPlugin(dir);
  const manifest = JSON.parse(readFileSync(path.join(plugin, '.cursor-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-office');
  const hooks = JSON.parse(readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(hooks.version, 1);
  assert.deepEqual(Object.keys(hooks.hooks), [...CURSOR_HOOK_EVENTS]);

  const got: { url: string; auth?: string; body: any }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ url: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(body) });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const helper = path.join(plugin, 'agent-office-cursor-hook.cjs');
  const run = (env: Record<string, string>) =>
    new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [helper, 'preToolUse'], { env: { PATH: process.env.PATH ?? '', ...env } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('close', () => resolve(out));
      child.stdin.end(JSON.stringify({ conversation_id: 'c1', tool_name: 'Shell', tool_input: { command: 'ls', env: 'SECRET=1' }, user_email: 'me@example.com' }));
    });
  // Outside the office (no worker env) it does nothing.
  assert.equal(await run({}), '');
  assert.equal(got.length, 0);
  assert.equal(await run({ AGENT_OFFICE_HOOK_URL: `http://127.0.0.1:${port}`, AGENT_OFFICE_HOOK_TOKEN: 'tok', AGENT_OFFICE_WORKER_ID: 'w1' }), '');
  assert.equal(got.length, 1);
  assert.equal(got[0].url, '/hooks/cursor?worker=w1&event=preToolUse');
  assert.equal(got[0].auth, 'Bearer tok');
  assert.deepEqual(got[0].body, { conversation_id: 'c1', tool_name: 'Shell', tool_input: { command: 'ls' } });
});
