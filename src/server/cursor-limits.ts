// Cursor's own plan usage (the billing-cycle "included usage" meter cursor.com's dashboard shows)
// for the meter under the workers, alongside the Claude one. cursor-agent's CLI has no equivalent
// of Claude Code's `get_usage` control request — its `status`/`about` commands carry no quota
// numbers — so this reads the same session Cursor's desktop app already holds. The desktop app
// (not cursor-agent) keeps its access token in a local sqlite database; the dashboard's session
// cookie is `<jwt "sub", "auth0|" stripped>::<access token>`, sent as `WorkosCursorSessionToken` to
// cursor.com/api/usage-summary. No password or browser is touched; this is the same request the
// dashboard's own page makes once it is open, replayed with the desktop app's own stored token.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { PlanLimits, PlanWindow } from '../shared/protocol.js';

const POLL_MS = 5 * 60_000;
const MIN_GAP_MS = 20_000;
const TIMEOUT_MS = 15_000;
/** Cursor desktop not installed, not signed in, or no team: look again much later. */
const NO_PLAN_MS = 30 * 60_000;
const FAILS_BEFORE_BACKOFF = 3;
const BACKOFF_MS = 10 * 60_000;

function stateDbPath(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

/** One `key` column out of Cursor's sqlite ItemTable, or null if missing, the db doesn't exist, or `sqlite3` isn't installed. */
function readItem(sqlite3: string, db: string, key: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(sqlite3, [db, `SELECT value FROM ItemTable WHERE key = '${key}';`], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.trim() ? out.trim() : null);
    });
  });
}

/** The `sub` claim of a JWT, `auth0|` prefix stripped (Cursor's dashboard cookie form), or null. */
function jwtSub(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(payload + '='.repeat((4 - (payload.length % 4)) % 4), 'base64').toString('utf8');
    const sub = JSON.parse(json)?.sub;
    return typeof sub === 'string' && sub ? sub.replace(/^auth0\|/, '') : null;
  } catch {
    return null;
  }
}

async function fetchUsageSummary(sqlite3: string): Promise<any> {
  const db = stateDbPath();
  const [accessToken, cachedTeam] = await Promise.all([readItem(sqlite3, db, 'cursorAuth/accessToken'), readItem(sqlite3, db, 'cursorAuth/cachedTeam')]);
  if (!accessToken || !cachedTeam) return null;
  const sub = jwtSub(accessToken);
  if (!sub) return null;
  let teamId: unknown;
  try {
    const team = JSON.parse(cachedTeam);
    teamId = team?.teamId ?? team?.id ?? team?.team_id;
  } catch {
    return null;
  }
  if (typeof teamId !== 'number' && typeof teamId !== 'string') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://cursor.com/api/usage-summary?teamId=${teamId}`, {
      headers: { Cookie: `WorkosCursorSessionToken=${sub}::${accessToken}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function bucket(label: string, b: any, resetsAt?: number): PlanWindow | null {
  if (!b?.enabled || typeof b.used !== 'number' || typeof b.limit !== 'number' || !(b.limit > 0)) return null;
  return { label, pct: Math.max(0, Math.min(100, (b.used / b.limit) * 100)), resetsAt };
}

function parse(answer: any): PlanLimits {
  const plan = typeof answer?.membershipType === 'string' ? answer.membershipType : undefined;
  if (!answer || answer.isUnlimited) return { plan, windows: [], at: Date.now() };
  const resetsAt = typeof answer.billingCycleEnd === 'string' ? Date.parse(answer.billingCycleEnd) : undefined;
  const windows = [bucket('Individual', answer.individualUsage?.overall, Number.isFinite(resetsAt) ? resetsAt : undefined), bucket('Team on-demand', answer.teamUsage?.onDemand, Number.isFinite(resetsAt) ? resetsAt : undefined)];
  return { plan, windows: windows.filter((w): w is PlanWindow => w !== null), at: Date.now() };
}

/** Cursor's plan usage, mirroring PlanLimitsReader (Claude's) but sourced from cursor.com's dashboard API. */
export class CursorLimitsReader {
  private limits: PlanLimits = { windows: [], at: 0 };
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastRead = 0;
  private fails = 0;
  private closed = false;

  /**
   * @param sqlite3 the `sqlite3` binary, or null when it isn't installed (nothing is ever shown)
   * @param wanted whether anyone is in the office to see the numbers; polls are skipped when not
   */
  constructor(
    private sqlite3: string | null,
    private wanted: () => boolean,
    private onChange: (limits: PlanLimits) => void,
  ) {
    this.schedule(0);
  }

  get state(): PlanLimits {
    return this.limits;
  }

  refresh() {
    if (this.running || Date.now() - this.lastRead < MIN_GAP_MS) return;
    this.schedule(0);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (this.closed || !this.sqlite3) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.read(), ms);
    this.timer.unref();
  }

  private async read() {
    if (!this.wanted()) return this.schedule(POLL_MS);
    this.running = true;
    const answer = await fetchUsageSummary(this.sqlite3!);
    this.running = false;
    this.lastRead = Date.now();
    if (this.closed) return;
    let next = POLL_MS;
    if (answer === null) {
      if (++this.fails >= FAILS_BEFORE_BACKOFF) {
        this.fails = 0;
        next = BACKOFF_MS;
      }
    } else {
      this.fails = 0;
      this.limits = parse(answer);
      if (!this.limits.windows.length) next = NO_PLAN_MS;
      this.onChange(this.limits);
    }
    this.schedule(next);
  }
}
