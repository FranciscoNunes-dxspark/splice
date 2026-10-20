// z (undo) and /reflog, driven through the real UI against a throwaway repository.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { enter: '\r', esc: '\x1b' };

let base;
let dir;
// Without optional locks, the status checks polled below can't take the index lock from under Tiller's own git.
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env }).trim();
const read = (name) => readFileSync(join(dir, name), 'utf8');

before(() => {
  base = mkdtempSync(join(tmpdir(), 'tiller-undo-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.TILLER_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
  git('branch', 'feature');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  git('commit', '-q', '-am', 'Fix typo');
});

// On Windows a git still finishing for an unmounted app keeps the folder busy for a moment.
after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let ok = false;
    try {
      ok = check();
    } catch {
      // On Windows, git reading the repository while Tiller's git rewrites HEAD can fail: that's "not yet".
    }
    // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
    if (ok) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

function start() {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  return lastApp;
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
  await until(() => (app.lastFrame() ?? '').includes(`/${text}`), `/${text} typed`);
  app.stdin.write(KEYS.enter);
};

test('z undoes a commit after asking, and a second z redoes it', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Fix typo'), 'the graph');
    app.stdin.write('z');
    await until(() => frame().includes('Undo the commit "Fix typo"?'), 'the confirmation');
    assert.match(frame(), /Its changes go back to staged/);
    app.stdin.write('2'); // No
    await until(() => !frame().includes('Undo the commit'), 'the dialog to close');
    assert.equal(git('log', '-1', '--format=%s'), 'Fix typo');

    app.stdin.write('z');
    await until(() => frame().includes('Undo the commit "Fix typo"?'), 'the confirmation again');
    app.stdin.write('1');
    await until(() => git('log', '-1', '--format=%s') === 'First commit', 'the commit to be undone');
    assert.equal(git('diff', '--cached', '--name-only'), 'a.txt');
    assert.equal(read('a.txt'), 'one\ntwo\n');
    await until(() => frame().includes('1 change'), 'the view to refresh');

    app.stdin.write('z');
    await until(() => frame().includes('Redo what was just undone?'), 'the redo confirmation');
    app.stdin.write('1');
    await until(() => git('log', '-1', '--format=%s') === 'Fix typo', 'the commit to come back');
    assert.equal(git('status', '--porcelain'), '');
  } finally {
    app.unmount();
  }
});

test('z switches back after a checkout', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Fix typo'), 'the graph');
    await command(app, 'checkout feature');
    await until(() => git('branch', '--show-current') === 'feature', 'the switch to feature');
    await until(() => frame().includes('⎇ feature'), 'the header to follow');
    app.stdin.write('z');
    await until(() => frame().includes('Switch back to main?'), 'the confirmation');
    assert.match(frame(), /Undoes the switch from main to feature/);
    app.stdin.write('1');
    await until(() => git('branch', '--show-current') === 'main', 'the switch back');
  } finally {
    app.unmount();
  }
});

test('z brings back a discarded file', async () => {
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('1 change'), 'load');
    app.stdin.write('2');
    await until(() => /❯ M a\.txt/.test(frame()) && frame().includes('+three'), 'the file and its diff in Changes');
    app.stdin.write('d');
    await until(() => frame().includes('Discard unstaged changes to a.txt?'), 'the discard confirmation');
    assert.match(frame(), /z brings them back/);
    app.stdin.write('1');
    await until(() => git('status', '--porcelain') === '', 'the discard');
    await until(() => frame().includes('clean'), 'the view to refresh');

    app.stdin.write('z');
    await until(() => frame().includes('Bring back the unstaged changes to a.txt?'), 'the undo confirmation');
    app.stdin.write('1');
    await until(() => read('a.txt') === 'one\ntwo\nthree\n', 'the changes to come back');
    assert.equal(git('diff', '--cached', '--name-only'), '');
    await until(() => frame().includes('1 change'), 'the view to refresh again');
    // Once brought back, the next z goes back to the reflog.
    app.stdin.write('z');
    await until(() => frame().includes('Undo the switch') || frame().includes('Switch back to feature?'), 'the next undo');
    app.stdin.write('2');
  } finally {
    app.unmount();
    git('checkout', '--', 'a.txt');
  }
});

test('/discard all, untracked files included, comes back with z', async () => {
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nedited\n');
  writeFileSync(join(dir, 'staged.txt'), 'staged\n');
  git('add', 'staged.txt');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'loose.txt'), 'untracked\n');
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('3 changes'), 'load');
    await command(app, 'discard');
    await until(() => frame().includes('Discard all changes to 3 files?'), 'the confirmation');
    app.stdin.write('1');
    await until(() => git('status', '--porcelain') === '', 'everything to go');
    assert.equal(existsSync(join(dir, 'sub', 'loose.txt')), false);
    await until(() => frame().includes('clean'), 'the view to refresh');

    app.stdin.write('z');
    await until(() => frame().includes('Bring back the changes to 3 files?'), 'the undo confirmation');
    app.stdin.write('1');
    await until(() => existsSync(join(dir, 'sub', 'loose.txt')), 'the untracked file to come back');
    await until(() => frame().includes('3 changes'), 'the view to refresh again');
    assert.equal(read('a.txt'), 'one\ntwo\nedited\n');
    assert.equal(read('sub/loose.txt'), 'untracked\n');
    assert.equal(git('diff', '--cached', '--name-only'), 'staged.txt');
    assert.equal(git('status', '--porcelain', '--untracked-files=all'), 'M a.txt\nA  staged.txt\n?? sub/loose.txt');
  } finally {
    app.unmount();
    git('reset', '-q', '--hard');
    git('clean', '-q', '-f', '-d');
  }
});

test('/reflog lists where HEAD has been, shows a diff and comes back to the list', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Fix typo'), 'the graph');
    await command(app, 'reflog');
    await until(() => frame().includes('Reflog: where HEAD has been'), 'the picker');
    // Hash, age ("now", "1m"), what happened, and its message.
    await until(() => /[0-9a-f]{7}\s+\w+\s+checkout\s+moving from feature to main/.test(frame()), 'the entries');
    assert.match(frame(), /[0-9a-f]{7}\s+\w+\s+undo\s+updating HEAD/);
    assert.match(frame(), /[0-9a-f]{7}\s+\w+\s+commit\s+Fix typo/);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Date:') || frame().includes('AuthorDate:'), 'the commit diff');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Reflog: where HEAD has been'), 'the picker to come back');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Reflog: where HEAD has been'), 'the picker to close');
  } finally {
    app.unmount();
  }
});
