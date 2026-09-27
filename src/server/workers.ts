import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import * as pty from '@lydell/node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import type { AgentId, Run, WorkerInfo, WorkerKind, WorkerStatus, WorkerTask } from '../shared/protocol.js';
import { FLAG_BOLD, FLAG_DIM, FLAG_INVERSE, RGB_FLAG, isAgentId } from '../shared/protocol.js';
import { Worktrees, describeWork, type WorktreeCleanup, type WorktreeState } from './worktrees.js';
import { DESK_BY_ID } from '../shared/layout.js';
import { gh } from './github.js';
import type { ServiceOwner } from './services.js';
import { TaskNamer, claudeNamer, cursorNamer, fallbackTask } from './tasks.js';
import { addTurn, addUsage, newTracker, restoreTracker, scanTracker, trackerUsage, zeroUsage, type Ledger, type UsageTracker } from './usage.js';
import type { AgentAdapter, AgentEvent, Agents } from './agents/index.js';
import { safeEq, shq, truncate } from './agents/util.js';

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;

const NAMES = [
  'Pixel', 'Byte', 'Nibble', 'Sprocket', 'Widget', 'Gizmo', 'Bolt', 'Cosmo', 'Dot', 'Echo',
  'Fizz', 'Glitch', 'Hopper', 'Jinx', 'Kilo', 'Lumen', 'Mochi', 'Noodle', 'Orbit', 'Pip',
  'Quark', 'Rivet', 'Sparky', 'Tofu', 'Uno', 'Volt', 'Waffle', 'Zippy',
];
const COLORS = ['#ff8a5b', '#5bc0eb', '#9bc53d', '#fde74c', '#c3423f', '#b388eb', '#f7aef8', '#72ddf7', '#ffb400', '#00a6a6'];

// Env vars from a parent agent session (e.g. starting the office from inside Claude Code) that
// would make a worker think it is a child session — that silently turns off transcript saving,
// which breaks resume.
const SCRUB_ENV = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'NO_COLOR', 'FORCE_COLOR', 'VSCODE_INJECTION', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
]);
const SCRUB_PREFIXES = ['CLAUDE_CODE_SESSION', 'CLAUDE_CODE_CHILD', 'CLAUDE_CODE_MESSAGING', 'NEBULA_', 'AGENT_OFFICE_'];
const scrubbed = (k: string) => SCRUB_ENV.has(k) || SCRUB_PREFIXES.some((p) => k.startsWith(p));

const SCROLLBACK = 3000;
const SCREEN_INTERVAL_MS = 250;
const LATE_PROMPT_GRACE_MS = 5000;
const KEYFRAME_MS = 8000;
/** How many of a worker's latest prompts and tool calls the task namer sees. */
const TASK_PROMPTS = 5;
const TASK_TOOLS = 10;
/** While a worker works, refresh its task summary after this many tool calls, at most this often. */
const TASK_REFRESH_TOOLS = 8;
const TASK_REFRESH_MS = 90_000;
const PR_TITLE_MAX = 72;
const PR_TASK_MAX = 2500;
/** How often every worker's transcript is checked for new spend, on top of the hook-driven checks. */
const USAGE_SCAN_MS = 10_000;

export interface HookEnv {
  url: string;
  token: string;
}

interface Worker {
  info: WorkerInfo;
  pty?: pty.IPty;
  term?: HeadlessTerminal;
  ser?: InstanceType<typeof serialize.SerializeAddon>;
  viewers: Map<string, string>; // clientId -> name
  screenDirty: boolean;
  lastLines: string[];
  leftNeedsInputAt: number;
  keyframeAt: number;
  hookToken: string;
  /** The agent never became ready: it's stuck on a trust/login/onboarding screen. */
  bootBlocked?: boolean;
  /** An approval prompt spotted on its screen (agents with no permission hook) put it in needs_input. */
  approvalOpen?: boolean;
  /** Its latest tool, for saying what an approval prompt is about. */
  lastTool?: string;
  /** Making its session before launch (Cursor's create-chat). */
  preparing?: boolean;
  /** Its latest prompts and tool calls, for naming its task. */
  prompts: string[];
  tools: string[];
  toolsSinceNamed: number;
  namedAt: number;
  /** Bumped by /clear: a new conversation, so a new task. */
  taskEpoch: number;
  /** Where the session's tokens and cost are read from (see usage.ts). */
  tracker: UsageTracker;
  scanTimer?: NodeJS.Timeout;
}

export interface WorkerEvents {
  update(info: WorkerInfo): void;
  remove(workerId: string): void;
  data(workerId: string, data: string, viewers: string[]): void;
  screen(workerId: string, frame: { cols: number; rows: number; lines: Record<number, Run[]>; full: boolean; cursor: [number, number] }): void;
  toast(text: string, level: 'info' | 'warn' | 'error'): void;
}

export class WorkerManager {
  private workers = new Map<string, Worker>();
  private statePath: string;
  private trees: Worktrees;
  private screenTimer: NodeJS.Timeout;
  /** The office is shutting down: workers exiting now are being stopped, not failing to resume. */
  private closing = false;
  private namer: TaskNamer;
  private usageTimer: NodeJS.Timeout;

