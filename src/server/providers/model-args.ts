// A worker's picked model on its command line: it replaces any the office's --agent-args set.

/** `args` without a `--model` (or the short flag, when the CLI has one) of its own, whichever way it was written. */
export function withoutModel(args: string[], short?: string): string[] {
  const clean: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' || arg === short) {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (arg.startsWith('--model=') || (short && arg.startsWith(short) && !arg.startsWith('--') && arg.length > short.length)) continue;
    clean.push(arg);
  }
  return clean;
}

/** `args` run on `model`. */
export function withModel(args: string[], model: string, short?: string): string[] {
  return [...withoutModel(args, short), '--model', model];
}
