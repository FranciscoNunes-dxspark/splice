// Cherry-picking several commits: V selects them in the graph, C picks them all; /cherry-pick from the prompt.
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

const KEYS = { enter: '\r', esc: '\x1b' };

let base;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-pick-'));
  process.env.SPLICE_HOME = join(base, 'home');
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  let failed = null;
  while (Date.now() < end) {
    try {
      // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
      if (check()) return new Promise((r) => setTimeout(r, 100));
      failed = null;
    } catch (e) {
      failed = e;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}.${failed ? ` Last check: ${failed.message}` : ''} Last frame:\n${lastApp?.lastFrame()}`);
}

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function command(app, text) {
  app.stdin.write('/');
  await type(app.stdin, text);
  await until(() => app.lastFrame().includes(`/${text}`), `the typed command /${text}`);
  app.stdin.write(KEYS.enter);
}

/**
 * main with Base then Main moves on; side, from Base, with Side one, two and three (each a file of its
 * own), then a merge of main into side and Side four. Each commit a minute after the one before, so the
 * graph's order is fixed.
 */
function makeRepo(name) {
  const dir = join(base, name);
  mkdirSync(dir);
  let minute = 0;
  const g = (...args) => {
    const at = `2026-01-01T10:${String(minute).padStart(2, '0')}:00Z`;
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } }).trim();
  };
  const commit = (file, subject, text = `${subject}\n`) => {
    minute++;
    writeFileSync(join(dir, file), text);
    g('add', '.');
    g('commit', '-q', '-m', subject);
  };
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@example.com');
  g('config', 'commit.gpgsign', 'false');
  commit('base.txt', 'Base');
  g('checkout', '-q', '-b', 'side');
  commit('one.txt', 'Side one');
  commit('two.txt', 'Side two');
  commit('three.txt', 'Side three');
  g('checkout', '-q', 'main');
  commit('main.txt', 'Main moves on');
  g('checkout', '-q', 'side');
  minute++;
  g('merge', '-q', '--no-edit', '-m', 'Merge main into side', 'main');
  commit('four.txt', 'Side four');
  // Changes base.txt the way main is about to as well: picking it there conflicts.
  g('checkout', '-q', '-b', 'clash', 'main');
  commit('base.txt', 'Clash one', 'clash\n');
  commit('five.txt', 'Clash two');
  g('checkout', '-q', 'main');
  commit('base.txt', 'Main changes base', 'main\n');
  return { dir, g };
}

test('V selects commits in the graph and C cherry-picks them onto the current branch, oldest first', async () => {
  const { dir, g } = makeRepo('select-repo');
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const pick = async (re, what) => {
    while (!re.test(frame())) {
      const before = frame();
      app.stdin.write('j');
      await until(() => frame() !== before || re.test(frame()), `the cursor to move towards ${what}`);
    }
    await until(() => re.test(frame()), `the cursor on ${what}`);
  };
  const subjects = () => g('log', '--format=%s', 'main').split('\n');
  try {
    await until(() => frame().includes('Side three'), 'the graph');

    // A merge in the selection: refused, saying why. The selection is the rows from one to the other,
    // whichever branch they're on.
    await pick(/❯.*Side four/, 'Side four');
    app.stdin.write('V');
    await pick(/❯.*Side three/, 'Side three');
    await until(() => frame().includes('4 selected'), 'four selected, the merge and main\'s commit too');
    app.stdin.write('C');
    await until(() => frame().includes('is a merge commit'), 'the merge refused');
    assert.equal(subjects()[0], 'Main changes base');

    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('selected ·'), 'esc to clear it');
    await until(() => /❯.*Side three/.test(frame()), 'the cursor where it was');
    app.stdin.write('k');
    await until(() => /❯.*Main moves on/.test(frame()), 'the cursor on main\'s commit');
    app.stdin.write('V');
    await until(() => frame().includes('1 selected'), 'the selection started');
    await pick(/❯.*Side one/, 'Side one');
    await until(() => frame().includes('4 selected · C cherry-pick'), 'four selected');
    app.stdin.write('C');
    // main has its own commit already, so three are left.
    await until(() => frame().includes('Cherry-pick these 3 commits onto main, oldest first?'), 'the question');
    // The list, oldest first, in the viewer above it.
    const list = frame().split('\n').filter((l) => /[0-9a-f]{7}  (Side|Main)/.test(l)).map((l) => l.match(/(Side|Main) \w+/)[0]);
    assert.deepEqual(list, ['Side one', 'Side two', 'Side three', 'Main moves']);
    assert.ok(frame().includes('Left out, as main has them already:'));
    app.stdin.write('1');
    await until(() => subjects().slice(0, 3).join() === 'Side three,Side two,Side one', 'the three picked, in order');
    assert.equal(g('status', '--porcelain'), '');

    // side's own commits, as a range: the merge among them stops it.
    await command(app, 'cherry-pick main..side');
    await until(() => frame().includes('Cherry-pick these') || frame().includes('is a merge commit'), 'an answer');
    assert.ok(frame().includes('is a merge commit'));
  } finally {
    app.unmount();
  }
});

test('/cherry-pick takes a ref or a range; a conflict stops it, and /abort puts the branch back', async () => {
  const { dir, g } = makeRepo('range-repo');
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const head = g('rev-parse', 'HEAD');
  try {
    await until(() => frame().includes('Main changes base'), 'the graph');
    await command(app, 'cherry-pick side~1');
    await until(() => frame().includes('Cherry-pick') && frame().includes('onto main?'), 'the question for one commit');
    // A merge on its own is picked as C does it, from the side it was merged into.
    assert.match(frame(), /Cherry-pick [0-9a-f]{7} onto main\?/);
    app.stdin.write('2');
    await until(() => !frame().includes('onto main?'), 'the question gone');

    await command(app, 'cherry-pick main..nowhere');
    await until(() => frame().includes("Couldn't list main..nowhere"), 'a bad range said');
    await command(app, 'cherry-pick side...main');
    await until(() => frame().includes('Give a range as a..b'), 'three dots refused');

    await command(app, 'cherry-pick main..clash');
    await until(() => frame().includes('Cherry-pick these 2 commits onto main'), 'the question');
    assert.ok(frame().includes('Clash one') && frame().includes('Clash two'));
    app.stdin.write('1');
    await until(() => frame().includes('Stopped with conflicts while cherry-picking'), 'the conflict');
    assert.ok(frame().includes('CHERRY-PICKING'));
    await command(app, 'abort');
    await until(() => frame().includes('Abort the cherry-pick?'), 'the question');
    app.stdin.write('1');
    await until(() => !frame().includes('CHERRY-PICKING') && g('rev-parse', 'HEAD') === head, 'main as it was');
  } finally {
    app.unmount();
  }
});
