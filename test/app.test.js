// Drives the real UI against a throwaway repository: keys in, frames out, git state checked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.jsx';

const KEYS = { down: '\x1b[B', enter: '\r', esc: '\x1b', backspace: '\x7f' };

let base;
let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'tiller-'));
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
  git('switch', '-q', '-c', 'feature');
  writeFileSync(join(dir, 'b.txt'), 'feature\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Feature work');
  git('switch', '-q', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(dir, 'new.txt'), 'brand new\n');
});

after(() => rmSync(base, { recursive: true, force: true }));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
    if (check()) return new Promise((r) => setTimeout(r, 100));
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

test('graph, staging, committing and switching branches through the UI', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit') && frame().includes('Feature work'), 'the graph');
    assert.match(frame(), /● main/);
    assert.match(frame(), /\/\/ WIP/);
    assert.match(frame(), /2 changes/);

    app.stdin.write('2');
    await until(() => frame().includes('Unstaged (2)'), 'the Changes view');
    assert.match(frame(), /Staged \(0\)/);

    app.stdin.write(' ');
    await until(() => frame().includes('Staged (1)'), 'a file to be staged');
    assert.equal(git('diff', '--cached', '--name-only'), 'a.txt');

    app.stdin.write('/');
    await type(app.stdin, 'commit Add a second line');
    await until(() => frame().includes('/commit Add a second line'), 'the typed command');
    app.stdin.write(KEYS.enter);
    await until(() => git('log', '-1', '--format=%s') === 'Add a second line', 'the commit');
    await until(() => frame().includes('Unstaged (1)') && frame().includes('Staged (0)'), 'the view to refresh');

    app.stdin.write('/');
    await type(app.stdin, 'checkout feat');
    await until(() => /^\s+feature\s*$/m.test(frame()), 'ref completion');
    app.stdin.write(KEYS.enter);
    await until(() => git('branch', '--show-current') === 'feature', 'the switch to feature');
    await until(() => frame().includes('⎇ feature'), 'the header to follow');

    app.stdin.write('3');
    await until(() => frame().includes('Local (2)'), 'the Branches view');

    app.stdin.write('?');
    await until(() => frame().includes('Keyboard shortcuts'), 'help');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Keyboard shortcuts'), 'help to close');
  } finally {
    app.unmount();
  }
});

test('discarding asks first, and "No" leaves the file alone', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('changes') || frame().includes('change'), 'load');
    app.stdin.write('2');
    await until(() => frame().includes('new.txt'), 'the untracked file');
    app.stdin.write('d');
    await until(() => frame().includes('Discard unstaged changes to new.txt?'), 'the confirmation');
    app.stdin.write('2');
    await until(() => !frame().includes('Discard unstaged'), 'the dialog to close');
    assert.match(git('status', '--porcelain'), /new\.txt/);
  } finally {
    app.unmount();
  }
});
