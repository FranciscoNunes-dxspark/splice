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
import { firstBadCommit, parseDecorations } from '../src/parse.js';

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

test("the end of a bisect, in old and new git's words", () => {
  const hash = 'b819dea34d449b33d1ddccd0ac0957b615b1239c';
  assert.equal(firstBadCommit(`${hash} is the first bad commit\ncommit ${hash}\n`), hash);
  assert.equal(firstBadCommit(`${hash} is the first 'bad' commit\ncommit ${hash}\n`), hash);
  assert.equal(firstBadCommit('Bisecting: 2 revisions left to test after this (roughly 1 step)'), null);
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

const KEYS = { enter: '\r', esc: '\x1b' };

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

/**
 * Another repository like the first: commit 5 of 10 brings in the bug, and commit 3 can't be tested.
 * The last commit git tries is then Commit 4, so the cursor has to move to the one it names.
 */
function runRepo(name) {
  const d = join(base, name);
  mkdirSync(d);
  const g = (...args) => execFileSync('git', args, { cwd: d, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.com');
  g('config', 'commit.gpgsign', 'false');
  for (let i = 1; i <= 10; i++) {
    writeFileSync(join(d, 'a.txt'), `version ${i}${i >= 5 ? ' bug' : ''}${i === 3 ? ' broken' : ''}\n`);
    g('add', '.');
    g('commit', '-q', '-m', `Commit ${i}`);
  }
  return { d, g };
}

// Marks 10 bad and 1 good with B, as a person would.
async function markEnds(app, g) {
  const frame = () => app.lastFrame() ?? '';
  await until(() => /❯.*Commit 10/.test(frame()), 'the graph');
  app.stdin.write('B');
  await until(() => frame().includes('bad or good?'), 'the question');
  app.stdin.write('1');
  await until(() => frame().includes('BISECTING') && g('for-each-ref', 'refs/bisect').includes('refs/bisect/bad'), 'the bisect started, 10 bad');
  // Only once there's a good commit too does B offer the run.
  app.stdin.write('B');
  await until(() => frame().includes('3. Skip') && !frame().includes('Run a command'), 'the question, without the run');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('3. Skip'), 'the question gone');
  app.stdin.write('G');
  await until(() => /❯.*Commit 1\b/.test(frame()), 'the cursor on the first commit');
  const head = g('rev-parse', 'HEAD');
  app.stdin.write('B');
  await until(() => frame().includes('3. Skip'), 'the question');
  app.stdin.write('2');
  await until(() => g('rev-parse', 'HEAD') !== head, 'git to check out a commit halfway');
}

test('/bisect run tests each commit with a command (125 skips one), and the cursor goes to the first bad commit', async () => {
  const { d, g } = runRepo('run-repo');
  lastApp = render(React.createElement(App, { initialPath: d, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const first = g('rev-parse', 'HEAD~5');
  try {
    await markEnds(app, g);
    // B now offers the run, which puts the command in the prompt.
    app.stdin.write('B');
    await until(() => frame().includes('4. Run a command on each commit'), 'the run offered');
    app.stdin.write('4');
    await until(() => frame().includes('> /bisect run'), 'the prompt');
    // Exit 0 good, 1 bad, 125 for the commit that can't be tested. Quoted, so it reaches git as one word.
    const script = "const t = require('fs').readFileSync('a.txt', 'utf8'); process.exit(t.includes('broken') ? 125 : t.includes('bug') ? 1 : 0)";
    await type(app.stdin, `node -e "${script}"`);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes(`Found it: ${first.slice(0, 7)} is the first bad commit, "Commit 5"`), 'the first bad commit');
    // The output is in the viewer, then the graph has the cursor on the commit.
    await until(() => frame().includes('git bisect run node -e') && frame().includes('is the first bad commit'), 'the output');
    assert.match(g('bisect', 'log'), /# skip: \[[0-9a-f]+\] Commit 3/);
    assert.notEqual(g('rev-parse', 'HEAD'), first);
    app.stdin.write(KEYS.esc);
    await until(() => /❯.*Commit 5\b/.test(frame()), 'the cursor on Commit 5');
  } finally {
    app.unmount();
  }
});

test('esc stops a bisect run, and what it ran, leaving the bisect as it was', async () => {
  const { d, g } = runRepo('stop-repo');
  lastApp = render(React.createElement(App, { initialPath: d, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const pidFile = join(base, 'stop.pid');
  try {
    await markEnds(app, g);
    const before = g('bisect', 'log');
    app.stdin.write('/');
    await type(app.stdin, `bisect run node -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)" ${JSON.stringify(pidFile)}`);
    app.stdin.write(KEYS.enter);
    let pid = 0;
    await until(() => (pid = Number(readFileSync(pidFile, 'utf8'))) > 0, 'the command to start');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Stopped the bisect run'), 'the run stopped');
    // Still bisecting (git bisect log fails otherwise), with the same marks.
    assert.equal(g('bisect', 'log'), before);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        return e.code === 'ESRCH';
      }
    }, 'the command to be stopped too');
  } finally {
    app.unmount();
  }
});
