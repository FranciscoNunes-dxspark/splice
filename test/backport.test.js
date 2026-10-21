// /backport: a merged pull request copied onto a release branch, from how it was merged (a merge commit,
// then a squash that stops on a conflict and goes on after /continue), pushed, and its pull request opened.
// A real bare repository is the remote, a stub the PR host.
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

let base;
let dir;
let origin;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const git = (...args) => run(dir, ...args);
const commit = (file, text, message) => {
  writeFileSync(join(dir, file), text);
  git('add', file);
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
};
const prs = new Map();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-backport-'));
  dir = join(base, 'repo');
  origin = join(base, 'origin.git');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  run(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  commit('c.txt', 'c\n', 'First commit');
  // The release branch, with a fix of its own to c.txt.
  git('switch', '-q', '-c', 'release/1');
  commit('c.txt', 'c, as released\n', 'Fix c for the release');
  // #5: two commits, merged into main with a merge commit.
  git('switch', '-q', '-c', 'search', 'main');
  const s1 = commit('s1.txt', 'one\n', 'Search, part one');
  const s2 = commit('s2.txt', 'two\n', 'Search, part two');
  git('switch', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'Merge pull request #5 from search', 'search');
  const m5 = git('rev-parse', 'HEAD');
  // #6: squashed into one commit on main, which changes c.txt as the release branch did, differently.
  const s6 = commit('c.txt', 'c, rewritten\n', 'Rewrite c (#6)');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main', 'release/1');
  git('branch', '-q', '-D', 'search', 'release/1');
  git('fetch', '-q', 'origin');
  const pr = (id, title, mergeCommit, commits) => ({ id, label: `#${id}`, title, source: `topic-${id}`, target: 'main', url: `https://example.invalid/pull/${id}`, state: 'merged', mergeCommit, commits, head: null });
  prs.set(5, pr(5, 'Add search', m5, [{ hash: s1, subject: 'Search, part one' }, { hash: s2, subject: 'Search, part two' }]));
  prs.set(6, pr(6, 'Rewrite c', s6, [{ hash: 'f00', subject: 'Rewrite c' }]));
  prs.set(8, { ...pr(8, 'Not yet', null, []), state: 'open' });
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

async function command(app, text) {
  app.stdin.write('/');
  await until(() => app.lastFrame().includes('> /'), 'the prompt');
  for (const ch of text) {
    app.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
  await until(() => app.lastFrame().includes(`> /${text}`), `/${text} typed`);
  app.stdin.write('\r');
}

test('/backport copies a merged PR onto a release branch, pushes it and opens its PR; a conflict waits for /continue', async () => {
  const created = [];
  const makeHost = () => ({
    kind: 'github',
    name: 'GitHub',
    signIn: 'gh auth login',
    remoteName: 'origin',
    list: async () => [],
    pr: async (id) => prs.get(id),
    create: async (opts) => {
      created.push(opts);
      return `https://example.invalid/pull/${20 + created.length}`;
    },
    defaultBranch: async () => 'main',
  });
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, makeHost }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const flat = () => frame().replace(/[│\s]+/g, ' ');
  try {
    await until(() => frame().includes('Rewrite c'), 'the graph');
    await command(app, 'backport 8 release/1');
    await until(() => frame().includes("#8 isn't merged yet"), 'an open PR refused');

    await command(app, 'backport 5 release/1');
    await until(() => frame().includes('Backport #5 to release/1?'), 'the question');
    assert.match(flat(), /Make backport\/5-to-release\/1 from origin\/release\/1/);
    assert.match(flat(), /its merge commit, as what it brought in \(-m 1\)/);
    assert.match(flat(), /"\[release\/1\] Add search"/);
    app.stdin.write('1');
    await until(() => created.length === 1, 'the pull request');
    assert.deepEqual({ ...created[0], body: undefined }, { title: '[release/1] Add search', body: undefined, source: 'backport/5-to-release/1', target: 'release/1' });
    assert.match(created[0].body, /Backport of #5 \(https:\/\/example\.invalid\/pull\/5\)/);
    const pushed = run(origin, 'rev-parse', 'refs/heads/backport/5-to-release/1');
    assert.equal(pushed, git('rev-parse', 'backport/5-to-release/1'));
    assert.equal(run(origin, 'show', `${pushed}:c.txt`), 'c, as released', "the release's own fix kept");
    assert.equal(run(origin, 'show', `${pushed}:s2.txt`), 'two');
    assert.match(git('log', '-1', '--format=%B', pushed), /cherry picked from commit/);
    assert.equal(git('rev-parse', '--abbrev-ref', 'backport/5-to-release/1@{upstream}'), 'origin/backport/5-to-release/1');

    // A squash merge whose change conflicts with the release branch's.
    await command(app, 'backport 6 release/1');
    await until(() => frame().includes('Backport #6 to release/1?'), 'the second question');
    assert.match(flat(), /the commit it was squashed into/);
    app.stdin.write('1');
    await until(() => frame().includes('The backport of #6 stopped while cherry-picking') && frame().includes('Fix it in Changes (2), then /continue'), 'stopped on the conflict');
    assert.match(frame(), /CHE/, 'the banner');
    assert.equal(created.length, 1);
    writeFileSync(join(dir, 'c.txt'), 'c, rewritten for the release\n');
    git('add', 'c.txt');
    app.stdin.write('2');
    await until(() => frame().includes('Staged (1)'), 'the resolution staged');
    await command(app, 'continue');
    await until(() => created.length === 2, 'the second pull request');
    assert.equal(created[1].title, '[release/1] Rewrite c');
    assert.equal(run(origin, 'show', 'refs/heads/backport/6-to-release/1:c.txt'), 'c, rewritten for the release');
    await until(() => frame().includes('Backported #6 to release/1'), 'the note');
    assert.ok(!frame().includes('CHE'), 'no banner');
  } finally {
    app.unmount();
  }
});
