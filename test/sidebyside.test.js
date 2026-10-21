// Side-by-side diffs: pairing removed and added lines (split.js), and the viewer and Changes drawn in
// two columns through the real UI, w switching, with GitHub stubbed for a pull request's diff.
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
import { TextViewer } from '../src/ui/TextViewer.jsx';
import { diffPositions, lineTarget, withThreads } from '../src/review.js';
import { lineOn, rowLines, sideOf, splitRows, splitView } from '../src/split.js';

const DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -10,3 +10,3 @@ function main() {',
  '   const a = 1;',
  '-  const b = 2;',
  '+  const b = 3;',
  '   return a + b;',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  ' # Title',
  '+More text',
];

test('unchanged lines go on both sides, a removed line faces the added one after it, headers go across', () => {
  assert.deepEqual(splitRows(DIFF), [
    { full: 0 },
    { full: 1 },
    { full: 2 },
    { full: 3 },
    { full: 4 },
    { left: 5, right: 5, old: 10, new: 10 },
    { left: 6, right: 7, old: 11, new: 11 },
    { left: 8, right: 8, old: 12, new: 12 },
    { full: 9 },
    { full: 10 },
    { full: 11 },
    { full: 12 },
    { left: 13, right: 13, old: 1, new: 1 },
    { left: null, right: 14, old: null, new: 2 },
  ]);
});

test('runs of removals and additions pair up in order, the rest of the longer run facing a blank', () => {
  const lines = ['@@ -1,6 +1,5 @@', ' a', '-b', '-c', '-d', '+B', ' e', '+f', ' g', '\\ No newline at end of file'];
  assert.deepEqual(splitRows(lines), [
    { full: 0 },
    { left: 1, right: 1, old: 1, new: 1 },
    { left: 2, right: 5, old: 2, new: 2 },
    { left: 3, right: null, old: 3, new: null },
    { left: 4, right: null, old: 4, new: null },
    { left: 6, right: 6, old: 5, new: 3 },
    { left: null, right: 7, old: null, new: 4 },
    { left: 8, right: 8, old: 6, new: 5 },
    { full: 9 },
  ]);
  // A last line losing its newline: the note goes under the pair rather than between its sides.
  assert.deepEqual(splitRows(['@@ -1 +1 @@', '-x', '\\ No newline at end of file', '+x']), [
    { full: 0 },
    { left: 1, right: 3, old: 1, new: 1 },
    { full: 2 },
  ]);
});

test("a hunk ends where its header's counts do: what follows it is drawn across", () => {
  // Two commits' patches one after the other: the second commit's header and message aren't the first's lines.
  const lines = ['@@ -1 +1 @@', '-a', '+b', '', 'commit 0123456789abcdef', '    Second', '', 'diff --git a/x b/x'];
  const rows = splitRows(lines);
  assert.deepEqual(rows.slice(1, 2), [{ left: 1, right: 2, old: 1, new: 1 }]);
  assert.ok(rows.slice(2).every((r) => r.full != null));
  assert.deepEqual(splitRows(['plain text', '+not a diff']), [{ full: 0 }, { full: 1 }]);
});

test('review threads go across both sides under the pair their line is in', () => {
  const thread = (id, side, line) => ({ id, path: 'src/app.js', line, side, outdated: false, resolved: null, comments: [{ id: 1, author: 'ana', body: 'Hm', time: 0 }] });
  const away = { ...thread(9, 'new', null), outdated: true };
  // One under the removed line, one under the added one, and one the diff no longer shows.
  const { lines, rows } = withThreads(DIFF, [thread(1, 'old', 11), thread(2, 'new', 11), away], 80);
  const { view, rowOf, digits } = splitView(lines, rows);
  assert.equal(digits, 2);
  // The heading and the outdated thread first, across.
  assert.ok(view[0].full != null && rows[view[0].full].key === 'away');
  const pair = view.findIndex((r) => r.full == null && r.old === 11);
  const removed = view[pair].left;
  const added = view[pair].right;
  assert.equal(lines[removed], '-  const b = 2;');
  assert.equal(lines[added], '+  const b = 3;');
  // Under the pair: the removed line's thread, then the added line's, then the next line.
  const under = view.slice(pair + 1).findIndex((r) => r.full == null);
  const boxes = view.slice(pair + 1, pair + 1 + under).map((r) => rows[r.full].thread.id);
  assert.deepEqual([...new Set(boxes)], [1, 2]);
  assert.equal(view[pair + 1 + under].old, 12);
  // Every line is in a row, and its row holds it.
  lines.forEach((_, i) => assert.ok(rowLines(view[rowOf[i]]).includes(i), `line ${i}`));
});

test('a row has a line on each side, the other side standing in where one is blank', () => {
  const pair = { left: 3, right: 5 };
  const added = { left: null, right: 7 };
  const same = { left: 2, right: 2 };
  assert.equal(lineOn(pair, 'old'), 3);
  assert.equal(lineOn(pair, 'new'), 5);
  assert.equal(lineOn(added, 'old'), 7);
  assert.equal(lineOn({ full: 4 }, 'old'), 4);
  assert.deepEqual([sideOf(pair, 3), sideOf(pair, 5), sideOf(same, 2), sideOf({ full: 4 }, 4)], ['old', 'new', 'both', null]);
  assert.deepEqual(rowLines(same), [2]);
  assert.deepEqual(rowLines(added), [7]);
});

