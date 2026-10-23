// The Changes view's diffs in boxes: a diff read for an older load is let go once a newer one is shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxDiff, emptyOlder } from '../src/ui/ChangesView.jsx';

test('diffs of older loads are emptied once a newer load\'s diff is shown, and only then', async () => {
  const first = await boxDiff(1, Promise.resolve('one'));
  const other = await boxDiff(1, Promise.resolve('another file'));
  const second = await boxDiff(2, Promise.resolve('two'));
  // Read, not yet shown: the one on screen keeps its text.
  assert.equal(first.text, 'one');
  emptyOlder(first);
  assert.deepEqual([first.text, other.text, second.text], ['one', 'another file', 'two']);
  emptyOlder(second);
  assert.deepEqual([first.text, other.text, second.text], [null, null, 'two']);
  emptyOlder(undefined);
  assert.equal(second.text, 'two');
});
