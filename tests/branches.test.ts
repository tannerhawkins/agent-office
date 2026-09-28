import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BRANCH_TEMPLATE, branchName, issueFromPrompt, refError, slugify, taskSlug, templateError } from '../src/shared/branches.js';

const vars = { user: 'Sam Lee', worker: 'Ada', id: 'a1b2', issue: 12, task: 'Fix the login redirect on Safari please now' };

test('the default template names branches as the office always has', () => {
  assert.equal(branchName(undefined, vars), 'office/ada-a1b2');
  assert.equal(branchName('', vars), 'office/ada-a1b2');
  assert.equal(branchName(DEFAULT_BRANCH_TEMPLATE, vars), 'office/ada-a1b2');
});

test('every placeholder is filled in, cleaned for git', () => {
  assert.equal(branchName('{user}/{issue}-{slug}', vars), 'sam-lee/12-fix-the-login-redirect-on-safari');
  assert.equal(branchName('feat/{worker}_{id}', vars), 'feat/ada_a1b2');
  assert.equal(branchName('{user}/{slug}', { ...vars, user: 'Sam (queue)' }), 'sam/fix-the-login-redirect-on-safari');
});

test('missing values drop out with the separator beside them', () => {
  const bare = { worker: 'Ada', id: 'a1b2' };
  assert.equal(branchName('feat/{issue}-{slug}', { ...bare, task: 'fix login' }), 'feat/fix-login');
  assert.equal(branchName('{user}/{slug}', { ...bare, task: 'fix login' }), 'fix-login');
  assert.equal(branchName('feat/{slug}-{issue}', { ...bare, task: 'fix login' }), 'feat/fix-login');
  // No task at all: the slug is the worker's name.
  assert.equal(branchName('feat/{slug}', bare), 'feat/ada');
});

test('slugs are short, lower-case and cut between words', () => {
  assert.equal(slugify('Héllo, Wörld!'), 'hello-world');
  assert.equal(taskSlug('\n  Add dark mode to the settings page and the whole app\nmore'), 'add-dark-mode-to-the-settings');
  assert.ok(slugify('a'.repeat(30) + ' ' + 'b'.repeat(30)).length <= 40);
  assert.equal(slugify('word '.repeat(20)).endsWith('-'), false);
});

test('an issue handed over from the board is recognized in the prompt', () => {
  assert.deepEqual(issueFromPrompt('Work on GitHub issue #42: "Login breaks".\n\nRead it first'), { issue: 42, title: 'Login breaks' });
  assert.equal(issueFromPrompt('fix #42'), undefined);
  assert.equal(issueFromPrompt(undefined), undefined);
});

test('templates are checked before a floor keeps them', () => {
  assert.equal(templateError(''), undefined);
  assert.equal(templateError('feat/{issue}-{slug}'), undefined);
  assert.equal(templateError('{user}/{worker}'), undefined);
  assert.match(templateError('feat/{ticket}-{slug}')!, /\{ticket\}/);
  assert.match(templateError('feat/{issue}')!, /slug/);
  assert.match(templateError('feat/{slug')!, /left over/);
  assert.match(templateError('feat {slug}')!, /git/i);
  assert.match(templateError('feat..x/{slug}')!, /git/i);
  assert.match(templateError('x'.repeat(101) + '{slug}')!, /100/);
});

test('refError follows git check-ref-format', () => {
  assert.equal(refError('feat/12-fix'), undefined);
  for (const bad of ['', 'a b', 'a..b', 'a/', '/a', 'a//b', '.a', 'a/.b', 'a.lock', 'a.', 'a~b', 'a@{b', '-a']) assert.ok(refError(bad), bad);
});
