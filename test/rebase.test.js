import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/git.js';
import {
  COMMIT_LIST_FORMAT,
  buildTodo,
  cleanup,
  fixupExclusions,
  fixupLogArgs,
  foldArgs,
  loadPlan,
  parseCommitList,
  planProblem,
  planSummary,
  prepare,
} from '../src/rebase.js';

const row = (hash, action = 'pick', extra = {}) => ({ hash, subject: `s ${hash}`, action, ...extra });

test('todo: rewording is a pick followed by an amend from a file', () => {
  const { todo, messages } = buildTodo([row('aaa'), row('bbb', 'reword', { newMessage: "It's new\n\nBody" }), row('ccc', 'fixup')], (i) => `C:\\x y\\m${i}.txt`);
  assert.equal(todo, "pick aaa s aaa\npick bbb s bbb\nexec git commit --amend --quiet --allow-empty -F 'C:/x y/m1.txt'\nfixup ccc s ccc\n");
  assert.deepEqual(messages, [{ file: 'C:\\x y\\m1.txt', text: "It's new\n\nBody\n" }]);
});

test('plan problems and summary', () => {
  assert.match(planProblem([row('a', 'squash'), row('b')]), /oldest commit kept/);
  assert.match(planProblem([row('a', 'drop'), row('b', 'fixup')]), /oldest commit kept/);
  assert.match(planProblem([row('a', 'reword', { newMessage: ' ' })]), /new message/);
  assert.equal(planProblem([row('a'), row('b', 'squash')]), null);
  assert.equal(planSummary([row('a'), row('b', 'squash'), row('c', 'squash'), row('d', 'drop')]), '2 squashed, 1 dropped');
  assert.equal(planSummary([row('a'), row('b')]), 'reordered');
});

test('fixup: which refs to leave out of the candidates, the log that lists them, and the fold', () => {
  const local = ['main', 'feature'];
  const def = { name: 'main', ref: 'origin/main' };
  // On a feature branch: its upstream and the default branch, both copies.
  assert.deepEqual(fixupExclusions({ head: 'feature', upstream: 'origin/feature', def, local }), ['origin/feature', 'main', 'origin/main']);
  // A default branch with no local copy.
  assert.deepEqual(fixupExclusions({ head: 'feature', upstream: null, def: { name: 'develop', ref: 'origin/develop' }, local }), ['origin/develop']);
  // On the default branch itself, only its upstream counts; with no upstream, nothing does.
  assert.deepEqual(fixupExclusions({ head: 'main', upstream: 'origin/main', def, local }), ['origin/main']);
  assert.deepEqual(fixupExclusions({ head: 'main', upstream: null, def: { name: 'main', ref: 'main' }, local: ['main'] }), []);
  assert.deepEqual(fixupExclusions({ head: 'topic', upstream: null, def: { name: 'master', ref: 'master' }, local: ['master', 'topic'] }), ['master']);
  assert.deepEqual(fixupExclusions({ head: 'topic', upstream: null, def: null, local: ['topic'] }), []);

  assert.deepEqual(fixupLogArgs(['origin/feature', 'main']), ['log', '-n200', '--no-merges', `--format=${COMMIT_LIST_FORMAT}`, 'HEAD', '--not', 'origin/feature', 'main', '--']);
  assert.deepEqual(fixupLogArgs([]), ['log', '-n30', '--no-merges', `--format=${COMMIT_LIST_FORMAT}`, 'HEAD', '--']);

  const list = parseCommitList('aaa\x1fppp\x1f1700000000\x1fFix it\nbbb\x1f\x1f1600000000\x1fFirst: a, b\n');
  assert.deepEqual(list, [
    { hash: 'aaa', parents: ['ppp'], time: 1700000000, subject: 'Fix it' },
    { hash: 'bbb', parents: [], time: 1600000000, subject: 'First: a, b' },
  ]);
  assert.deepEqual(foldArgs(list[0]), ['rebase', '-i', '--autosquash', 'ppp']);
  assert.deepEqual(foldArgs(list[1], { autostash: true }), ['rebase', '-i', '--autosquash', '--autostash', '--root']);
});

let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'tiller rebase '));
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  for (const n of ['one', 'two', 'three', 'four', 'five']) {
    writeFileSync(join(dir, `${n}.txt`), `${n}\n`);
    git('add', '.');
    git('commit', '-q', '-m', `Add ${n}`);
  }
});
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

test('a real rebase: drop, squash, reword and reorder in one go, in a path with spaces', async () => {
  const base = git('rev-parse', 'HEAD~4');
  const rows = await loadPlan(dir, base);
  assert.deepEqual(rows.map((r) => r.subject), ['Add two', 'Add three', 'Add four', 'Add five']);
  // Oldest first: keep two, fold three into it, drop four, reword five, and move five before two.
  const [two, three, four, five] = rows;
  const plan = [{ ...five, action: 'reword', newMessage: "Five, renamed (it's fine)" }, { ...two }, { ...three, action: 'squash' }, { ...four, action: 'drop' }];
  const gitDir = join(dir, '.git');
  const { env } = await prepare(gitDir, plan);
  await run(dir, ['rebase', '-i', base], { env });
  await cleanup(gitDir);

  assert.deepEqual(git('log', '--format=%s').split('\n'), ['Add two', "Five, renamed (it's fine)", 'Add one']);
  // The squash kept both messages and none of git's "# This is a combination" comments.
  const squashed = git('log', '-1', '--format=%B');
  assert.match(squashed, /Add two\s+Add three/);
  assert.doesNotMatch(squashed, /^#/m);
  assert.equal(existsSync(join(dir, 'four.txt')), false);
  assert.equal(existsSync(join(dir, 'three.txt')), true);
  assert.equal(existsSync(join(gitDir, 'tiller-rebase')), false);
});
