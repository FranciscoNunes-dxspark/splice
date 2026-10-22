// /review-pr and w in PRs: a pull request checked out in a worktree of its own beside the repository, from
// the host's ref for its head (a fork's, here), opened in Splice; again, brought up to date; and gone with
// /cleanup once it's merged. A real bare repository is the remote, a stub the PR host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { App } from '../src/ui/App.jsx';

let base;
let dir;
let origin;
let fork;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const git = (...args) => run(dir, ...args);

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-review-'));
  dir = join(base, 'repo');
  origin = join(base, 'origin.git');
  fork = join(base, 'fork');
  mkdirSync(dir);
  mkdirSync(fork);
  process.env.SPLICE_HOME = join(base, 'home');
  run(base, 'init', '-q', '--bare', '-b', 'main', origin);
  for (const d of [dir, fork]) {
    run(d, 'init', '-q', '-b', 'main');
    run(d, 'config', 'core.autocrlf', 'false');
    run(d, 'config', 'user.name', 'Test');
    run(d, 'config', 'user.email', 'test@example.com');
    run(d, 'config', 'commit.gpgsign', 'false');
  }
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  // Someone else's work, from a fork: the server keeps its head at refs/pull/7/head.
  run(fork, 'fetch', '-q', origin, 'main');
  run(fork, 'reset', '-q', '--hard', 'FETCH_HEAD');
  writeFileSync(join(fork, 'b.txt'), 'b\n');
  run(fork, 'add', '.');
  run(fork, 'commit', '-q', '-m', 'Their change');
  run(fork, 'push', '-q', origin, 'HEAD:refs/pull/7/head');
  // Work of your own in progress, which reviewing mustn't disturb.
  writeFileSync(join(dir, 'a.txt'), 'mine, not committed\n');
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let ok = false;
    try {
      ok = check();
    } catch {
      // git read mid-change: not yet
    }
    if (ok) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

// Whether the prompt holds `text`: all of it, or its end, when a long path has scrolled the start out of the box.
const typed = (frame, text) => [...frame.matchAll(/│ > (.*?) *│/g)].some(([, shown]) => shown && text.endsWith(shown));

async function command(app, text) {
  app.stdin.write('/');
  await until(() => app.lastFrame().includes('> /'), 'the prompt');
  for (const ch of text) {
    app.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
  await until(() => typed(app.lastFrame(), `/${text}`), `/${text} typed`);
  app.stdin.write('\r');
}

test('w in PRs reviews a pull request in its own worktree; /review-pr updates it; /cleanup removes it once merged', async () => {
  const pr = { id: 7, label: '#7', title: 'Their change', author: 'ana', mine: false, reviewMe: true, source: 'their-feature', target: 'main', head: null, draft: false, url: 'https://example.invalid/pull/7', time: 0, review: { text: 'Review required', tone: 'wait' }, checks: null, reviewers: [], description: '', state: 'open' };
  const merged = [];
  const makeHost = () => ({
    kind: 'github',
    name: 'GitHub',
    signIn: 'gh auth login',
    remoteName: 'origin',
    list: async () => (pr.state === 'open' ? [pr] : []),
    merged: async () => merged,
    detail: async () => ({ reviewers: [], checks: [], comments: [], conflicts: false }),
    pr: async (id) => ({ ...pr, id }),
    headRef: (p) => `refs/pull/${p.id}/head`,
    defaultBranch: async () => 'main',
  });
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, makeHost }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const wt = join(base, 'repo-pr-7');
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    app.stdin.write('6');
    await until(() => /❯.*Their change/.test(frame()), 'the PR');
    app.stdin.write('w');
    await until(() => frame().includes('repo-pr-7  ⎇ pr-7'), 'Splice in the new worktree, on pr-7');
    assert.match(frame().replace(/\s+/g, ' '), /Reviewing #7 "Their change"/);
    assert.equal(run(wt, 'log', '-1', '--format=%s'), 'Their change');
    assert.equal(run(wt, 'rev-parse', 'pr-7'), run(origin, 'rev-parse', 'refs/pull/7/head'));
    assert.equal(git('status', '--porcelain'), 'M a.txt', 'your own work as it was');
    assert.equal(git('for-each-ref', 'refs/splice'), '', "Splice's fetched ref is gone");

    // The author pushes again; /review-pr brings the worktree up to date (from inside it, here).
    writeFileSync(join(fork, 'b.txt'), 'b, better\n');
    run(fork, 'commit', '-q', '-am', 'Address the review');
    run(fork, 'push', '-q', origin, 'HEAD:refs/pull/7/head');
    await command(app, 'review-pr 7');
    await until(() => run(wt, 'log', '-1', '--format=%s') === 'Address the review', 'the worktree up to date');
    await until(() => frame().includes('Fast-forward'), 'the update in the activity lines');

    // Merged: back in the main working tree, /cleanup takes the worktree and its branch.
    pr.state = 'merged';
    merged.push({ ...pr, head: run(origin, 'rev-parse', 'refs/pull/7/head'), fork: true });
    await command(app, `open ${dir}`);
    await until(() => frame().includes('repo  ⎇ main'), 'the main working tree');
    await command(app, 'cleanup');
    await until(() => frame().includes('Delete 1 branch and 1 worktree with nothing of yours on them?'), 'the cleanup question');
    assert.match(frame(), /pr-7\s+#7 was merged into main, after its worktree/);
    app.stdin.write('1');
    await until(() => !existsSync(wt) && !git('branch', '--list', 'pr-7'), 'the worktree and branch gone');
  } finally {
    app.unmount();
  }
});
