import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidModel, isValidOpenCodeModel, withoutModelFlag } from '../src/server/agents.js';
import { createOpenCodeModelCatalogue, fetchCursorModels, fetchOpenCodeModels, type ModelCommandRunner } from '../src/server/models.js';

test('OpenCode model ids require provider/model and reject whitespace or control characters', () => {
  assert.equal(isValidOpenCodeModel('openai/gpt-5'), true);
  assert.equal(isValidOpenCodeModel('openrouter/deepseek/deepseek-r1'), true);
  assert.equal(isValidOpenCodeModel('gpt-5'), false);
  assert.equal(isValidOpenCodeModel('openai/gpt 5'), false);
  assert.equal(isValidOpenCodeModel('openai/gpt\n5'), false);
  assert.equal(isValidOpenCodeModel(`openai/${'x'.repeat(256)}`), false);
});

test('OpenCode catalogue invokes only the configured executable with bounded execFile options', async () => {
  let call: { file: string; args: string[]; options: Record<string, unknown> } | undefined;
  const runner: ModelCommandRunner = async (file, args, options) => {
    call = { file, args, options };
    return { stdout: 'openai/gpt-5\nopenrouter/deepseek/deepseek-r1\nopenai/gpt-5\n', stderr: 'private detail' };
  };
  assert.deepEqual(await fetchOpenCodeModels('/custom/opencode', '/project', runner), ['openai/gpt-5', 'openrouter/deepseek/deepseek-r1']);
  assert.deepEqual(call, {
    file: '/custom/opencode',
    args: ['models'],
    options: { cwd: '/project', timeout: 10_000, maxBuffer: 1024 * 1024 },
  });
});

test('OpenCode catalogue coalesces requests and caches successful results briefly', async () => {
  let calls = 0;
  let now = 1000;
  const runner: ModelCommandRunner = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { stdout: 'anthropic/claude-sonnet-4\n', stderr: '' };
  };
  const catalogue = createOpenCodeModelCatalogue('/opencode', '/project', runner, () => now);
  const [a, b] = await Promise.all([catalogue.get(), catalogue.get()]);
  assert.deepEqual(a, ['anthropic/claude-sonnet-4']);
  assert.deepEqual(b, a);
  assert.equal(calls, 1);
  now += 59_999;
  await catalogue.get();
  assert.equal(calls, 1);
  now += 2;
  await catalogue.get();
  assert.equal(calls, 2);
});

test('OpenCode catalogue errors do not expose command output', async () => {
  const runner: ModelCommandRunner = async () => {
    throw new Error('secret-token from stderr');
  };
  await assert.rejects(fetchOpenCodeModels('opencode', '/project', runner), /unavailable/i);
  await assert.rejects(createOpenCodeModelCatalogue('opencode', '/project', runner).get(), (error: unknown) => {
    return error instanceof Error && /unavailable/i.test(error.message) && !error.message.includes('secret-token');
  });
});

test('model ids for other providers are argv-safe and keep Cursor parameter brackets', () => {
  assert.equal(isValidModel('claude', 'opus'), true);
  assert.equal(isValidModel('claude', 'claude-opus-5-5'), true);
  assert.equal(isValidModel('cursor', "claude-opus-4-8[context=1m,effort=high]"), true);
  assert.equal(isValidModel('codex', 'gpt-5-codex'), true);
  assert.equal(isValidModel('claude', '--dangerously-skip-permissions'), false);
  assert.equal(isValidModel('cursor', 'gpt 5'), false);
  assert.equal(isValidModel('codex', ''), false);
  assert.equal(isValidModel('custom', 'anything'), false);
  assert.equal(isValidModel(undefined, 'opus'), false);
  assert.equal(isValidModel('opencode', 'gpt-5'), false);
});

test('model flags from --agent-args are removed in every form the provider understands', () => {
  const args = ['--model', 'a', '--keep', '--model=b', '-m', 'c', '-md', '--mode', 'plan'];
  assert.deepEqual(withoutModelFlag('codex', args), ['--keep', '--mode', 'plan']);
  // Claude and Cursor have no -m, so it isn't theirs to remove.
  assert.deepEqual(withoutModelFlag('cursor', args), ['--keep', '-m', 'c', '-md', '--mode', 'plan']);
  assert.deepEqual(withoutModelFlag('custom', args), args);
});

test('Cursor catalogue reads the ids from `cursor-agent models` and skips the header and tip', async () => {
  let call: { file: string; args: string[] } | undefined;
  const runner: ModelCommandRunner = async (file, args) => {
    call = { file, args };
    return {
      stdout: '\x1b[1mAvailable models\x1b[0m\n\nauto - Auto (default)\ngpt-5.3-codex - Codex 5.3\nauto - Auto (default)\n\nTip: use --model <id> (or /model <id> in interactive mode) to switch.\n',
      stderr: '',
    };
  };
  assert.deepEqual(await fetchCursorModels('/bin/cursor-agent', '/project', runner), ['auto', 'gpt-5.3-codex']);
  assert.deepEqual(call, { file: '/bin/cursor-agent', args: ['models'] });
  await assert.rejects(fetchCursorModels('cursor-agent', '/project', async () => { throw new Error('secret'); }), /Cursor model catalogue unavailable/);
});
