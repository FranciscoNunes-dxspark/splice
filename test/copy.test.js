// y copies what's under the cursor, driven through the real UI with a stand-in for the clipboard.
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
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-copy-'));
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
  git('branch', 'feature');
  writeFileSync(join(dir, 'notes.md'), 'new\n');
});

after(() => removeTemp(base));

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

test("y copies the commit's hash, the branch's name and the file's path, and says so", async () => {
  const copied = [];
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, copy: (t) => copied.push(t) }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    // The working tree's row comes first; the commit is one down.
    app.stdin.write('j');
    await until(() => /❯.*First commit/.test(frame()), 'the cursor on the commit');
    app.stdin.write('y');
    const hash = git('rev-parse', 'HEAD');
    await until(() => copied.length === 1 && frame().includes(`Copied the hash of ${hash.slice(0, 7)}`), 'the hash copied');
    assert.equal(copied[0], hash);

    app.stdin.write('3');
    await until(() => frame().includes('1 remote') || frame().includes('2 local'), 'the branches');
    app.stdin.write('j');
    await until(() => /❯.*feature/.test(frame()) || /❯.*main/.test(frame()), 'the cursor on a branch');
    app.stdin.write('y');
    await until(() => copied.length === 2, 'the branch copied');
    assert.ok(['feature', 'main'].includes(copied[1]));
    assert.match(frame(), new RegExp(`Copied ${copied[1]}`));

    app.stdin.write('2');
    await until(() => /❯.*notes\.md/.test(frame()), 'the untracked file under the cursor');
    app.stdin.write('y');
    await until(() => copied.length === 3, 'the path copied');
    assert.equal(copied[2], 'notes.md');
  } finally {
    app.unmount();
  }
});
