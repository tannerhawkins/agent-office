import { accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function shq(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function truncate(s: string, n: number) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** Where a command lives: a path as given, on PATH, or wherever a login shell finds it (nvm, asdf, ~/.local/bin). */
export function resolveCommand(cmd: string): string | null {
  if (cmd.includes('/')) {
    try {
      accessSync(cmd, constants.X_OK);
      return path.resolve(cmd);
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  try {
    const shell = process.env.SHELL || '/bin/bash';
    const found = execFileSync(shell, ['-l', '-i', '-c', `command -v ${shq(cmd)}`], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .pop();
    if (found && found.startsWith('/')) return found;
  } catch {
    // fall through
  }
  return null;
}
