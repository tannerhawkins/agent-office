import { execFile as nodeExecFile } from 'node:child_process';
import { isValidModel, isValidOpenCodeModel } from './agents.js';

export const MODEL_COMMAND_TIMEOUT_MS = 10_000;
export const MODEL_COMMAND_MAX_BUFFER = 1024 * 1024;
export const MODEL_CACHE_TTL_MS = 60_000;

export interface ModelCommandOptions {
  cwd: string;
  timeout: number;
  maxBuffer: number;
}

export type ModelCommandRunner = (
  file: string,
  args: string[],
  options: ModelCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

const runModelCommand: ModelCommandRunner = (file, args, options) => new Promise((resolve, reject) => {
  nodeExecFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) return reject(error);
    resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});

/** Run `<command> models` without a shell and return its output's lines, bounded and colourless. */
async function modelLines(command: string, cwd: string, runner: ModelCommandRunner): Promise<string[]> {
  const result = await runner(command, ['models'], {
    cwd,
    timeout: MODEL_COMMAND_TIMEOUT_MS,
    maxBuffer: MODEL_COMMAND_MAX_BUFFER,
  });
  return result.stdout.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').split(/\r?\n/);
}

/** Run `opencode models` without a shell and return only safe, model-shaped lines. */
export async function fetchOpenCodeModels(command: string, cwd: string, runner: ModelCommandRunner = runModelCommand): Promise<string[]> {
  try {
    const models = new Set<string>();
    for (const raw of await modelLines(command, cwd, runner)) {
      const model = raw.trim().replace(/^[-*]\s+/, '');
      if (isValidOpenCodeModel(model)) models.add(model);
    }
    return [...models];
  } catch {
    throw new Error('OpenCode model catalogue unavailable');
  }
}

/** Run `cursor-agent models`, whose lines read `<id> - <label>`, and return the ids. */
export async function fetchCursorModels(command: string, cwd: string, runner: ModelCommandRunner = runModelCommand): Promise<string[]> {
  try {
    const models = new Set<string>();
    for (const raw of await modelLines(command, cwd, runner)) {
      const id = /^(\S+) - \S/.exec(raw.trim())?.[1];
      if (id && isValidModel('cursor', id)) models.add(id);
    }
    return [...models];
  } catch {
    throw new Error('Cursor model catalogue unavailable');
  }
}

export interface ModelCatalogue {
  get(): Promise<string[]>;
}
export type OpenCodeModelCatalogue = ModelCatalogue;

/** Caches a model list briefly, and shares one lookup between callers that ask while it runs. */
export function createModelCatalogue(load: () => Promise<string[]>, now: () => number = Date.now): ModelCatalogue {
  let cached: { models: string[]; expiresAt: number } | undefined;
  let pending: Promise<string[]> | undefined;
  return {
    get() {
      const current = now();
      if (cached && current < cached.expiresAt) return Promise.resolve([...cached.models]);
      if (pending) return pending;
      pending = load().then((models) => {
        cached = { models, expiresAt: now() + MODEL_CACHE_TTL_MS };
        return [...models];
      }).finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}

export function createOpenCodeModelCatalogue(
  command: string,
  cwd: string,
  runner: ModelCommandRunner = runModelCommand,
  now: () => number = Date.now,
): ModelCatalogue {
  return createModelCatalogue(() => fetchOpenCodeModels(command, cwd, runner), now);
}

export function createCursorModelCatalogue(
  command: string,
  cwd: string,
  runner: ModelCommandRunner = runModelCommand,
  now: () => number = Date.now,
): ModelCatalogue {
  return createModelCatalogue(() => fetchCursorModels(command, cwd, runner), now);
}
