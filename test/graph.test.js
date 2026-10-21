import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph } from '../src/graph.js';
import { theme } from '../src/theme.js';

// Commits as `git log --date-order` lists them: [hash, ...parents]; `names` puts branches on commits.
const rows = (list, names = {}) =>
  list.map(([hash, ...parents]) => ({ commit: { hash, parents, refs: (names[hash] ?? []).map((name) => ({ type: name.includes('/') ? 'remote' : 'local', name })) } }));
const text = (row) => row.graph.map((c) => c.ch).join('');
const draw = (list, names, opts) => layoutGraph(rows(list, names), opts).rows.map(text);

test('a straight line of commits is one column', () => {
  assert.deepEqual(draw([['c', 'b'], ['b', 'a'], ['a']]), ['●', '●', '●']);
});

test('a merged pull request leaves the merge, with a row after it, and bends back on a row of its own', () => {
  assert.deepEqual(draw([['m', 'a', 'f'], ['f', 'a'], ['a']]), ['○<╮', '│ │', '│ ●', '├─╯', '●']);
  assert.deepEqual(draw([['m', 'b', 'f'], ['f', 'a'], ['b', 'a'], ['a']]), ['○<╮', '│ │', '│ ●', '● │', '├─╯', '●']);
});

test('the default branch keeps the left-most column, even under a newer branch', () => {
  const list = [['f', 'b'], ['c', 'b'], ['b', 'a'], ['a']];
  assert.deepEqual(draw(list, { f: ['feature'], c: ['main'] }), ['  ●', '● │', '├─╯', '●', '●']);
  assert.deepEqual(draw(list, { f: ['feature'], c: ['origin/master'] }), ['  ●', '● │', '├─╯', '●', '●']);
  assert.deepEqual(draw(list, { f: ['feature'], c: ['stable'] }, { main: 'stable' }), ['  ●', '● │', '├─╯', '●', '●']);
  // Without names, the first branch from the top takes the left.
  assert.deepEqual(draw(list), ['●', '│ ●', '├─╯', '●', '●']);
});

test('branches that never overlap share a column', () => {
  const list = [['m2', 'c', 'f2'], ['f2', 'c'], ['c', 'm1'], ['m1', 'a', 'f1'], ['f1', 'a'], ['a']];
  assert.deepEqual(draw(list), ['○<╮', '│ │', '│ ●', '├─╯', '●', '○<╮', '│ │', '│ ●', '├─╯', '●']);
});

test('a merge crosses a branch in between', () => {
  const list = [['t', 'a'], ['m', 'a', 'c'], ['c', 'a'], ['a']];
  assert.deepEqual(draw(list, { t: ['feature'], m: ['main'] }), ['  ●', '○<┼─╮', '│ │ │', '│ │ ●', '├─┴─╯', '●']);
});

test('merging the default branch into a branch draws into its column', () => {
  const list = [['f2', 'f1', 'm'], ['m', 'a'], ['f1', 'a'], ['a']];
  assert.deepEqual(draw(list, { f2: ['feature'], m: ['main'] }), ['╭>○', '│ │', '● │', '│ ●', '├─╯', '●']);
});

test('a parent that isn\'t loaded yet runs the line to the bottom', () => {
  assert.deepEqual(draw([['b', 'a'], ['x']]), ['●', '│ ●']);
});

test('the default branch has its own colour, and a merge line has the merged branch\'s all the way to its arrow', () => {
  const out = layoutGraph(rows([['m', 'b', 'f'], ['f', 'a'], ['b', 'a'], ['a']], { m: ['main'] }), { main: 'main' }).rows.map((r) => r.graph);
  assert.equal(out[0][0].color, theme.lanes[0]);
  assert.equal(out[5][0].color, theme.lanes[0]);
  const f = out[2][2].color;
  assert.notEqual(f, theme.lanes[0]);
  assert.deepEqual([out[0][1].ch, out[0][1].color, out[0][2].color], ['<', f, f]);
  assert.deepEqual([out[4][0].ch, out[4][0].color, out[4][1].color, out[4][2].color], ['├', theme.lanes[0], f, f]);
  // Where a line down goes on through a line across, it keeps its own colour.
  const [, cross] = layoutGraph(rows([['t', 'a'], ['m', 'a', 'c'], ['c', 'a'], ['a']], { t: ['feature'], m: ['main'] })).rows.map((r) => r.graph);
  assert.equal(cross[2].ch, '┼');
  assert.notEqual(cross[2].color, cross[4].color);
});

test('the working-tree row sits in HEAD\'s column, with a line down to it when the way is clear', () => {
  const names = { t: ['feature'], h: ['main'] };
  const clear = layoutGraph(rows([['t', 'a'], ['h', 'a'], ['a']], names), { wip: 'h' });
  assert.equal(text({ graph: clear.wip }), '◌');
  assert.deepEqual(clear.rows.map(text), ['│ ●', '● │', '├─╯', '●']);
  const branch = layoutGraph(rows([['t', 'a'], ['h', 'a'], ['a']], names), { wip: 't' });
  assert.equal(text({ graph: branch.wip }), '  ◌');
  const blocked = layoutGraph(rows([['c', 'h'], ['h', 'a'], ['a']]), { wip: 'h' });
  assert.equal(text({ graph: blocked.wip }), '◌');
  assert.deepEqual(blocked.rows.map(text), ['●', '●', '●']);
  assert.equal(layoutGraph(rows([['a']]), { wip: 'gone' }).wip, null);
});
