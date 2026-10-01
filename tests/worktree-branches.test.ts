import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BRANCHES_FILE, Worktrees } from '../src/server/worktrees.js';
import { Building } from '../src/server/building.js';
import { templateError } from '../src/shared/branches.js';

/** A project checkout with one commit and the office's folder in it. */
function repo(): { dir: string; git(...args: string[]): string; close(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-worktrees-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'start');
  mkdirSync(path.join(dir, '.agent-office'));
  return { dir, git, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a worktree gets the branch it was asked for, recorded as the office\'s', (t) => {
  const r = repo();
  t.after(r.close);
  const trees = new Worktrees(r.dir);
  const made = trees.create('pixel-a1b2', undefined, undefined, 'feat/12-fix-login');
  assert.equal(typeof made, 'object');
  if (typeof made === 'string') return;
  assert.equal(made.branch, 'feat/12-fix-login');
  assert.equal(made.path, path.join('.agent-office', 'worktrees', 'pixel-a1b2'));
  assert.equal(made.from, 'main');
  assert.deepEqual(JSON.parse(readFileSync(path.join(r.dir, BRANCHES_FILE), 'utf8')), ['feat/12-fix-login']);
});

test('a name that is taken, here or on origin, gets -2, -3', (t) => {
  const r = repo();
  t.after(r.close);
  r.git('branch', 'feat/fix');
  r.git('update-ref', 'refs/remotes/origin/feat/fix-2', 'HEAD');
  const made = new Worktrees(r.dir).create('pixel-a1b2', undefined, undefined, 'feat/fix');
  assert.equal(typeof made === 'object' && made.branch, 'feat/fix-3');
});

test('cleanup lists only the office\'s branches, and forgets the ones it deletes', async (t) => {
  const r = repo();
  t.after(r.close);
  const trees = new Worktrees(r.dir);
  r.git('branch', 'feat/mine');
  r.git('branch', 'office/old-worker-ab12');
  const made = trees.create('pixel-a1b2', undefined, undefined, 'feat/theirs');
  if (typeof made === 'string') return assert.fail(made);
  const { branches } = await trees.list();
  assert.deepEqual(branches.sort(), ['feat/theirs', 'office/old-worker-ab12']);

  assert.equal(await trees.remove(made, 'all'), undefined);
  assert.deepEqual([...trees.recorded()], []);
  assert.deepEqual((await trees.list()).branches, ['office/old-worker-ab12']);
});

test('a recorded branch deleted by hand is forgotten, so a later one by that name is yours', async (t) => {
  const r = repo();
  t.after(r.close);
  const trees = new Worktrees(r.dir);
  const made = trees.create('pixel-a1b2', undefined, undefined, 'feat/x');
  if (typeof made === 'string') return assert.fail(made);
  r.git('worktree', 'remove', '--force', made.path);
  r.git('branch', '-D', 'feat/x');
  await trees.list();
  assert.deepEqual([...trees.recorded()], []);
});

test('a floor keeps its branch template, and turns bad ones away', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'office-building-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, 'project');
  mkdirSync(project);
  const building = new Building(home, home);
  const def = building.ensureLocal(project, 'sam');
  assert.equal(def.branchTemplate, undefined);

  // The message handler checks a template with templateError before it gets here.
  assert.match(templateError('feat/{ticket}')!, /ticket/);
  building.setBranchTemplate(def.id, ' feat/{issue}-{slug} ');
  assert.equal(new Building(home, home).list()[0].branchTemplate, 'feat/{issue}-{slug}');

  building.setBranchTemplate(def.id, '');
  assert.equal(new Building(home, home).list()[0].branchTemplate, undefined);

  // One edited by hand into something git won't take is dropped on load.
  const file = path.join(home, 'floors.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved[0].branchTemplate = 'feat {slug}';
  writeFileSync(file, JSON.stringify(saved));
  assert.equal(new Building(home, home).list()[0].branchTemplate, undefined);
});

test('a new worktree gets the gitignored files .worktreeinclude names, and nothing else', (t) => {
  const r = repo();
  t.after(r.close);
  writeFileSync(path.join(r.dir, '.gitignore'), '.env\n*.local\nsecret.txt\n.agent-office/\n');
  writeFileSync(path.join(r.dir, '.worktreeinclude'), '.env\nconfig/*.local\nnotes.md\n');
  r.git('add', '.gitignore', '.worktreeinclude');
  r.git('commit', '-q', '-m', 'ignore');
  mkdirSync(path.join(r.dir, 'config'));
  writeFileSync(path.join(r.dir, '.env'), 'KEY=1\n');
  writeFileSync(path.join(r.dir, 'config', 'db.local'), 'db\n');
  writeFileSync(path.join(r.dir, 'secret.txt'), 'not included\n');
  writeFileSync(path.join(r.dir, 'notes.md'), 'included but not ignored\n');
  const made = new Worktrees(r.dir).create('pixel-a1b2', undefined, undefined, 'feat/env');
  if (typeof made === 'string') return assert.fail(made);
  const wt = path.join(r.dir, made.path);
  assert.equal(readFileSync(path.join(wt, '.env'), 'utf8'), 'KEY=1\n');
  assert.equal(readFileSync(path.join(wt, 'config', 'db.local'), 'utf8'), 'db\n');
  assert.equal(existsSync(path.join(wt, 'secret.txt')), false);
  assert.equal(existsSync(path.join(wt, 'notes.md')), false);
});

test("Cursor's worktrees.json setup runs in the worktree with ROOT_WORKTREE_PATH, then hands over", (t) => {
  const r = repo();
  t.after(r.close);
  mkdirSync(path.join(r.dir, '.cursor'));
  writeFileSync(path.join(r.dir, '.cursor', 'worktrees.json'), JSON.stringify({ 'setup-worktree': ['echo "$ROOT_WORKTREE_PATH" > root.txt', 'pwd > where.txt'] }));
  const trees = new Worktrees(r.dir);
  const made = trees.create('pixel-a1b2', undefined, undefined, 'feat/setup');
  if (typeof made === 'string') return assert.fail(made);
  const script = trees.setupScript(made.path);
  assert.ok(script);
  const wt = path.join(r.dir, made.path);
  const out = execFileSync('sh', ['-c', `${script}\nexec "$0" "$@"`, 'echo', 'agent started'], { cwd: wt, encoding: 'utf8' });
  assert.match(out, /agent started/);
  assert.equal(readFileSync(path.join(wt, 'root.txt'), 'utf8').trim(), r.dir);
  assert.equal(realpathSync(readFileSync(path.join(wt, 'where.txt'), 'utf8').trim()), realpathSync(wt));
});

test('a failing setup still starts the worker, and a script path or -unix entry is used', (t) => {
  const r = repo();
  t.after(r.close);
  mkdirSync(path.join(r.dir, '.cursor'));
  writeFileSync(path.join(r.dir, '.cursor', 'setup.sh'), 'touch from-script.txt\nexit 3\n');
  writeFileSync(path.join(r.dir, '.cursor', 'worktrees.json'), JSON.stringify({ 'setup-worktree-unix': 'setup.sh', 'setup-worktree': ['touch generic.txt'] }));
  const trees = new Worktrees(r.dir);
  const made = trees.create('pixel-a1b2', undefined, undefined, 'feat/fails');
  if (typeof made === 'string') return assert.fail(made);
  const wt = path.join(r.dir, made.path);
  const out = execFileSync('sh', ['-c', `${trees.setupScript(made.path)}\nexec "$0" "$@"`, 'echo', 'agent started'], { cwd: wt, encoding: 'utf8' });
  assert.match(out, /setup failed \(exit 3\)/);
  assert.match(out, /agent started/);
  assert.equal(existsSync(path.join(wt, 'from-script.txt')), true);
  assert.equal(existsSync(path.join(wt, 'generic.txt')), false);
});

test('no worktrees.json, no setup', (t) => {
  const r = repo();
  t.after(r.close);
  const trees = new Worktrees(r.dir);
  const made = trees.create('pixel-a1b2', undefined, undefined, 'feat/plain');
  if (typeof made === 'string') return assert.fail(made);
  assert.equal(trees.setupScript(made.path), undefined);
});
