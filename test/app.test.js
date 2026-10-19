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

test('staging a single hunk from the diff pane', async () => {
  // Two far-apart edits make two hunks.
  writeFileSync(join(dir, 'long.txt'), Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join('\n') + '\n');
  git('add', 'long.txt');
  git('commit', '-q', '-m', 'Long file');
  writeFileSync(join(dir, 'long.txt'), Array.from({ length: 30 }, (_, i) => (i === 1 ? 'TOP' : i === 27 ? 'BOTTOM' : `l${i + 1}`)).join('\n') + '\n');
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Long file'), 'load');
    app.stdin.write('2');
    await until(() => frame().includes('long.txt'), 'the Changes view');
    // Put the cursor on long.txt, then step into its diff.
    while (!/❯ M long\.txt/.test(frame())) {
      app.stdin.write('j');
      await new Promise((r) => setTimeout(r, 60));
    }
    app.stdin.write('\r');
    await until(() => frame().includes('▌@@ -1,'), 'the diff pane');
    app.stdin.write(' ');
    await until(() => /^\+TOP$/m.test(git('diff', '--cached', '--', 'long.txt')), 'the first hunk to be staged');
    assert.doesNotMatch(git('diff', '--cached', '--', 'long.txt'), /BOTTOM/);
    assert.match(git('diff', '--', 'long.txt'), /\+BOTTOM/);
  } finally {
    app.unmount();
    git('reset', '-q');
    git('checkout', '--', 'long.txt');
  }
});

test('interactive rebase from the graph: fix up the last commit into the one before', async () => {
  const other = join(base, 'rebase-repo');
  mkdirSync(other);
  const g = (...args) => execFileSync('git', args, { cwd: other, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@example.com');
  for (const n of ['Alpha', 'Beta', 'Gamma']) {
    writeFileSync(join(other, `${n}.txt`), n);
    g('add', '.');
    g('commit', '-q', '-m', n);
  }
  lastApp = render(React.createElement(App, { initialPath: other, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Gamma'), 'the graph');
    app.stdin.write('j'); // Beta
    await until(() => /❯ ●\s+Beta/.test(frame()), 'the cursor on Beta');
    app.stdin.write('i');
    await until(() => frame().includes('Interactive rebase from'), 'the rebase editor');
    assert.match(frame(), /pick\s+[0-9a-f]{7} Gamma[\s\S]*pick\s+[0-9a-f]{7} Beta/);
    app.stdin.write('f'); // the top row, Gamma, folds into Beta
    await until(() => /fixup\s+[0-9a-f]{7} Gamma/.test(frame()), 'fixup to show');
    app.stdin.write('\r');
    await until(() => frame().includes('Rewrite 2 commits on main? (1 fixed up)'), 'the confirmation');
    app.stdin.write('1');
    await until(() => g('log', '--format=%s') === 'Beta\nAlpha', 'the rebase to finish');
    assert.equal(g('show', '--name-only', '--format=', 'HEAD'), 'Beta.txt\nGamma.txt');
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
    // Wait for the Changes list itself: the graph's working-tree pane lists new.txt too.
    await until(() => /❯ \? new\.txt/.test(frame()), 'the untracked file in Changes');
    app.stdin.write('d');
    await until(() => frame().includes('Discard unstaged changes to new.txt?'), 'the confirmation');
    app.stdin.write('2');
    await until(() => !frame().includes('Discard unstaged'), 'the dialog to close');
    assert.match(git('status', '--porcelain'), /new\.txt/);
  } finally {
    app.unmount();
  }
});