  constructor(
    private dir: string,
    private dataDir: string,
    private agents: Agents,
    private defaultAgent: AgentId,
    private hook: HookEnv,
    private events: WorkerEvents,
    private ledger: Ledger,
  ) {
    this.trees = new Worktrees(dir);
    this.statePath = path.join(dataDir, 'workers.json');
    const claude = agents.get('claude')?.path;
    const cursor = agents.get('cursor')?.path;
    this.namer = new TaskNamer(claude ? claudeNamer(claude) : cursor ? cursorNamer(cursor) : null, childEnv(), (id, task, ctx) => {
      const w = this.workers.get(id);
      if (!w || w.taskEpoch !== ctx.epoch) return;
      w.info.task = task;
      this.emitUpdate(w);
      this.persist();
    });
    this.restore();
    // A session may have ended (and written its final tally) while the office was down.
    for (const w of this.workers.values()) this.scanUsage(w);
    this.screenTimer = setInterval(() => this.flushScreens(), SCREEN_INTERVAL_MS);
    this.usageTimer = setInterval(() => {
      for (const w of this.workers.values()) this.scanUsage(w);
    }, USAGE_SCAN_MS);
    // Whoever was at a desk when the office stopped (a restart, a crash, a dev-server reload) gets
    // straight back to work.
    this.wakeAll();
  }

  list(): WorkerInfo[] {
    return [...this.workers.values()].map((w) => w.info);
  }

  get(id: string): WorkerInfo | undefined {
    return this.workers.get(id)?.info;
  }

  /** Each worker's terminal process and directory, to tell whose servers are whose. */
  owners(): ServiceOwner[] {
    return [...this.workers.values()].map((w) => ({
      workerId: w.info.id,
      pid: w.pty?.pid,
      agent: w.info.kind === 'agent',
      cwd: w.info.worktree ? path.join(this.dir, w.info.worktree.path) : this.dir,
    }));
  }

  deskOccupied(deskId: string): boolean {
    for (const w of this.workers.values()) if (w.info.deskId === deskId) return true;
    return false;
  }

  spawn(deskId: string, by: string, prompt?: string, worktree = false, kind: WorkerKind = 'agent', agent?: AgentId): WorkerInfo | string {
    if (!DESK_BY_ID.has(deskId)) return 'Unknown desk';
    if (this.deskOccupied(deskId)) return 'That desk is taken';
    const agentId = kind === 'agent' ? (agent ?? this.defaultAgent) : undefined;
    if (agentId) {
      const unusable = this.unusable(agentId);
      if (unusable) return unusable;
      const paused = this.ledger.hiringPaused;
      if (paused) return paused;
    }
    const used = new Set([...this.workers.values()].map((w) => w.info.name.replace(/ 🐚$/, '')));
    const name = NAMES.find((n) => !used.has(n)) ?? `Worker ${this.workers.size + 1}`;
    const id = randomBytes(6).toString('hex');
    let wt: WorkerInfo['worktree'];
    if (worktree) {
      const made = this.trees.create(`${name.toLowerCase()}-${id.slice(0, 4)}`);
      if (typeof made === 'string') return made;
      wt = made;
    }
    const info: WorkerInfo = {
      id,
      kind,
      agent: agentId,
      deskId,
      name: kind === 'shell' ? `${name} 🐚` : name,
      color: kind === 'shell' ? '#8d99ae' : COLORS[Math.floor(Math.random() * COLORS.length)],
      status: 'starting',
      acked: true,
      createdBy: by,
      createdAt: Date.now(),
      prompt: kind === 'shell' ? undefined : prompt?.trim() || undefined,
      worktree: wt,
      cols: 100,
      rows: 30,
      viewers: [],
      activity: prompt ? truncate(prompt, 80) : undefined,
    };
    const w = newWorker(info, newTracker());
    this.workers.set(id, w);
    if (info.prompt) this.notePrompt(w, info.prompt);
    this.launch(w, info.prompt, undefined);
    this.persist();
    return info;
  }

  resume(id: string): string | undefined {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (w.pty || w.preparing) return 'Worker is already running';
    if (w.info.kind === 'agent') {
      const unusable = this.unusable(w.info.agent ?? 'claude');
      if (unusable) return unusable;
    }
    w.info.status = 'starting';
    w.info.exitCode = undefined;
    this.launch(w, undefined, w.info.sessionId);
    return undefined;
  }

  /** Starts every worker that isn't running: nobody should be found asleep at their desk. */
  wakeAll() {
    for (const w of this.workers.values()) {
      if (w.pty) continue;
      const err = this.resume(w.info.id);
      if (err && w.info.kind === 'agent') {
        w.info.activity = err;
        this.emitUpdate(w);
      }
    }
  }

  /** Why an agent can't be seated here, when it can't. */
  private unusable(id: AgentId): string | undefined {
    const a = this.agents.get(id);
    if (!a) return `This office isn't set up to run ${id} workers`;
    if (!a.path) return `${a.label} (${a.cmd}) isn't installed on the office machine`;
    return undefined;
  }

  private adapterOf(w: Worker): AgentAdapter | undefined {
    return w.info.kind === 'agent' ? this.agents.get(w.info.agent ?? 'claude') : undefined;
  }

