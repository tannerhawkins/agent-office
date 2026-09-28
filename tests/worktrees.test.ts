import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BRANCHES_FILE, Worktrees } from '../src/server/worktrees.js';
import { Building } from '../src/server/building.js';

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
  const made = trees.create('pixel-a1b2', 'feat/12-fix-login');
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
  const made = new Worktrees(r.dir).create('pixel-a1b2', 'feat/fix');
  assert.equal(typeof made === 'object' && made.branch, 'feat/fix-3');
});

test('cleanup lists only the office\'s branches, and forgets the ones it deletes', async (t) => {
  const r = repo();
  t.after(r.close);
  const trees = new Worktrees(r.dir);
  r.git('branch', 'feat/mine');
  r.git('branch', 'office/old-worker-ab12');
  const made = trees.create('pixel-a1b2', 'feat/theirs');
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
  const made = trees.create('pixel-a1b2', 'feat/x');
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

  assert.match(building.setBranchTemplate(def.id, 'feat/{ticket}')!, /ticket/);
  assert.equal(building.setBranchTemplate(def.id, ' feat/{issue}-{slug} '), undefined);
  assert.equal(new Building(home, home).list()[0].branchTemplate, 'feat/{issue}-{slug}');

  assert.equal(building.setBranchTemplate(def.id, ''), undefined);
  assert.equal(new Building(home, home).list()[0].branchTemplate, undefined);

  // One edited by hand into something git won't take is dropped on load.
  const file = path.join(home, 'floors.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved[0].branchTemplate = 'feat {slug}';
  writeFileSync(file, JSON.stringify(saved));
  assert.equal(new Building(home, home).list()[0].branchTemplate, undefined);
});