test('an unchanged line is commented on on the side asked for; a changed one only on its own', () => {
  const pos = diffPositions(DIFF);
  assert.deepEqual(lineTarget(pos[5], DIFF[5], 'old'), { path: 'src/app.js', line: 10, side: 'old', text: '  const a = 1;' });
  assert.equal(lineTarget(pos[5], DIFF[5]).side, 'new');
  assert.equal(lineTarget(pos[7], DIFF[7], 'old').side, 'new');
  assert.equal(lineTarget(pos[6], DIFF[6], 'new').side, 'old');
});

const until = async (check, what, frame = () => '', ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame()}`);
};

// A frame's line holding both texts, the left one first.
const sameLine = (frame, left, right) => frame.split('\n').some((l) => l.includes(left) && l.indexOf(right, l.indexOf(left) + left.length) >= 0);

test('w in the viewer: the diff side by side and back; search and hunks still go; too narrow, it says so', async () => {
  const notes = [];
  const ctx = { mouseHandlers: [], config: {}, note: (text, tone) => notes.push([text, tone]) };
  let width = 140;
  const el = () => React.createElement(TextViewer, { title: 'Diff', text: DIFF.join('\n'), diff: true, ctx, width, height: 20, active: true, onClose() {} });
  const app = render(el());
  ctx.setConfig = (update) => {
    ctx.config = update(ctx.config);
    app.rerender(el());
  };
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('w side by side'), 'the viewer', frame);
    assert.ok(!sameLine(frame(), '-  const b = 2;', '+  const b = 3;'));
    app.stdin.write('w');
    await until(() => ctx.config.sideBySide === true && sameLine(frame(), '-  const b = 2;', '+  const b = 3;'), 'two columns', frame);
    // Line numbers on each side, unchanged lines on both, an added line alone on the right.
    assert.ok(sameLine(frame(), '10    const a = 1;', '10    const a = 1;'));
    assert.match(frame(), /│ 2 \+More text/);
    assert.match(frame(), /w one column/);

    app.stdin.write('/');
    for (const ch of 'More') app.stdin.write(ch);
    await until(() => frame().includes('1/1 line'), 'the match found', frame);
    app.stdin.write('\r');
    app.stdin.write('\x1b');
    await until(() => frame().includes('/ search · esc close'), 'the search cleared', frame);

    app.stdin.write('w');
    await until(() => ctx.config.sideBySide === false && !sameLine(frame(), '-  const b = 2;', '+  const b = 3;'), 'one column again', frame);

    // Narrower than side by side takes: w says so and changes nothing.
    width = 100;
    app.rerender(el());
    await until(() => !frame().includes('w side by side'), 'the narrow viewer', frame);
    app.stdin.write('w');
    await until(() => notes.length === 1, 'the note', frame);
    assert.match(notes[0][0], /at least 120 columns wide; this one is 100/);
    assert.equal(ctx.config.sideBySide, false);
  } finally {
    app.unmount();
  }
});

test('a long viewer side by side: n goes from hunk to hunk, G to the end', async () => {
  const big = ['diff --git a/a b/a', '@@ -1,40 +1,40 @@'];
  for (let i = 1; i <= 40; i++) big.push(i % 10 === 0 ? `-old ${i}` : ` same ${i}`, ...(i % 10 === 0 ? [`+new ${i}`] : []));
  big.push('@@ -100,2 +100,2 @@', '-last old', '+last new', ' end');
  const ctx = { mouseHandlers: [], config: { sideBySide: true }, note() {} };
  const app = render(React.createElement(TextViewer, { title: 'Big', text: big.join('\n'), diff: true, ctx, width: 130, height: 12, active: true, onClose() {} }));
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => sameLine(frame(), 'same 1', 'same 1'), 'two columns', frame);
    // 40 lines of the first hunk take 40 rows, so the rows on screen count the pairs.
    assert.match(frame(), /10\/45/);
    app.stdin.write('n');
    await until(() => frame().split('\n')[1].includes('@@ -1,40'), 'the first hunk on top', frame);
    app.stdin.write('n');
    // Near the end, the view stops scrolling where the last row is at the bottom.
    await until(() => frame().includes('@@ -100,2') && frame().includes('45/45'), 'the second hunk in view', frame);
    assert.ok(sameLine(frame(), '-last old', '+last new'));
    app.stdin.write('g');
    await until(() => frame().includes('diff --git a/a b/a'), 'back to the top', frame);
    app.stdin.write('G');
    await until(() => frame().includes('45/45'), 'the end', frame);
  } finally {
    app.unmount();
  }
});

let base;
let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const saved = () => JSON.parse(readFileSync(join(base, 'home', 'config.json'), 'utf8'));

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-sidebyside-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
});

after(() => removeTemp(base));

/** The app, `columns` wide. */
function wide(props, columns) {
  const app = render(React.createElement(App, { initialPath: dir, ...props }));
  Object.defineProperty(app.stdout, 'columns', { get: () => columns });
  app.stdout.emit('resize');
  return app;
}

const PR = { id: 7, label: '#7', title: 'Bump b', author: 'ana', mine: false, reviewMe: true, source: 'b', target: 'main', draft: false, url: 'https://example.com/7', time: 0, review: { text: 'Review required', tone: 'wait' }, checks: null, reviewers: [], description: '' };

test("a PR's diff opens side by side when left that way; h/l pick the side c comments on; threads go under the pair", async () => {
  let threads = [{ id: 1, path: 'src/app.js', line: 11, side: 'old', outdated: false, resolved: null, comments: [{ id: 1, author: 'ana', body: 'Why 2?', time: 0 }] }];
  const posted = [];
  const makeHost = () => ({
    kind: 'github',
    name: 'GitHub',
    signIn: 'gh auth login',
    remoteName: 'origin',
    list: async () => [PR],
    detail: async () => ({ reviewers: [], checks: [], comments: [], conflicts: false }),
    diff: async () => DIFF.join('\n'),
    threads: async () => threads,
    addThread: async (p, at, text) => {
      posted.push(at);
      threads = [...threads, { id: 100 + posted.length, path: at.path, line: at.line, side: at.side, outdated: false, resolved: false, comments: [{ id: 1, author: 'me', body: text, time: Date.now() / 1000 }] }];
    },
  });
  const app = wide({ config: { recent: [], roots: [], history: [], sideBySide: true }, makeHost }, 140);
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph', frame);
    app.stdin.write('6');
    await until(() => /❯.*Bump b/.test(frame()), 'the PR', frame);
    app.stdin.write('\r');
    await until(() => sameLine(frame(), '-  const b = 2;', '+  const b = 3;') && frame().includes('Why 2?'), 'the diff side by side with its comment', frame);
    // The thread on the removed line spans both columns under the pair.
    const rows = frame().split('\n');
    const at = rows.findIndex((l) => l.includes('-  const b = 2;'));
    assert.match(rows[at + 1], /┌ 1 comment/);
    assert.ok(!rows[at + 1].slice(1, -1).includes('│'), 'the box is drawn across');

    // Down to the pair (headers take a row each): the cursor keeps to the new side, the added line.
    for (const k of 'jjjjjj') {
      app.stdin.write(k);
      await new Promise((r) => setTimeout(r, 40));
    }
    app.stdin.write('c');
    await until(() => frame().includes('> /review-comment'), 'the comment in the prompt', frame);
    for (const ch of 'New b') app.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 100));
    app.stdin.write('\r');
    await until(() => posted.length === 1 && frame().includes('New b'), 'the comment posted', frame);
    assert.deepEqual(posted[0], { path: 'src/app.js', line: 11, side: 'new', text: '  const b = 3;' });

    // Up to the unchanged line, and h to its old side: commented on as it was before.
    app.stdin.write('k');
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write('h');
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write('c');
    await until(() => frame().includes('> /review-comment'), 'the second comment in the prompt', frame);
    for (const ch of 'Old a') app.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 100));
    app.stdin.write('\r');
    await until(() => posted.length === 2, 'the second comment posted', frame);
    assert.deepEqual(posted[1], { path: 'src/app.js', line: 10, side: 'old', text: '  const a = 1;' });

    // w: one column again, remembered.
    await until(() => !frame().includes('> /review-comment'), 'back in the viewer', frame);
    app.stdin.write('w');
    await until(() => !sameLine(frame(), '-  const b = 2;', '+  const b = 3;') && saved().sideBySide === false, 'one column, saved', frame);
  } finally {
    app.unmount();
  }
});

test('w in Changes: the diff side by side, the list narrower, and space still stages the hunk', async () => {
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n');
  const app = wide({ config: { recent: [], roots: [], history: [] } }, 170);
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph', frame);
    app.stdin.write('2');
    await until(() => frame().includes('+TWO') && frame().includes('w side by side'), 'the diff', frame);
    app.stdin.write('w');
    await until(() => sameLine(frame(), '-two', '+TWO') && saved().sideBySide === true, 'two columns, saved', frame);
    assert.ok(sameLine(frame(), '1  one', '1  one'), frame());
    assert.match(frame(), /│4 \+four/);
    // Into the diff: the cursor on the pair, and space stages the hunk.
    app.stdin.write('\r');
    await until(() => frame().includes('space stage hunk'), 'the cursor in the diff', frame);
    app.stdin.write(' ');
    await until(() => {
      try {
        return git('diff', '--cached', '--name-only') === 'a.txt';
      } catch {
        return false;
      }
    }, 'the hunk staged', frame);
    // w again: one column.
    app.stdin.write('w');
    await until(() => saved().sideBySide === false, 'one column again', frame);
  } finally {
    app.unmount();
    git('reset', '-q');
    git('checkout', '--', 'a.txt');
  }
});
