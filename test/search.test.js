import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { markRanges, matcher, matchingLines, wordChanges } from '../src/search.js';
import { TextViewer } from '../src/ui/TextViewer.jsx';

test('search: smart case, every match in a line, and the lines that have one', () => {
  assert.deepEqual(matcher('ab')('xAB ab'), [
    [1, 3],
    [4, 6],
  ]);
  // A capital letter: case for case.
  assert.deepEqual(matcher('AB')('xAB ab'), [[1, 3]]);
  assert.equal(matcher(''), null);
  assert.deepEqual(matchingLines(['one', [{ text: 'tw' }, { text: 'o' }], 'three'], 'two'), [1]);
});

test('markRanges restyles just the ranges, across segment boundaries', () => {
  const segs = [
    { text: 'hello ', color: 'a' },
    { text: 'world', color: 'b' },
  ];
  assert.deepEqual(markRanges(segs, [[4, 8]], { bg: 'X' }), [
    { text: 'hell', color: 'a' },
    { text: 'o ', color: 'a', bg: 'X' },
    { text: 'wo', color: 'b', bg: 'X' },
    { text: 'rld', color: 'b' },
  ]);
  assert.equal(markRanges(segs, [], { bg: 'X' }), segs);
});

test('word diffs: removed and added lines paired in order, only the changed words picked out', () => {
  const lines = [
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -1,3 +1,3 @@',
    ' context',
    '-const total = price * count;',
    '-return total;',
    '+const total = price * quantity;',
    '+return total + tax;',
  ];
  const w = wordChanges(lines);
  // The --- and +++ headers aren't a pair.
  assert.deepEqual([...w.keys()].sort(), [5, 6, 7, 8]);
  const at = (i) => w.get(i).map(([a, b]) => lines[i].slice(a, b));
  assert.deepEqual(at(5), ['count']);
  assert.deepEqual(at(7), ['quantity']);
  assert.deepEqual(at(6), []);
  // Neighbouring changes join across the space between them.
  assert.deepEqual(at(8), ['+ tax']);
});

test('word diffs leave a line alone when most of it changed, or when only one side is there', () => {
  assert.equal(wordChanges(['-the quick brown fox', '+completely different words here']).size, 0);
  assert.equal(wordChanges(['-only removed', ' context']).size, 0);
});

const until = async (check, what) => {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

test('/ in the viewer: matches as you type, n and N between them, esc clears the search and then closes', async () => {
  let closed = 0;
  const text = Array.from({ length: 60 }, (_, i) => (i % 20 === 5 ? `line ${i} has the Needle` : `line ${i}`)).join('\n');
  const ctx = { mouseHandlers: [] };
  const app = render(React.createElement(TextViewer, { title: 'Text', text, ctx, width: 70, height: 12, active: true, onClose: () => closed++ }));
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('/ search'), 'the viewer');
    app.stdin.write('/');
    await until(() => frame().includes('↵ done'), 'the search line');
    for (const ch of 'needle') app.stdin.write(ch);
    await until(() => frame().includes('/needle') && frame().includes('1/3 lines'), 'three matches, the first shown');
    assert.match(frame(), /line 5 has the Needle/);
    app.stdin.write('\r');
    await until(() => frame().includes('"needle" 1/3 lines'), 'the search kept');
    app.stdin.write('n');
    await until(() => frame().includes('2/3') && frame().includes('line 25 has'), 'the second match');
    app.stdin.write('N');
    app.stdin.write('N');
    await until(() => frame().includes('3/3') && frame().includes('line 45 has'), 'round to the last');
    app.stdin.write('\x1b');
    await until(() => frame().includes('/ search · esc close'), 'the search cleared');
    assert.equal(closed, 0);
    app.stdin.write('\x1b');
    await until(() => closed === 1, 'closed');
  } finally {
    app.unmount();
  }
});

test('word diffs: what two lines start with is kept, and what follows is compared as before', () => {
  const lines = ['-  total = price * count + tax', '+  total = price * quantity + tax', '-a b a', '+a a b a'];
  const w = wordChanges(lines);
  const at = (i) => w.get(i).map(([a, b]) => lines[i].slice(a, b));
  assert.deepEqual(at(0), ['count']);
  assert.deepEqual(at(1), ['quantity']);
  // After the common "a ", the walk takes the first match it meets.
  assert.deepEqual(w.get(2), []);
  assert.deepEqual(at(3), ['a']);
});
