// The history of some lines (L in blame, git log -L), driven through the real UI.
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
import { committedRange } from '../src/history.js';

let base;
let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();

test('working-tree lines to committed ones, around added, removed and changed lines', () => {
  // Committed: a b c d e f. Working tree: a NEW b c e F (one line added, d removed, f changed).
  const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,0 +2 @@', '+NEW', '@@ -4 +4,0 @@', '-d', '@@ -6 +6 @@', '-f', '+F', ''].join('\n');
  const at = (n) => committedRange(diff, n, n);
  assert.deepEqual(at(1), { from: 1, to: 1 });
  assert.equal(at(2), null, 'added: not committed');
  assert.deepEqual(at(3), { from: 2, to: 2 });
  assert.deepEqual(at(4), { from: 3, to: 3 });
  assert.deepEqual(at(5), { from: 5, to: 5 }, 'after the removed line');
  assert.equal(at(6), null, 'changed: the new text is not committed');
  assert.deepEqual(committedRange(diff, 1, 6), { from: 1, to: 5 });
});

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-lines-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  const write = (lines) => writeFileSync(join(dir, 'f.txt'), `${lines.join('\n')}\n`);
  write(['one', 'two', 'three', 'four']);
  git('add', '.');
  git('commit', '-q', '-m', 'Start the file');
  write(['one', 'TWO', 'three', 'four']);
  git('commit', '-q', '-am', 'Shout line two');
  write(['one', 'TWO', 'three', 'FOUR']);
  git('commit', '-q', '-am', 'Shout line four');
  // Uncommitted: a line on top, so the working tree's line numbers are one ahead of HEAD's.
  write(['zero', 'one', 'TWO', 'three', 'FOUR']);
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

test('in blame, v selects lines and L shows the commits that changed them', async () => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Start the file'), 'the graph');
    app.stdin.write('2');
    await until(() => /❯ M f\.txt/.test(frame()), 'the changed file');
    app.stdin.write('B');
    await until(() => frame().includes('Blame f.txt') && frame().includes('Not committed yet'), 'the blame');
    // Lines 3 and 4 of the working tree ("TWO", "three"): lines 2 and 3 in HEAD.
    app.stdin.write('j');
    await until(() => /❯.*│ one/.test(frame()), 'the cursor on one');
    app.stdin.write('j');
    await until(() => /❯.*│ TWO/.test(frame()), 'the cursor on TWO');
    app.stdin.write('v');
    app.stdin.write('j');
    await until(() => frame().includes('2 selected'), 'two lines selected');
    app.stdin.write('L');
    await until(() => frame().includes('Lines 2–3 of f.txt') && frame().includes('Shout line two'), 'the history of the lines');
    app.stdin.write('G');
    await until(() => frame().includes('Start the file'), 'the commit that wrote them first, further down');
    // Line four's commit isn't there: searching for it finds nothing.
    app.stdin.write('/');
    await until(() => frame().includes('↵ done'), 'the search');
    for (const ch of 'four') app.stdin.write(ch);
    await until(() => frame().includes('/four▏ no match'), 'no match');
    app.stdin.write('\x1b');
    await until(() => frame().includes('/ search · esc close'), 'the search cancelled');
    // Back to the blame.
    app.stdin.write('\x1b');
    await until(() => frame().includes('Blame f.txt'), 'back in the blame');
  } finally {
    app.unmount();
  }
});
