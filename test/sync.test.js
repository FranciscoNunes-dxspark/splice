// /sync: what it does with each branch (pure), then the real thing through the UI, against a throwaway
// repository whose "origin" is a bare one that a second clone pushes to, with a worktree beside it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { App } from '../src/ui/App.jsx';
import { forcePushes, forwardInput, planSync, syncSummary, syncText, updateBranchArgs } from '../src/sync.js';
import { classify, describeUndo } from '../src/undo.js';

const branch = (name, upstream, extra = {}) => ({ name, upstream, oid: `${name}-old`, ahead: 0, behind: 0, gone: false, ...extra });

test('sync plan: only-behind branches move, the rest stay with a reason', () => {
  const refs = {
    local: [
      branch('main', 'origin/main', { behind: 2 }),
      branch('behind', 'origin/behind', { behind: 1 }),
      branch('ahead', 'origin/ahead', { ahead: 3 }),
      branch('div', 'origin/div', { ahead: 1, behind: 1 }),
      branch('gone', 'origin/gone', { gone: true }),
      branch('there', 'origin/there', { behind: 1 }),
      branch('same', 'origin/same'),
      branch('local-only', null),
      branch('on-main', 'main', { behind: 1 }),
    ],
    remote: ['main', 'behind', 'ahead', 'div', 'there', 'same'].map((n) => ({ name: `origin/${n}`, oid: `${n}-new` })),
  };
  refs.local.find((b) => b.name === 'main').oid = 'main-old';
  const plan = planSync({ refs, current: 'main', elsewhere: new Map([['there', '/wt']]) });
  assert.equal(plan.current.name, 'main');
  assert.equal(plan.current.to, 'main-new');
  assert.deepEqual(plan.forward.map((b) => [b.name, b.from, b.to]), [['behind', 'behind-old', 'behind-new'], ['on-main', 'on-main-old', 'main-old']]);
  assert.deepEqual(plan.ahead.map((b) => b.name), ['ahead']);
  assert.deepEqual(plan.diverged.map((b) => b.name), ['div']);
  assert.deepEqual(plan.gone.map((b) => b.name), ['gone']);
  assert.deepEqual(plan.skipped.map((b) => [b.name, b.why]), [['there', 'checked out in /wt']]);
  assert.deepEqual(plan.upToDate.map((b) => b.name), ['same']);
  assert.equal(forwardInput(plan.forward.slice(0, 1)), 'update refs/heads/behind behind-new behind-old\n');

  // With uncommitted changes the current branch stays.
  const dirty = planSync({ refs, current: 'main', dirty: true });
  assert.equal(dirty.current, null);
  assert.match(dirty.skipped[0].why, /uncommitted changes/);

  const text = syncText(plan, { moved: ['main'], failed: [{ name: 'behind', why: 'cannot lock ref' }] });
  assert.match(text, /^Fast-forwarded \(1\)\n {2}main\s+main-ol → main-ne, 2 commits from origin\/main$/m);
  assert.match(text, /^Couldn't be moved \(1\)\n {2}behind\s+cannot lock ref$/m);
  assert.match(text, /^Diverged, left alone \(1\)\n {2}div\s+↑1 ↓1 against origin\/div/m);
  assert.match(text, /^Upstream gone \(1\)\n {2}gone\s+origin\/gone was deleted: \/cleanup/m);
  assert.match(text, /^Up to date: same$/m);
  assert.equal(syncSummary(plan, { moved: ['main'], failed: [] }), 'Synced: 1 fast-forwarded, 1 diverged, 1 ahead, 1 not moved, 1 with the upstream gone');
  assert.equal(syncSummary({ ...plan, diverged: [], ahead: [], skipped: [], gone: [] }, {}), 'Synced: every branch is up to date');
  assert.match(syncText(planSync({ refs: { local: [branch('x', null)], remote: [] } })), /No local branch tracks a remote branch/);
});

test('force pushes go per remote, each branch to its upstream; /update-branch arguments', () => {
  assert.deepEqual(
    forcePushes([{ name: 'a', upstream: 'origin/a' }, { name: 'b', upstream: 'my/fork/b2' }, { name: 'c', upstream: 'origin/c' }], ['origin', 'my/fork', 'my']),
    [
      ['push', '--force-with-lease', 'origin', 'a:a', 'c:c'],
      ['push', '--force-with-lease', 'my/fork', 'b:b2'],
    ],
  );
  assert.deepEqual(updateBranchArgs([]), { base: null, stack: false });
  assert.deepEqual(updateBranchArgs(['--stack', 'origin/dev']), { base: 'origin/dev', stack: true });
  assert.match(updateBranchArgs(['--force']).error, /not --force/);
  assert.match(updateBranchArgs(['a', 'b']).error, /Name one branch/);
});

test('undo knows a sync', () => {
  const entry = { hash: 'b', subject: 'Theirs', action: 'sync', message: 'Fast-forward', ...classify('sync') };
  const plan = { kind: 'reset', mode: 'keep', entry, target: 'a'.repeat(40), targetSubject: 'Mine', branch: 'main' };
  const said = describeUndo(plan, { pushed: 'origin/main' });
  assert.equal(said.title, 'Undo the sync of main with its upstream?');
  assert.match(said.detail, /^main goes back to aaaaaaa "Mine", behind its upstream again/);
  assert.doesNotMatch(said.detail, /--force/);
});

let base;
let dir;
let other;
let wt;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const git = (...args) => run(dir, ...args);
const commitIn = (cwd, file, text, message) => {
  writeFileSync(join(cwd, file), text);
  run(cwd, 'add', '.');
  run(cwd, 'commit', '-q', '-m', message);
};
const configure = (cwd) => {
  run(cwd, 'config', 'core.autocrlf', 'false');
  run(cwd, 'config', 'user.name', 'Test');
  run(cwd, 'config', 'user.email', 'test@example.com');
  run(cwd, 'config', 'commit.gpgsign', 'false');
};

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-sync-'));
  dir = join(base, 'repo');
  other = join(base, 'other');
  wt = join(base, 'wt');
  const origin = join(base, 'origin.git');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  run(dir, 'init', '-q', '-b', 'main');
  configure(dir);
  commitIn(dir, 'a.txt', 'one\n', 'First commit');
  run(dir, 'remote', 'add', 'origin', origin);
  run(dir, 'push', '-q', '-u', 'origin', 'main');
  for (const b of ['behind', 'ahead', 'div', 'gone', 'busy']) {
    run(dir, 'branch', b);
    run(dir, 'push', '-q', '-u', 'origin', b);
  }
  run(dir, 'worktree', 'add', '-q', wt, 'busy');

  // Someone else pushes to main, behind, div and busy, and deletes gone.
  run(base, 'clone', '-q', origin, other);
  configure(other);
  for (const b of ['main', 'behind', 'div', 'busy']) {
    run(other, 'switch', '-q', b);
    commitIn(other, `${b}.txt`, `${b}\n`, `Theirs on ${b}`);
    run(other, 'push', '-q', 'origin', b);
  }
  run(other, 'push', '-q', 'origin', '--delete', 'gone');

  // Here: a commit of our own on ahead and on div.
  run(dir, 'switch', '-q', 'ahead');
  commitIn(dir, 'ahead.txt', 'mine\n', 'Mine on ahead');
  run(dir, 'switch', '-q', 'div');
  commitIn(dir, 'div-mine.txt', 'mine\n', 'Mine on div');
  run(dir, 'switch', '-q', 'main');
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let ok = false;
    try {
      ok = check();
    } catch {
      // A ref being moved can briefly read as broken: not yet.
    }
    if (ok) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

const command = async (app, text) => {
  app.stdin.write('/');
  await type(app.stdin, text);
  await until(() => app.lastFrame().includes(`/${text}`), `the typed /${text}`);
  app.stdin.write('\r');
};

test('S in Branches fetches, fast-forwards what is only behind, reports the rest, and z undoes it; a diverged branch is offered a rebase', async () => {
  const was = Object.fromEntries(['main', 'behind', 'ahead', 'div', 'busy'].map((b) => [b, git('rev-parse', b)]));
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Mine on div'), 'the graph');
    app.stdin.write('3');
    await until(() => frame().includes('Local (6)'), 'the Branches view');
    app.stdin.write('S');
    await until(() => frame().includes('Fast-forwarded (2)'), 'the report', 15000);
    assert.match(frame(), /Diverged, left alone \(1\)/);
    assert.match(frame(), /Ahead, left alone \(1\)/);
    assert.match(frame(), /Not moved \(1\)/);
    assert.match(frame(), /busy\s+↓1 behind origin\/busy, but checked out in/);
    assert.match(frame(), /Upstream gone \(1\)/);
    // Both moved to what origin has, the one checked out in the worktree didn't, and nor did the others.
    assert.equal(git('rev-parse', 'main'), git('rev-parse', 'origin/main'));
    assert.equal(git('rev-parse', 'behind'), git('rev-parse', 'origin/behind'));
    assert.notEqual(git('rev-parse', 'main'), was.main);
    for (const b of ['ahead', 'div', 'busy']) assert.equal(git('rev-parse', b), was[b], `${b} stays`);
    assert.equal(run(wt, 'status', '--porcelain'), '');
    assert.equal(git('status', '--porcelain'), '');
    assert.match(git('reflog', '-1', '--format=%gs', 'behind'), /^sync: fast-forward/);

    // z takes main back where it was.
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Fast-forwarded (2)'), 'the report closed');
    app.stdin.write('z');
    await until(() => frame().includes('Undo the sync of main with its upstream?'), 'the undo question');
    app.stdin.write('1');
    await until(() => git('rev-parse', 'main') === was.main, 'main back where it was');

    // On div, which has diverged: /sync offers to rebase it onto origin/div.
    app.stdin.write('2');
    await command(app, 'checkout div');
    await until(() => frame().includes('⎇ div'), 'div checked out');
    await command(app, 'sync');
    await until(() => frame().includes('div and origin/div have diverged. Rebase div onto origin/div?'), 'the offer to rebase', 15000);
    assert.match(frame(), /No conflicts expected/);
    app.stdin.write('1');
    await until(() => git('log', '-1', '--format=%s', 'div') === 'Mine on div' && git('rev-parse', 'div~1') === git('rev-parse', 'origin/div'), 'div rebased onto origin/div', 15000);
    await until(() => !frame().includes('REBASING'), 'no rebase in progress');
    // And main was fast-forwarded again on the way, without being checked out.
    assert.equal(git('rev-parse', 'main'), git('rev-parse', 'origin/main'));
  } finally {
    app.unmount();
  }
});
