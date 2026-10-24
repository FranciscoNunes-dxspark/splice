// Blame of the future (F in blame, /future): the open pull requests whose changes touch a line. The pure
// line arithmetic, then through the real UI: a bare repository is the remote, a stub the PR host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { futureRefspecs, hunkTouches, lineInBase, touchingHunks, zeroHunks } from '../src/future.js';
import { App } from '../src/ui/App.jsx';

const DIFF = ['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -0,0 +1,2 @@', '+new one', '+new two', '@@ -5 +7 @@', '-five', '+FIVE', '@@ -8,2 +9,0 @@', '-eight', '-nine', ''].join('\n');

test('a line carried back to the merge base through a -U0 diff', () => {
  assert.deepEqual(zeroHunks(DIFF).map((h) => [h.oldStart, h.oldCount, h.newStart, h.newCount, h.lines.length]), [[0, 0, 1, 2, 2], [5, 1, 7, 1, 2], [8, 2, 9, 0, 2]]);
  assert.deepEqual(lineInBase(DIFF, 1), { line: 1, changed: true }, 'an added line: the one it came before');
  assert.deepEqual(lineInBase(DIFF, 3), { line: 1, changed: false });
  assert.deepEqual(lineInBase(DIFF, 6), { line: 4, changed: false });
  assert.deepEqual(lineInBase(DIFF, 7), { line: 5, changed: true });
  assert.deepEqual(lineInBase(DIFF, 8), { line: 6, changed: false });
  assert.deepEqual(lineInBase(DIFF, 9), { line: 7, changed: false }, 'just before two lines taken out');
  assert.deepEqual(lineInBase(DIFF, 10), { line: 10, changed: false }, 'after them');
  assert.deepEqual(lineInBase('', 4), { line: 4, changed: false });
});

test('the hunks that touch a line', () => {
  assert.equal(hunkTouches({ oldStart: 5, oldCount: 2 }, 6), true);
  assert.equal(hunkTouches({ oldStart: 5, oldCount: 2 }, 7), false);
  assert.equal(hunkTouches({ oldStart: 5, oldCount: 0 }, 6), true, 'lines added right after it');
  assert.equal(hunkTouches({ oldStart: 5, oldCount: 0 }, 7), false);
  assert.deepEqual(touchingHunks(DIFF, 9).map((h) => h.oldStart), [8]);
  assert.deepEqual(
    futureRefspecs([{ id: 3, target: 'main' }, { id: 4, target: 'main' }], (p) => `refs/pull/${p.id}/head`, 'origin'),
    ['+refs/pull/3/head:refs/splice/future/3', '+refs/pull/4/head:refs/splice/future/4', '+refs/heads/main:refs/remotes/origin/main'],
  );
});

let base;
let dir;
let origin;
let lastApp = null;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const git = (...args) => run(dir, ...args);
const LINES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-future-'));
  dir = join(base, 'repo');
  origin = join(base, 'origin.git');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  run(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'f.txt'), `${LINES.join('\n')}\n`);
  writeFileSync(join(dir, 'g.txt'), 'g\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Ten lines');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  const branch = (name, file, text, subject) => {
    git('checkout', '-q', '-b', name, 'main');
    writeFileSync(join(dir, file), text);
    git('commit', '-q', '-am', subject);
    git('push', '-q', 'origin', name);
    git('checkout', '-q', 'main');
    git('branch', '-q', '-D', name);
  };
  branch('five', 'f.txt', `${LINES.map((l) => (l === 'five' ? 'FIVE' : l)).join('\n')}\n`, 'Shout five');
  branch('nine', 'f.txt', `${LINES.map((l) => (l === 'nine' ? 'NINE' : l)).join('\n')}\n`, 'Shout nine');
  branch('other', 'g.txt', 'G\n', 'Another file');
  // Your own work: a line added at the top, so line 6 on disk is the merge base's line 5.
  writeFileSync(join(dir, 'f.txt'), `zero\n${LINES.join('\n')}\n`);
});

after(() => removeTemp(base));

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let ok = false;
    try {
      ok = check();
    } catch {
      // not yet
    }
    if (ok) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

async function command(app, text) {
  app.stdin.write('/');
  await until(() => app.lastFrame().includes('> /'), 'the prompt');
  app.stdin.write(text);
  await until(() => app.lastFrame().includes(`> /${text}`), `/${text} typed`);
  app.stdin.write('\r');
}

const flat = (s) => s.replace(/\s+/g, ' ');

test('F in blame: the open pull requests changing the line, with their hunks; ↵ opens one', async () => {
  const pr = (id, source, title) => ({ id, label: `#${id}`, title, author: 'ana', source, target: 'main', head: null, draft: false, url: `https://example.invalid/pull/${id}`, state: 'open' });
  const prs = [pr(1, 'five', 'Shout five'), pr(2, 'nine', 'Shout nine'), pr(3, 'other', 'Another file')];
  const makeHost = () => ({
    kind: 'github',
    name: 'GitHub',
    remoteName: 'origin',
    list: async () => prs,
    headRef: (p) => `refs/heads/${p.source}`,
    diff: async (p) => `diff of ${p.label}`,
  });
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, makeHost }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Ten lines'), 'the graph');
    await command(app, 'future');
    await until(() => flat(frame()).includes('No blame to take a line from'), 'no blame shown yet');
    await command(app, 'blame f.txt:6');
    await until(() => /❯.*6 │ five/.test(frame()), 'blame on line 6');
    app.stdin.write('F');
    await until(() => frame().includes('1 open pull request changing line 6 of f.txt'), 'the pull requests');
    assert.match(frame(), /#1\s+Shout five\s+ana/);
    assert.match(frame(), /@@ -5 \+5 @@/);
    assert.match(frame(), /-five/);
    assert.match(frame(), /\+FIVE/);
    assert.doesNotMatch(frame(), /Shout nine/);
    assert.equal(git('for-each-ref', 'refs/splice'), '', 'the fetched heads are gone again');
    app.stdin.write('j');
    app.stdin.write('\r');
    await until(() => frame().includes('diff of #1'), "the pull request's diff");
    app.stdin.write('\x1b');
    await until(() => frame().includes('changing line 6'), 'back to the list');
    app.stdin.write('\x1b');
    await until(() => /❯.*6 │ five/.test(frame()), 'back in blame');

    // From the prompt, with a line given.
    app.stdin.write('\x1b');
    await until(() => frame().includes('Ten lines'), 'the graph again');
    // Without one: the line the last blame's cursor was on.
    await command(app, 'future');
    await until(() => frame().includes('1 open pull request changing line 6 of f.txt'), "the last blame's line");
    app.stdin.write('\x1b');
    await until(() => frame().includes('Ten lines'), 'the graph once more');
    await command(app, 'future f.txt:10');
    await until(() => frame().includes('changing line 10 of f.txt') && /#2\s+Shout nine/.test(frame()), 'the other one');
    app.stdin.write('\x1b');
    await until(() => !frame().includes('changing line 10'), 'closed');
    await command(app, 'future f.txt:3');
    await until(() => flat(frame()).includes('None of the 3 open pull requests changes line 3 of f.txt.'), 'none');
  } finally {
    app.unmount();
  }
});
