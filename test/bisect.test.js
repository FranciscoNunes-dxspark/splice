// Finding the commit that brought in a bug with B in the graph, driven through the real UI.
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
import { parseDecorations } from '../src/parse.js';

let base;
let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-bisect-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  // Commit 6 brings in the bug; the ones after it keep it.
  for (let i = 1; i <= 10; i++) {
    writeFileSync(join(dir, 'a.txt'), `version ${i}${i >= 6 ? ' bug' : ''}\n`);
    git('add', '.');
    git('commit', '-q', '-m', `Commit ${i}`);
  }
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
      if (check()) return new Promise((r) => setTimeout(r, 100));
    } catch {
      // git mid-checkout: not yet.
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

test('bisect marks show as pills in the graph', () => {
  assert.deepEqual(parseDecorations('refs/bisect/bad, refs/bisect/good-0123abc, refs/heads/main'), [
    { type: 'bisect', name: 'bad' },
    { type: 'bisect', name: 'good' },
    { type: 'local', name: 'main', head: false },
  ]);
});

test('B marks commits bad and good, the cursor follows what git checks out, and it finds the first bad commit', async () => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const first = git('rev-parse', 'HEAD~4');
  try {
    await until(() => /❯.*Commit 10/.test(frame()), 'the graph');
    app.stdin.write('B');
    await until(() => frame().includes('bad or good?'), 'the question');
    app.stdin.write('1');
    await until(() => frame().includes('BISECTING') && git('for-each-ref', 'refs/bisect').includes('refs/bisect/bad'), 'the bisect started, 10 bad');

    app.stdin.write('G');
    await until(() => /❯.*Commit 1\b/.test(frame()), 'the cursor on the first commit');
    app.stdin.write('B');
    await until(() => frame().includes('3. Skip'), 'the question, with skip now');
    app.stdin.write('2');
    await until(() => git('rev-parse', 'HEAD') !== git('rev-parse', 'main'), 'git to check out a commit halfway');

    // Each time: the cursor is on what git checked out; try it, and mark it.
    for (let step = 0; step < 6 && !frame().includes('Found it'); step++) {
      const head = git('rev-parse', 'HEAD');
      const subject = git('log', '-1', '--format=%s', head);
      await until(() => new RegExp(`❯.*${subject}\\b`).test(frame()), `the cursor on ${subject}`);
      app.stdin.write('B');
      await until(() => frame().includes('Mark ') && frame().includes('3. Skip'), 'the question');
      const bad = readFileSync(join(dir, 'a.txt'), 'utf8').includes('bug');
      app.stdin.write(bad ? '1' : '2');
      await until(() => git('rev-parse', 'HEAD') !== head || frame().includes('Found it'), 'git to move on');
    }
    await until(() => frame().includes(`Found it: ${first.slice(0, 7)} is the first bad commit`), 'the first bad commit');

    app.stdin.write('/');
    await new Promise((r) => setTimeout(r, 50));
    for (const ch of 'abort') app.stdin.write(ch);
    app.stdin.write('\r');
    await until(() => frame().includes('Stop bisecting?'), 'the question');
    app.stdin.write('1');
    await until(() => !frame().includes('BISECTING') && git('symbolic-ref', '--short', 'HEAD') === 'main', 'back on main');
  } finally {
    app.unmount();
  }
});
