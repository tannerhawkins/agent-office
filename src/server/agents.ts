import path from 'node:path';
import type { AgentProvider } from '../shared/protocol.js';

export const MODEL_MAX = 256;
/** @deprecated The limit is the same for every provider; use MODEL_MAX. */
export const OPEN_CODE_MODEL_MAX = MODEL_MAX;

/**
 * Finds the provider represented by the configured executable.  Keep this deliberately based on
 * the final path component: --agent may be an absolute path, and Windows paths can be supplied
 * while the office itself is running under a POSIX shell.
 */
export function configuredProvider(command: string): AgentProvider {
  const base = path.basename(command.replaceAll('\\', '/')).toLowerCase().replace(/\.exe$/, '');
  if (base === 'claude') return 'claude';
  if (base === 'opencode') return 'opencode';
  if (base === 'codex') return 'codex';
  if (base === 'cursor-agent') return 'cursor';
  return 'custom';
}

/** The CLI a provider runs when it isn't the configured --agent. Cursor's is not called `cursor`: that opens the editor. */
export function providerCommand(provider: AgentProvider): string {
  return provider === 'cursor' ? 'cursor-agent' : provider;
}

/**
 * How each provider takes a model on its command line: the long flag, and the short one it also
 * understands (so a copy in --agent-args can be replaced). A provider without an entry can't pick one.
 */
export const MODEL_FLAGS: Partial<Record<AgentProvider, { long: string; short?: string }>> = {
  claude: { long: '--model' },
  opencode: { long: '--model', short: '-m' },
  codex: { long: '--model', short: '-m' },
  cursor: { long: '--model' },
};

/** The models the office suggests for a provider that can't list its own. */
export const MODEL_SUGGESTIONS: Partial<Record<AgentProvider, string[]>> = {
  claude: ['opus', 'sonnet', 'haiku', 'fable'],
};

/** OpenCode model ids are argv values, so reject anything that could be ambiguous or unsafe. */
export function isValidOpenCodeModel(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MODEL_MAX) return false;
  if (/[\s\p{Cc}\p{Cf}]/u.test(value)) return false;
  const parts = value.split('/');
  return parts.length >= 2 && /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(parts[0]) && parts.slice(1).every((part) => part.length > 0);
}

/**
 * Whether `value` is a model id `provider` can be started with. Ids are argv values: no whitespace
 * or control characters, and no leading `-` that would read as an option. Cursor's parameterized
 * models (`gpt-5[reasoning=high]`) keep their brackets.
 */
export function isValidModel(provider: AgentProvider | undefined, value: unknown): value is string {
  if (!provider || !MODEL_FLAGS[provider]) return false;
  if (provider === 'opencode') return isValidOpenCodeModel(value);
  if (typeof value !== 'string' || value.length === 0 || value.length > MODEL_MAX) return false;
  return !/[\s\p{Cc}\p{Cf}]/u.test(value) && !value.startsWith('-');
}

export function validateWorkerModel(kind: 'agent' | 'shell', provider: AgentProvider | undefined, model: unknown): string | undefined {
  if (model === undefined) return undefined;
  if (kind === 'shell') return 'Shell workers do not have a model';
  if (!provider || !MODEL_FLAGS[provider]) return 'This provider cannot pick a model';
  if (provider === 'opencode' && !isValidOpenCodeModel(model)) return 'Invalid OpenCode model (expected provider/model without whitespace)';
  if (!isValidModel(provider, model)) return 'Invalid model (no whitespace or control characters, and it cannot start with "-")';
  return undefined;
}

/** `args` without any model flag (and its value) the provider understands, so the worker's own can go in. */
export function withoutModelFlag(provider: AgentProvider, args: string[]): string[] {
  const flag = MODEL_FLAGS[provider];
  if (!flag) return args;
  const clean: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag.long || arg === flag.short) {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (arg.startsWith(`${flag.long}=`) || (flag.short && arg.startsWith(flag.short) && !arg.startsWith('--') && arg.length > flag.short.length)) continue;
    clean.push(arg);
  }
  return clean;
}