  /**
   * Sends a worker home. For one with its own worktree, `cleanup` says what becomes of it; with no
   * choice given, the worktree and branch go only when they hold no work. Resolves once that's done,
   * with a line for the team about the worktree.
   */
  async kill(id: string, cleanup?: WorktreeCleanup): Promise<{ note?: string; error?: string }> {
    const w = this.workers.get(id);
    if (!w) return {};
    this.workers.delete(id);
    this.namer.forget(id);
    clearTimeout(w.scanTimer);
    const proc = w.pty;
    w.pty = undefined; // so the exit handler knows this worker is gone and stays quiet
    try {
      proc?.kill();
    } catch {
      // already gone
    }
    w.term?.dispose();
    this.events.remove(id);
    this.persist();
    const wt = w.info.worktree;
    if (!wt) return {};
    const name = w.info.name;
    if (!cleanup) {
      const work = describeWork(await this.trees.inspect(wt));
      if (work) return { note: `Kept ${name}'s worktree and branch ${wt.branch} — it has ${work}` };
      cleanup = 'all';
    }
    if (cleanup === 'keep') return { note: `Kept ${name}'s worktree and branch ${wt.branch}` };
    const error = await this.trees.remove(wt, cleanup);
    if (error) return { error: `Couldn't delete ${name}'s worktree: ${error}` };
    return { note: cleanup === 'all' ? `Deleted ${name}'s worktree and branch ${wt.branch}` : `Deleted ${name}'s worktree and kept branch ${wt.branch}` };
  }

  /** What a worker's worktree holds, so whoever sends it home knows what deleting it would lose. */
  inspectWorktree(id: string): Promise<WorktreeState | undefined> {
    const wt = this.workers.get(id)?.info.worktree;
    return wt ? this.trees.inspect(wt) : Promise.resolve(undefined);
  }

  attach(id: string, clientId: string, name: string): { data: string; cols: number; rows: number } | undefined {
    const w = this.workers.get(id);
    if (!w) return undefined;
    w.viewers.set(clientId, name);
    let changed = this.syncViewers(w);
    if (!w.info.acked && w.info.status !== 'needs_input') {
      w.info.acked = true;
      changed = true;
    }
    if (changed) this.emitUpdate(w);
    const data = w.ser ? w.ser.serialize({ scrollback: SCROLLBACK }) : offlineBanner(w.info);
    return { data, cols: w.info.cols, rows: w.info.rows };
  }

  detach(id: string, clientId: string) {
    const w = this.workers.get(id);
    if (!w) return;
    if (w.viewers.delete(clientId) && this.syncViewers(w)) this.emitUpdate(w);
  }

  detachAll(clientId: string) {
    for (const w of this.workers.values()) {
      if (w.viewers.delete(clientId) && this.syncViewers(w)) this.emitUpdate(w);
    }
  }

  write(id: string, data: string) {
    const w = this.workers.get(id);
    if (!w?.pty) return;
    w.pty.write(data);
    if (w.info.status === 'needs_input' && w.info.acked === false) {
      w.info.acked = true;
      this.emitUpdate(w);
    }
  }

  /** Types a prompt into the agent's input box and submits it. */
  prompt(id: string, text: string): string | undefined {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    if (!w.pty) return 'Worker is not running';
    const clean = text.replace(/\r\n?/g, '\n').trim();
    if (!clean) return 'Empty prompt';
    // Bracketed paste keeps multi-line prompts in one message, then Enter submits.
    w.pty.write(`\x1b[200~${clean}\x1b[201~`);
    setTimeout(() => w.pty?.write('\r'), 120);
    w.info.activity = truncate(clean, 80);
    this.notePrompt(w, clean);
    this.emitUpdate(w);
    return undefined;
  }

  /**
   * Pushes a worktree worker's branch and opens a pull request for it, with a title and body
   * drafted from its task. Resolves to the PR, or to a message saying why there is none. The
   * branch may already have an open PR (a second press, or one opened by hand): that one is used.
   */
  async openPr(id: string, by: string): Promise<{ number: number; url: string; existed: boolean; dirty: boolean } | string> {
    const w = this.workers.get(id);
    if (!w) return 'No such worker';
    const { info } = w;
    const wt = info.worktree;
    if (!wt) return `${info.name} works in the main checkout — only workers with their own worktree can open a PR`;
    if (info.prOpening) return `${info.name}'s pull request is already being opened`;
    if (info.status === 'starting' || info.status === 'working' || info.status === 'needs_input') {
      return `${info.name} is still ${info.status === 'needs_input' ? 'waiting on input' : info.status} — wait until it's done`;
    }
    const cwd = path.join(this.dir, wt.path);
    if (!existsSync(cwd)) return `${info.name}'s worktree is gone (${wt.path})`;
    info.prOpening = true;
    this.emitUpdate(w);
    try {
      const commits = (await run('git', ['log', '--reverse', '--format=%h %s', `${wt.base}..${wt.branch}`], cwd)).split('\n').filter(Boolean);
      const dirty = (await run('git', ['status', '--porcelain'], cwd)) !== '';
      if (!commits.length) return dirty ? `${info.name} hasn't committed anything yet — ask it to commit first` : `${info.name} has no commits on ${wt.branch} yet`;
      const open = await findOpenPr(wt.branch, cwd);
      if (open) {
        info.pr = open;
        this.persist();
        return { ...open, existed: true, dirty };
      }
      await run('git', ['push', '-u', 'origin', wt.branch], cwd, 90_000);
      const base = await this.pushedBranch([wt.from, this.trees.currentBranch()], wt.branch);
      const { title, body } = draftPr(info, commits, by);
      const out = await gh(['pr', 'create', '--head', wt.branch, ...(base ? ['--base', base] : []), '--title', title, '--body', body], cwd, 60_000);
      const url = out.trim().split('\n').pop() ?? '';
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
      if (!number) throw new Error(`gh did not return a pull request URL (${truncate(out, 120)})`);
      info.pr = { number, url };
      this.persist();
      return { number, url, existed: false, dirty };
    } catch (err) {
      return `Couldn't open a PR for ${info.name}: ${(err as Error).message}`;
    } finally {
      info.prOpening = false;
      // The worker may have been sent home meanwhile; an update would bring it back as a ghost.
      if (this.workers.get(id) === w) this.emitUpdate(w);
    }
  }

