// Notifications: the escape sequences and what's worth saying (pure), then through the real UI against a
// throwaway repository, with a recorder in place of the terminal and stubs for Claude and the PR host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { notification, prNews, worthNotifying } from '../src/notify.js';
import { App } from '../src/ui/App.jsx';

test('a bell, then OSC 9, or OSC 777 in VTE terminals, with nothing that could end it early', () => {
  assert.equal(notification('Splice: git fetch', 'Done · 12 s', {}), '\x07\x1b]9;Splice: git fetch: Done · 12 s\x07');
  assert.equal(notification('a;b', 'c\x07d', { VTE_VERSION: '7600' }), '\x07\x1b]777;notify;a,b;c d\x1b\\');
  assert.equal(notification('Splice', '', { TERM: 'foot' }), '\x07\x1b]777;notify;Splice;\x1b\\');
});

test('only runs past the threshold, and not when turned off', () => {
  assert.equal(worthNotifying(9_000, {}), false);
  assert.equal(worthNotifying(10_000, {}), true);
  assert.equal(worthNotifying(600, { notifyAfter: 0.5 }), true);
  assert.equal(worthNotifying(60_000, { notify: false }), false);
});

const pr = (over = {}) => ({ id: 7, label: '#7', title: 'Bump b', author: 'me', mine: true, checks: { passed: 0, failed: 0, pending: 0 }, reviews: [], ...over });

test('PR news: checks that finish, and reviews that land, on your own pull requests only', () => {
  const running = pr({ checks: { passed: 1, failed: 0, pending: 2 } });
  assert.deepEqual(prNews([running], [pr({ checks: { passed: 3, failed: 0, pending: 0 } })]), [{ title: '#7 Bump b', body: 'All 3 checks passed' }]);
  assert.deepEqual(prNews([running], [pr({ checks: { passed: 2, failed: 1, pending: 0 } })]), [{ title: '#7 Bump b', body: '1 of 3 checks failed' }]);
  assert.deepEqual(prNews([running], [pr({ checks: { passed: 2, failed: 0, pending: 1 } })]), [], 'still running');
  assert.deepEqual(prNews([pr({ checks: { passed: 3, failed: 0, pending: 0 } })], [pr({ checks: { passed: 3, failed: 0, pending: 0 } })]), [], 'done already');
  assert.deepEqual(prNews([pr({ mine: false, checks: running.checks })], [pr({ mine: false })]), [], "someone else's");
  assert.deepEqual(prNews([], [pr()]), [], 'seen for the first time');
  // Azure DevOps lists no checks.
  assert.deepEqual(prNews([pr({ checks: null })], [pr({ checks: null })]), []);

  const approved = { by: 'bo', state: 'APPROVED', at: '2026-10-21T10:00:00Z' };
  assert.deepEqual(prNews([pr()], [pr({ reviews: [approved] })]), [{ title: '#7 Bump b', body: 'bo approved it' }]);
  assert.deepEqual(prNews([pr({ reviews: [approved] })], [pr({ reviews: [approved] })]), [], 'the same review');
  const again = { by: 'bo', state: 'CHANGES_REQUESTED', at: '2026-10-21T11:00:00Z' };
  assert.deepEqual(prNews([pr({ reviews: [approved] })], [pr({ reviews: [again] })]), [{ title: '#7 Bump b', body: 'bo asked for changes' }]);
  assert.deepEqual(prNews([pr()], [pr({ reviews: [{ by: 'me', state: 'COMMENTED', at: 'x' }] })]), [], 'your own comments');
  // Azure DevOps: a vote that changes.
  assert.deepEqual(prNews([pr({ reviews: [{ by: 'Ana', state: 'waiting', at: '' }] })], [pr({ reviews: [{ by: 'Ana', state: 'approved', at: '' }] })]), [{ title: '#7 Bump b', body: 'Ana approved it' }]);
});

let base;
let dir;
let lastApp = null;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-notify-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
});

after(() => removeTemp(base));

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

