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

test("s in PRs lists the checks, failed first; ↵ shows a check's log and R re-runs the failed ones", async () => {
  const calls = [];
  const checks = [
    { name: 'lint', workflow: 'CI', state: 'pass', url: 'https://example.invalid/lint', runId: '1', jobId: '10' },
    { name: 'unit tests', workflow: 'CI', state: 'fail', url: 'https://example.invalid/unit', runId: '1', jobId: '11' },
  ];
  const app = start(
    stubHost(calls, {
      checks: async () => checks,
      checkLog: async (c) => `log of ${c.name}\nError: expected 2, got 3`,
      canRerun: true,
      rerun: async (pr, list) => {
        calls.push(['rerun', pr.id, list.map((c) => c.name)]);
      },
    }),
  );
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    app.stdin.write('6');
    await until(() => /❯.*Bump b/.test(frame()), 'the PR');
    app.stdin.write('s');
    await until(() => frame().includes('Checks of #7') && /❯ ✗ unit tests[\s\S]*✓ lint/.test(frame()), 'the checks, failed first');
    app.stdin.write('\r');
    await until(() => frame().includes('Error: expected 2, got 3'), 'the failed check’s log');
    app.stdin.write('\x1b');
    await until(() => frame().includes('Checks of #7'), 'back to the checks');
    app.stdin.write('R');
    await until(() => frame().includes('Re-run the 1 failed check of #7?'), 'the re-run question');
    app.stdin.write('1');
    await until(() => calls.length === 1, 'the re-run');
    assert.deepEqual(calls[0], ['rerun', 7, ['unit tests']]);
  } finally {
    app.unmount();
  }
});