  /** The first of these branches that exists on origin, for a PR base. None: gh picks the default branch. */
  private async pushedBranch(candidates: (string | undefined)[], not: string): Promise<string | undefined> {
    for (const c of candidates) {
      if (!c || c === not) continue;
      try {
        await run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${c}`], this.dir);
        return c;
      } catch {
        // not on the remote (or never fetched)
      }
    }
    return undefined;
  }

  resize(id: string, cols: number, rows: number) {
    const w = this.workers.get(id);
    if (!w?.pty || !w.term) return;
    cols = clamp(Math.floor(cols), 20, 400);
    rows = clamp(Math.floor(rows), 5, 200);
    if (cols === w.info.cols && rows === w.info.rows) return;
    w.info.cols = cols;
    w.info.rows = rows;
    try {
      w.pty.resize(cols, rows);
      w.term.resize(cols, rows);
    } catch {
      // pty may have exited between checks
    }
    w.screenDirty = true;
    w.lastLines = [];
    this.emitUpdate(w);
  }

  /** An agent hook's callback (see agents/hook.ts), from the agent the worker runs. */
  handleHook(agent: string, workerId: string, token: string, event: string, payload: any): boolean {
    const w = this.workers.get(workerId);
    if (!w || !safeEq(token, w.hookToken)) return false;
    const adapter = this.adapterOf(w);
    if (!adapter || adapter.id !== agent) return false;
    const r = adapter.parseHook(event, payload);
    if (r.sessionId && r.sessionId !== w.info.sessionId) {
      w.info.sessionId = r.sessionId;
      this.persist();
    }
    if (r.transcript && r.transcript !== w.tracker.transcript) {
      w.tracker.transcript = r.transcript;
      this.persist();
    }
    if (r.usage && addTurn(w.tracker, r.usage.key, r.usage.usage)) this.bookUsage(w);
    if (adapter.transcriptUsage) this.scheduleScan(w);
    for (const e of r.events) this.applyEvent(w, e);
    return true;
  }

  /** Moves a worker's status along on what its agent reported. The same rules for every agent. */
  private applyEvent(w: Worker, e: AgentEvent) {
    const now = Date.now();
    switch (e.type) {
      case 'sessionStart':
        if (e.clear) this.clearTask(w);
        if (w.info.status === 'starting' || (w.bootBlocked && w.info.status === 'needs_input')) {
          w.bootBlocked = false;
          this.setStatus(w, 'idle');
        }
        break;
      case 'promptSubmit':
        w.bootBlocked = false;
        if (e.prompt) {
          w.info.activity = truncate(e.prompt, 80);
          this.notePrompt(w, e.prompt);
        }
        if (w.info.status !== 'working') this.setStatus(w, 'working');
        else this.emitUpdate(w);
        break;
      case 'askUser':
        this.setStatus(w, 'needs_input');
        break;
      case 'toolStart':
        w.info.activity = e.label;
        w.lastTool = e.label;
        this.noteTool(w, e.label);
        if (w.info.status !== 'working') this.setStatus(w, 'working');
        else this.emitUpdate(w);
        break;
      case 'toolEnd':
        if (w.info.status === 'needs_input') {
          w.leftNeedsInputAt = now;
          w.approvalOpen = false;
          this.setStatus(w, 'working');
        }
        break;
      case 'permissionRequest':
        w.info.activity = `Wants permission: ${e.label}`;
        this.setStatus(w, 'needs_input');
        break;
      case 'permissionNotice':
        if (now - w.leftNeedsInputAt > LATE_PROMPT_GRACE_MS) this.setStatus(w, 'needs_input');
        break;
      case 'idle':
        if (w.info.status === 'working') this.setStatus(w, 'done');
        break;
      case 'stop':
        w.approvalOpen = false;
        this.setStatus(w, 'done');
        break;
    }
  }

  /** A new message for the worker: show it right away, and have its task (re)named. */
  private notePrompt(w: Worker, prompt: string) {
    if (w.info.kind !== 'agent') return;
    const clean = prompt.replace(/\s+/g, ' ').trim();
    // Bare slash commands (/model, /compact) and repeats aren't new work.
    if (!clean || /^\/\S+$/.test(clean) || w.prompts.at(-1) === clean) return;
    w.prompts = [...w.prompts, clean].slice(-TASK_PROMPTS);
    const hadTask = !!w.info.task;
    if (!hadTask) w.info.task = fallbackTask(clean);
    // "yes", "go ahead", "2": a reply within the same task, not worth a new name.
    if (hadTask && clean.length < 16) return;
    this.nameTask(w);
  }

  private noteTool(w: Worker, tool: string) {
    w.tools = [...w.tools, tool].slice(-TASK_TOOLS);
    w.toolsSinceNamed++;
    if (w.info.task && w.toolsSinceNamed >= TASK_REFRESH_TOOLS && Date.now() - w.namedAt > TASK_REFRESH_MS) this.nameTask(w);
  }

  private nameTask(w: Worker) {
    w.toolsSinceNamed = 0;
    w.namedAt = Date.now();
    const previous = w.info.task && w.prompts.length > 1 ? w.info.task : undefined;
    this.namer.request(w.info.id, { prompts: w.prompts, tools: w.tools, previous, epoch: w.taskEpoch });
  }

  private clearTask(w: Worker) {
    w.taskEpoch++;
    w.prompts = [];
    w.tools = [];
    w.toolsSinceNamed = 0;
    this.namer.forget(w.info.id);
    if (!w.info.task) return;
    w.info.task = undefined;
    this.emitUpdate(w);
    this.persist();
  }

  shutdown() {
    this.closing = true;
    clearInterval(this.screenTimer);
    clearInterval(this.usageTimer);
    for (const w of this.workers.values()) {
      try {
        w.pty?.kill();
      } catch {
        // ignore
      }
    }
    this.persist();
  }

  // ---------------------------------------------------------------------------

  private launch(w: Worker, prompt: string | undefined, resumeSessionId: string | undefined) {
    const adapter = this.adapterOf(w);
    // Cursor can make its conversation up front: then its id is known (and resumable) from the start.
    if (adapter?.newSession && !resumeSessionId) {
      w.preparing = true;
      this.emitUpdate(w);
      void adapter.newSession(this.cwdOf(w), childEnv()).then((id) => {
        w.preparing = false;
        if (this.workers.get(w.info.id) !== w || w.pty || this.closing) return;
        if (id) {
          w.info.sessionId = id;
          this.persist();
        }
        this.start(w, adapter, prompt, id);
      });
      return;
    }
    this.start(w, adapter, prompt, resumeSessionId);
  }

  private cwdOf(w: Worker): string {
    return w.info.worktree ? path.join(this.dir, w.info.worktree.path) : this.dir;
  }

  private start(w: Worker, adapter: AgentAdapter | undefined, prompt: string | undefined, resumeSessionId: string | undefined) {
    const { info } = w;
    const term = new headless.Terminal({ cols: info.cols, rows: info.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const ser = new serialize.SerializeAddon();
    term.loadAddon(ser as any);
    // OSC 9;4 progress (Claude Code emits it): 0 = idle, anything else = busy. Catches Esc-cancel,
    // which fires no Stop hook.
    if (adapter?.trustsProgress) {
      term.parser.registerOscHandler(9, (data: string) => {
        const m = /^4;(\d)/.exec(data);
        if (m) this.onProgress(w, m[1] !== '0');
        return true;
      });
    }
    term.onTitleChange((title: string) => {
      const clean = title.replace(/^[^\p{L}\p{N}]+/u, '').trim();
      if (clean && clean !== info.title && !adapter?.titleIgnore?.test(clean)) {
        info.title = clean;
        this.emitUpdate(w);
      }
    });
    w.term?.dispose();
    w.term = term;
    w.ser = ser;
    w.lastLines = [];
    w.screenDirty = true;
    w.approvalOpen = false;

    const shell = process.env.SHELL || '/bin/bash';
    const args = adapter ? adapter.args({ prompt, resumeId: resumeSessionId }) : ['-l'];
    const env = childEnv();
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      AGENT_OFFICE_WORKER_ID: info.id,
      AGENT_OFFICE_HOOK_URL: this.hook.url,
      AGENT_OFFICE_HOOK_TOKEN: w.hookToken,
    });

    const cwd = this.cwdOf(w);
    const what = adapter ? adapter.cmd : shell;
    let proc: pty.IPty;
    try {
      if (!existsSync(cwd)) throw new Error(`working directory is gone: ${cwd}`);
      if (adapter && !adapter.path) throw new Error(`${adapter.cmd} isn't installed on this machine`);
      proc = pty.spawn(adapter ? adapter.path! : shell, args, { name: 'xterm-256color', cols: info.cols, rows: info.rows, cwd, env });
    } catch (err) {
      info.status = 'exited';
      info.exitCode = -1;
      term.write(`\r\n\x1b[31mFailed to start ${what}: ${(err as Error).message}\x1b[0m\r\n`);
      this.events.toast(`Could not start ${what}: ${(err as Error).message}`, 'error');
      this.emitUpdate(w);
      return;
    }
    w.pty = proc;
    // A shell, or an agent the office gets no hooks from, is ready as soon as it's running.
    if (!adapter?.hooks) info.status = 'idle';

    proc.onData((data) => {
      term.write(data);
      w.screenDirty = true;
      if (w.viewers.size) this.events.data(info.id, data, [...w.viewers.keys()]);
    });
    proc.onExit(({ exitCode }) => {
      if (w.pty !== proc || this.workers.get(info.id) !== w) return;
      w.pty = undefined;
      // Resuming a conversation Claude no longer has ("No conversation found") exits before Claude
      // ever starts. Start a fresh one rather than leave the worker asleep.
      if (adapter?.resumeExitsEarly && resumeSessionId && info.status === 'starting' && !this.closing) {
        this.events.toast(`${info.name}'s last conversation couldn't be resumed — starting a fresh one`, 'warn');
        this.launch(w, undefined, undefined);
        return;
      }
      info.exitCode = exitCode;
      info.status = 'exited';
      const hint = info.kind === 'shell' ? ' — press R to restart' : info.sessionId ? ' — press R to resume' : '';
      const msg = `\r\n\x1b[2m[${info.name} exited with code ${exitCode}${hint}]\x1b[0m\r\n`;
      term.write(msg);
      if (w.viewers.size) this.events.data(info.id, msg, [...w.viewers.keys()]);
      w.screenDirty = true;
      this.emitUpdate(w);
      this.persist();
    });
    // The agent says when it can take input: a hook (Claude's SessionStart) or its prompt bar on
    // screen (Cursor). Still not ready after a while means it is blocked on a human: folder trust
    // dialog, login, first-run onboarding. Flag it so it jumps.
    setTimeout(() => {
      if (info.status !== 'starting' || w.pty !== proc) return;
      if (adapter?.bootViaHook || adapter?.screen.ready) {
        w.bootBlocked = true;
        info.activity = 'Waiting on a setup prompt (trust / login) — open the terminal';
        this.setStatus(w, 'needs_input');
      } else this.setStatus(w, 'idle');
    }, 12000);
    this.emitUpdate(w);
  }

  /** Hooks fire in bursts (every tool call); one read a moment later covers the whole burst. */
  private scheduleScan(w: Worker) {
    if (w.scanTimer) return;
    w.scanTimer = setTimeout(() => {
      w.scanTimer = undefined;
      this.scanUsage(w);
    }, 300);
  }

  /** Picks up what the session logged since last time and books the difference. */
  private scanUsage(w: Worker) {
    if (w.info.kind !== 'agent' || !w.tracker.transcript || this.workers.get(w.info.id) !== w) return;
    try {
      if (!scanTracker(w.tracker)) return;
    } catch {
      return; // an unreadable transcript is retried on the next scan
    }
    this.bookUsage(w);
  }

  /** The worker's tracker moved on: show its new totals and book the difference on the ledger. */
  private bookUsage(w: Worker) {
    const before = w.info.usage ?? zeroUsage();
    const after = trackerUsage(w.tracker);
    w.info.usage = after;
    this.ledger.add(addUsage(after, before, -1));
    this.emitUpdate(w);
    this.persist();
  }

  private onProgress(w: Worker, busy: boolean) {
    const s = w.info.status;
    if (busy && (s === 'idle' || s === 'done' || s === 'starting')) this.setStatus(w, 'working');
    // Progress stays busy while a permission prompt is open, so going idle from needs_input means the
    // turn ended without a Stop hook (the prompt was rejected or Esc'd).
    else if (!busy && (s === 'working' || (s === 'needs_input' && !w.bootBlocked))) this.setStatus(w, 'done');
  }

  private setStatus(w: Worker, status: WorkerStatus) {
    if (w.info.status === status) return;
    if (w.info.status === 'needs_input') w.leftNeedsInputAt = Date.now();
    w.info.status = status;
    // Nobody is looking at the terminal right now -> raise the flag (the worker jumps).
    if (status === 'done' || status === 'needs_input') w.info.acked = w.viewers.size > 0 && status === 'done';
    else w.info.acked = true;
    this.emitUpdate(w);
  }

  private syncViewers(w: Worker): boolean {
    const names = [...new Set(w.viewers.values())];
    const same = names.length === w.info.viewers.length && names.every((n, i) => n === w.info.viewers[i]);
    if (same) return false;
    w.info.viewers = names;
    return true;
  }

  private emitUpdate(w: Worker) {
    this.events.update({ ...w.info });
  }

  /** Full screens for every running worker — sent to people as they walk in. */
  fullScreens() {
    const out: { workerId: string; frame: NonNullable<ReturnType<typeof snapshotScreen>> }[] = [];
    for (const w of this.workers.values()) {
      if (!w.term) continue;
      const frame = snapshotScreen(w.term, []);
      if (frame) out.push({ workerId: w.info.id, frame });
    }
    return out;
  }

  private flushScreens() {
    const now = Date.now();
    for (const w of this.workers.values()) {
      if (!w.term) continue;
      // Diffs can be dropped for slow clients, so resend the whole screen now and then.
      if (now - w.keyframeAt > KEYFRAME_MS) {
        w.keyframeAt = now;
        w.lastLines = [];
        w.screenDirty = true;
      }
      if (!w.screenDirty) continue;
      w.screenDirty = false;
      this.checkBlocked(w);
      const frame = snapshotScreen(w.term, w.lastLines);
      if (frame) this.events.screen(w.info.id, frame);
    }
  }

  /**
   * An agent can sit at its prompt without being usable: stuck on a first-run screen, or not signed
   * in on this machine. Flag that as needing a human, and clear it once the screen moves on. For an
   * agent whose hooks don't say when it's ready, its prompt bar coming up is what says so.
   */
  private checkBlocked(w: Worker) {
    const rules = this.adapterOf(w)?.screen;
    if (!rules || !w.term) return;
    this.checkApproval(w, rules.approval);
    const s = w.info.status;
    if (s !== 'starting' && s !== 'idle' && !(w.bootBlocked && s === 'needs_input')) return;
    const text = screenText(w.term);
    const loggedOut = !!rules.loggedOut?.test(text);
    const blocked = loggedOut || (!!rules.setup?.test(text) && (s === 'starting' || w.bootBlocked));
    if (blocked && s !== 'needs_input') {
      w.bootBlocked = true;
      w.info.activity = loggedOut ? rules.loginHint : 'Waiting on a setup prompt (trust / login) — open the terminal';
      this.setStatus(w, 'needs_input');
    } else if (!blocked && w.bootBlocked && s === 'needs_input') {
      w.bootBlocked = false;
      w.info.activity = undefined;
      this.setStatus(w, 'idle');
    } else if (!blocked && s === 'starting' && rules.ready?.test(text)) {
      this.setStatus(w, 'idle');
    }
  }

  /** An approval prompt on screen, for agents that have no hook for it (Cursor): needs a human. */
  private checkApproval(w: Worker, approval: RegExp | undefined) {
    if (!approval || !w.term) return;
    const s = w.info.status;
    if (!w.approvalOpen && s !== 'working') return;
    const open = approval.test(screenText(w.term));
    if (open && !w.approvalOpen) {
      w.approvalOpen = true;
      w.info.activity = `Wants permission: ${w.lastTool ?? 'a tool'}`;
      this.setStatus(w, 'needs_input');
    } else if (!open && w.approvalOpen) {
      w.approvalOpen = false;
      if (s === 'needs_input') this.setStatus(w, 'working');
    }
  }

  private persist() {
    const saved = [...this.workers.values()].map(({ info, tracker }) => ({
      id: info.id,
      kind: info.kind,
      agent: info.agent,
      deskId: info.deskId,
      name: info.name,
      color: info.color,
      createdBy: info.createdBy,
      createdAt: info.createdAt,
      prompt: info.prompt,
      worktree: info.worktree,
      title: info.title,
      sessionId: info.sessionId,
      activity: info.activity,
      task: info.task,
      pr: info.pr,
      tracker: info.kind === 'agent' ? tracker : undefined,
    }));
    try {
      writeFileSync(this.statePath, JSON.stringify(saved, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }

  private restore() {
    if (!existsSync(this.statePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as (Partial<WorkerInfo> & { tracker?: unknown })[];
      for (const s of saved) {
        if (!s.id || !s.deskId || !DESK_BY_ID.has(s.deskId) || this.deskOccupied(s.deskId)) continue;
        const tracker = restoreTracker(s.tracker);
        const kind: WorkerKind = s.kind === 'shell' ? 'shell' : 'agent';
        const info: WorkerInfo = {
          id: s.id,
          kind,
          agent: kind === 'agent' ? (isAgentId(s.agent) ? s.agent : 'claude') : undefined,
          deskId: s.deskId,
          name: s.name ?? 'Worker',
          color: s.color ?? COLORS[0],
          status: 'offline',
          acked: true,
          createdBy: s.createdBy ?? '?',
          createdAt: s.createdAt ?? Date.now(),
          prompt: s.prompt,
          worktree: s.worktree,
          title: s.title,
          sessionId: s.sessionId,
          activity: s.activity,
          task: validTask(s.task),
          pr: s.pr && typeof s.pr.number === 'number' && typeof s.pr.url === 'string' ? { number: s.pr.number, url: s.pr.url } : undefined,
          usage: tracker.transcript || tracker.turns?.length ? trackerUsage(tracker) : undefined,
          cols: 100,
          rows: 30,
          viewers: [],
        };
        const w = newWorker(info, tracker);
        w.screenDirty = false;
        if (info.prompt) w.prompts = [info.prompt.replace(/\s+/g, ' ').trim()];
        this.workers.set(info.id, w);
      }
    } catch {
      // corrupt state file: start fresh
    }
  }
}

// ---------------------------------------------------------------------------

function newWorker(info: WorkerInfo, tracker: UsageTracker): Worker {
  return {
    info,
    viewers: new Map(),
    screenDirty: true,
    lastLines: [],
    leftNeedsInputAt: 0,
    keyframeAt: 0,
    hookToken: randomBytes(16).toString('hex'),
    prompts: [],
    tools: [],
    toolsSinceNamed: 0,
    namedAt: 0,
    taskEpoch: 0,
    tracker,
  };
}

/** The office's environment, minus anything that would make a child think it's a nested session. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !scrubbed(k)) env[k] = v;
  return env;
}

function validTask(t: unknown): WorkerTask | undefined {
  const v = t as Partial<WorkerTask> | undefined;
  return typeof v?.name === 'string' && typeof v.summary === 'string' ? { name: v.name, summary: v.summary } : undefined;
}

function snapshotScreen(term: HeadlessTerminal, last: string[]) {
  const buf = term.buffer.active;
  const cols = term.cols;
  const rows = term.rows;
  const full = last.length !== rows;
  const lines: Record<number, Run[]> = {};
  let changed = false;
  const cell = buf.getNullCell();
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    const runs: Run[] = [];
    if (line) {
      let cur: Run | null = null;
      for (let x = 0; x < cols; x++) {
        line.getCell(x, cell);
        const width = cell.getWidth();
        if (width === 0) continue;
        const ch = cell.getChars() || ' ';
        const fg = cell.isFgDefault() ? -1 : cell.isFgRGB() ? RGB_FLAG | cell.getFgColor() : cell.getFgColor();
        const bg = cell.isBgDefault() ? -1 : cell.isBgRGB() ? RGB_FLAG | cell.getBgColor() : cell.getBgColor();
        const flags = (cell.isBold() ? FLAG_BOLD : 0) | (cell.isInverse() ? FLAG_INVERSE : 0) | (cell.isDim() ? FLAG_DIM : 0);
        if (cur && cur[1] === fg && cur[2] === bg && cur[3] === flags) cur[0] += ch;
        else {
          cur = [ch, fg, bg, flags];
          runs.push(cur);
        }
      }
    }
    // Trim trailing default-styled whitespace to keep frames small.
    while (runs.length) {
      const r = runs[runs.length - 1];
      if (r[2] !== -1 || r[3] & FLAG_INVERSE) break;
      const trimmed = r[0].replace(/\s+$/, '');
      if (trimmed) {
        r[0] = trimmed;
        break;
      }
      runs.pop();
    }
    const key = JSON.stringify(runs);
    if (full || last[y] !== key) {
      lines[y] = runs;
      last[y] = key;
      changed = true;
    }
  }
  last.length = rows;
  if (!changed) return null;
  return { cols, rows, lines, full, cursor: [buf.cursorX, buf.cursorY] as [number, number] };
}

function screenText(term: HeadlessTerminal): string {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < term.rows; y++) out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
  return out.join('\n');
}

function offlineBanner(info: WorkerInfo): string {
  const hint = info.kind === 'shell' ? ' Press R to restart it.' : info.sessionId ? ' Press R to resume the session.' : '';
  return `\x1b[2m${info.name} is not running.${hint}\x1b[0m\r\n`;
}

/** Runs a command without blocking the office; rejects with the last lines of its stderr. */
function run(cmd: string, args: string[], cwd: string, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').filter(Boolean).slice(-2).join(' ') || `${cmd} failed`));
      else resolve(stdout.trim());
    });
  });
}

async function findOpenPr(branch: string, cwd: string): Promise<{ number: number; url: string } | undefined> {
  const out = await gh(['pr', 'list', '--head', branch, '--state', 'open', '--limit', '1', '--json', 'number,url'], cwd);
  const found = (JSON.parse(out || '[]') as { number: number; url: string }[])[0];
  return found ? { number: found.number, url: found.url } : undefined;
}

/**
 * A pull request title and body from what the worker was asked to do. The title is the issue's
 * title when the task came off the issues board, else the task's first line; the body carries the
 * task, the commits, a "Closes #n" when the task asked for one, and which desk it came from.
 */
function draftPr(info: WorkerInfo, commits: string[], by: string): { title: string; body: string } {
  const task = (info.prompt ?? '').replace(/\r\n?/g, '\n').trim();
  const firstLine = task.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  // The issues board hands work over as: Work on GitHub issue #12: "Title".
  const issue = /\bissue #(\d+):\s*["“](.+?)["”]\.?\s*$/i.exec(firstLine);
  const title = truncate(issue?.[2] || firstLine.replace(/[.:;,]+$/, '') || commits[0]?.replace(/^\S+\s+/, '') || info.worktree?.branch || info.name, PR_TITLE_MAX);
  const closes = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[^\n]{0,40}?#(\d+)/i.exec(task)?.[1] ?? issue?.[1];
  const parts: string[] = [];
  if (task) parts.push(`## Task\n\n${task.length > PR_TASK_MAX ? `${task.slice(0, PR_TASK_MAX)}…` : task}`);
  parts.push(`## Commits\n\n${commits.map((c) => `- \`${c.slice(0, c.indexOf(' '))}\` ${c.slice(c.indexOf(' ') + 1)}`).join('\n')}`);
  if (closes) parts.push(`Closes #${closes}`);
  parts.push(`_Opened from Agent Office by ${by} · ${info.name} at ${DESK_BY_ID.get(info.deskId)?.label ?? info.deskId}_`);
  return { title, body: parts.join('\n\n') };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