function start(props) {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [], notifyAfter: 0 }, ...props }));
  return lastApp;
}

test('a command past the threshold rings and says how it went; a cancelled one, or with notifying off, says nothing', async () => {
  const told = [];
  let answer = null;
  const askClaude = (prompt, { signal }) =>
    new Promise((done, fail) => {
      answer = done;
      signal.addEventListener('abort', () => fail(Object.assign(new Error('Cancelled'), { cancelled: true })));
    });
  const app = start({ notify: (title, body) => told.push([title, body]), askClaude });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    app.stdin.write('f');
    await until(() => told.length === 1, 'the fetch to notify');
    assert.deepEqual(told[0], ['Splice: git fetch --all --prune', 'Done (repo)']);

    // Claude explains the commit under the cursor: esc cancels, and that says nothing.
    app.stdin.write('j');
    await until(() => /❯.*First commit/.test(frame()), 'the cursor on the commit');
    app.stdin.write('e');
    await until(() => answer, 'Claude to be asked');
    app.stdin.write('\x1b');
    await until(() => frame().includes('Cancelled'), 'the cancel');
    assert.equal(told.length, 1);

    answer = null;
    app.stdin.write('e');
    await until(() => answer, 'Claude to be asked again');
    answer('It adds a.txt.');
    await until(() => told.length === 2, "Claude's answer to notify");
    assert.match(told[1][0], /^Splice: claude: explain/);
    assert.equal(told[1][1], 'Done (repo)');
  } finally {
    app.unmount();
  }

  const quiet = [];
  const off = start({ notify: (title, body) => quiet.push([title, body]), config: { recent: [], roots: [], history: [], notifyAfter: 0, notify: false } });
  try {
    await until(() => (off.lastFrame() ?? '').includes('First commit'), 'the graph');
    off.stdin.write('f');
    await until(() => (off.lastFrame() ?? '').includes('git fetch --all --prune') && !(off.lastFrame() ?? '').includes('Fetching'), 'the fetch');
    assert.deepEqual(quiet, []);
  } finally {
    off.unmount();
  }
});

test('the PR list poll says when the checks of your pull request finish, and when a review lands', async () => {
  const told = [];
  const lists = [
    [pr({ checks: { passed: 1, failed: 0, pending: 1 } })],
    [pr({ checks: { passed: 2, failed: 0, pending: 0 }, reviews: [{ by: 'bo', state: 'APPROVED', at: '2026-10-21T10:00:00Z' }] })],
  ];
  // The host answers with the list as it stands, which changes only when the test says so: a refetch of
  // its own (the poll's, when a minute turns over) then finds nothing new, as it would for real.
  let calls = 0;
  let now = 0;
  const host = {
    kind: 'github',
    name: 'GitHub',
    signIn: 'gh auth login',
    remoteName: 'origin',
    list: async () => (calls++, lists[now]).map((p) => ({ ...p, source: 'bump', target: 'main', draft: false, url: 'https://example.invalid/7', time: 0, review: { text: 'Approved', tone: 'good' }, reviewers: [], description: '' })),
    detail: async () => ({ reviewers: [], checks: [], comments: [], conflicts: false }),
  };
  const app = start({ notify: (title, body) => told.push([title, body]), makeHost: () => host });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    app.stdin.write('6');
    await until(() => /❯.*Bump b/.test(frame()) && calls >= 1, 'the PR');
    assert.deepEqual(told, [], 'the first list has nothing to compare with');
    // The checks finish and a review lands; r fetches the list again, as the minute's poll does.
    now = 1;
    const before = calls;
    app.stdin.write('r');
    await until(() => calls > before && told.length === 2, 'the news');
    assert.deepEqual(told, [
      ['Splice: #7 Bump b', 'All 2 checks passed'],
      ['Splice: #7 Bump b', 'bo approved it'],
    ]);
    assert.match(frame(), /#7 Bump b: bo approved it/);
  } finally {
    app.unmount();
  }
});
