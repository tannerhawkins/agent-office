import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentId } from '../../shared/protocol.js';
import { shq } from './util.js';

/**
 * The script an agent's hooks run: it POSTs the hook's JSON to the office's loopback endpoint
 * (/hooks/<agent>). Everything office-specific comes from the worker's environment, so outside the
 * office it does nothing. It prints nothing and always succeeds: Cursor reads a hook's output as a
 * permission answer, and a failing hook must never get in the agent's way.
 */
export function writeNodeHook(dataDir: string): string {
  // Minimal VPS images sometimes lack curl; the office's own node binary is always there.
  const file = path.join(dataDir, 'hook.cjs');
  writeFileSync(
    file,
    `const http = require('http');
const [agent, event] = process.argv.slice(2);
let body = '';
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', () => {
  const url = new URL(process.env.AGENT_OFFICE_HOOK_URL + '/hooks/' + agent);
  url.searchParams.set('worker', process.env.AGENT_OFFICE_WORKER_ID);
  url.searchParams.set('event', event);
  const req = http.request(url, { method: 'POST', timeout: 3000, headers: { authorization: 'Bearer ' + process.env.AGENT_OFFICE_HOOK_TOKEN, 'content-type': 'application/json' } }, (res) => res.resume());
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
});
`,
    { mode: 0o600 },
  );
  return file;
}

/** The shell command one hook event runs. */
export function hookCommand(agent: AgentId, event: string, nodeHook: string): string {
  const curl =
    `curl -sS -m 3 -X POST -H "Authorization: Bearer $AGENT_OFFICE_HOOK_TOKEN" -H "Content-Type: application/json" ` +
    `--data-binary @- "$AGENT_OFFICE_HOOK_URL/hooks/${agent}?worker=$AGENT_OFFICE_WORKER_ID&event=${event}"`;
  return (
    `if [ -z "$AGENT_OFFICE_WORKER_ID" ] || [ -z "$AGENT_OFFICE_HOOK_URL" ]; then cat >/dev/null; exit 0; fi; ` +
    `if command -v curl >/dev/null 2>&1; then ${curl} >/dev/null 2>&1; ` +
    `else ${shq(process.execPath)} ${shq(nodeHook)} ${agent} ${event} >/dev/null 2>&1; fi; true`
  );
}
