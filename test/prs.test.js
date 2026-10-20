// Managing pull requests from the PRs view: merging, checks, reviewers, draft and title. A stub stands in
// for the host, so nothing goes online; it records what Splice asked of it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { App } from '../src/ui/App.jsx';

let base;
let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-prs-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
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

const PR = { id: 7, label: '#7', title: 'Bump b', author: 'ana', mine: true, reviewMe: false, source: 'bump', target: 'main', draft: false, url: 'https://example.invalid/7', time: 0, review: { text: 'Approved', tone: 'good' }, checks: null, reviewers: [], description: 'Old body' };

/** A stub host that records every call as [name, ...args] in `calls`. */
function stubHost(calls, extra = {}) {
  return () => ({
    kind: 'github',
    name: 'GitHub',
    signIn: 'gh auth login',
    remoteName: 'origin',
    mergeMethods: ['squash', 'merge', 'rebase'],
    list: async () => [PR],
    detail: async () => ({ reviewers: [], checks: [], comments: [], conflicts: false }),
    merge: async (pr, opts) => calls.push(['merge', pr.id, opts]),
    ...extra,
  });
}

function start(makeHost) {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, makeHost }));
  return lastApp;
}

test('m in PRs merges the pull request: asks how, then when, then calls the host', async () => {
  const calls = [];
  const app = start(stubHost(calls));
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    app.stdin.write('6');
    await until(() => /❯.*Bump b/.test(frame()), 'the PR');
    app.stdin.write('m');
    await until(() => frame().includes('Merge #7 "Bump b" into main how?') && frame().includes('Rebase and merge'), 'the method question');
    app.stdin.write('1');
    await until(() => frame().includes('Merge #7 into main (squash)?') && frame().includes('Auto-merge once it can, keep bump'), 'the when question');
    app.stdin.write('3');
    await until(() => calls.length === 1, 'the merge');
    assert.deepEqual(calls[0], ['merge', 7, { method: 'squash', auto: true, deleteBranch: true }]);

    app.stdin.write('/');
    await type(app.stdin, 'merge-pr rebase --keep-branch');
    app.stdin.write('\r');
    await until(() => frame().includes('Merge #7 into main (rebase)?'), 'the confirmation for /merge-pr');
    app.stdin.write('1');
    await until(() => calls.length === 2 && frame().includes('Merged #7 into main'), 'the second merge');
    assert.deepEqual(calls[1], ['merge', 7, { method: 'rebase', auto: false, deleteBranch: false }]);
  } finally {
    app.unmount();
  }
});
