// Submodules in Changes: their state, initialising one, and opening it as its own repository, against
// throwaway repositories (the library is cloned from a local folder; temp.js allows that).
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
let lib;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const git = (...args) => run(dir, ...args);

const init = (path) => {
  mkdirSync(path);
  run(path, 'init', '-q', '-b', 'main');
  run(path, 'config', 'core.autocrlf', 'false');
  run(path, 'config', 'user.name', 'Test');
  run(path, 'config', 'user.email', 'test@example.com');
  run(path, 'config', 'commit.gpgsign', 'false');
};

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-sub-'));
  process.env.SPLICE_HOME = join(base, 'home');
  lib = join(base, 'lib');
  init(lib);
  writeFileSync(join(lib, 'lib.txt'), 'lib\n');
  run(lib, 'add', '.');
  run(lib, 'commit', '-q', '-m', 'Library start');
  dir = join(base, 'app');
  init(dir);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
  git('submodule', 'add', '-q', lib, 'lib');
  git('commit', '-q', '-m', 'Add the library');
  git('submodule', 'deinit', '-q', '-f', 'lib');
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

test('Changes lists submodules with their state; I initialises one and o opens it', async () => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Add the library'), 'the graph');
    app.stdin.write('2');
    await until(() => frame().includes('Submodules (1)') && /❯ ○ lib\s+not initialised/.test(frame()), 'the submodule, not initialised');
    app.stdin.write('I');
    await until(() => /^[0-9a-f]/.test(git('submodule', 'status')), 'the submodule checked out');
    await until(() => /✓ lib\s+up to date/.test(frame()), 'shown up to date');

    // A commit made inside it moves it off the recorded one.
    writeFileSync(join(dir, 'lib', 'more.txt'), 'more\n');
    run(join(dir, 'lib'), 'add', '.');
    run(join(dir, 'lib'), '-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'More');
    app.stdin.write('r');
    await until(() => /lib\s+out of date/.test(frame()) && frame().includes('M lib'), 'out of date, and lib as a changed file');

    while (!/❯ ↻ lib/.test(frame())) {
      app.stdin.write('j');
      await new Promise((r) => setTimeout(r, 60));
    }
    // As in until(): the view's key handler needs a moment to see the new selection.
    await new Promise((r) => setTimeout(r, 100));
    app.stdin.write('o');
    await until(() => frame().includes('│  lib  ⎇ detached'), 'the submodule open as its own repository');
    assert.match(frame().split('\n')[0], /app[\\/]lib\s*$/);
  } finally {
    app.unmount();
  }
});
