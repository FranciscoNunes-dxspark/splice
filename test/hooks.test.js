// The shared hooks (src/ui/hooks.js), each in a small component of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { asyncCacheSize, forgetAsync, useAsync, useListNav, weigh } from '../src/ui/hooks.js';

const h = React.createElement;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('weigh counts the text a value holds', () => {
  assert.equal(weigh('abc'), 3);
  assert.ok(weigh({ a: 'x'.repeat(1000), b: ['y'.repeat(500), 2] }) >= 1500);
  // A huge value is looked at only so far.
  assert.ok(weigh(Array.from({ length: 100000 }, () => 'z')) < 20000);
});

test('useAsync keeps answers by key, within its bounds, and lets go of the ones made stale', async () => {
  forgetAsync(() => true);
  let loads = 0;
  function Show({ k, size = 1, stale }) {
    const s = useAsync(k, async () => (loads++, `${k}:`.padEnd(size, '.')), 0, { stale });
    return h(Text, null, s.value ? s.value.slice(0, 12) : 'loading');
  }
  const app = render(h(Show, { k: 'a' }));
  await until(() => app.lastFrame().startsWith('a:'), 'a');
  app.rerender(h(Show, { k: 'b' }));
  await until(() => app.lastFrame().startsWith('b:'), 'b');
  app.rerender(h(Show, { k: 'a' }));
  await until(() => app.lastFrame().startsWith('a:'), 'a again');
  assert.equal(loads, 2, 'a came from the cache');

  // Big answers: past the weight limit the oldest go, the newest stays.
  forgetAsync(() => true);
  for (const k of ['big1', 'big2', 'big3']) {
    app.rerender(h(Show, { k, size: 7_000_000 }));
    await until(() => app.lastFrame().startsWith(`${k}:`), k);
  }
  assert.equal(asyncCacheSize().entries, 2);
  assert.ok(asyncCacheSize().weight <= 16_000_000);

  // More than 300 small answers: the oldest go.
  forgetAsync(() => true);
  for (let i = 0; i < 305; i++) {
    app.rerender(h(Show, { k: `n${i}` }));
    await until(() => app.lastFrame().startsWith(`n${i}:`), `n${i}`);
  }
  assert.equal(asyncCacheSize().entries, 300);

  // A newer load's answer on screen lets go of the older loads'.
  forgetAsync(() => true);
  const stale = (load) => (k) => k.startsWith('diff:') && !k.endsWith(`@${load}`);
  for (const k of ['diff:x@1', 'diff:y@1']) {
    app.rerender(h(Show, { k, stale: stale(1) }));
    await until(() => app.lastFrame().startsWith(k.slice(0, 9)), k);
  }
  assert.equal(asyncCacheSize().entries, 2);
  app.rerender(h(Show, { k: 'diff:x@2', stale: stale(2) }));
  await until(() => app.lastFrame().startsWith('diff:x@2'), 'the newer load');
  await until(() => asyncCacheSize().entries === 1, 'the older loads let go');
  app.unmount();
});

test('useListNav with keyOf keeps the cursor on the same row when the rows change', async () => {
  let nav;
  function List({ rows, resetKey, keyed = true }) {
    nav = useListNav(rows.length, 5, { resetKey, keyOf: keyed ? (i) => rows[i] : undefined });
    return h(Text, null, `at ${rows[nav.index] ?? '-'}`);
  }
  const app = render(h(List, { rows: ['a', 'b', 'c'], resetKey: 1 }));
  nav.handle('j', {});
  await until(() => app.lastFrame() === 'at b', 'the cursor on b');
  app.rerender(h(List, { rows: ['x', 'y', 'a', 'b', 'c'], resetKey: 1 }));
  await until(() => app.lastFrame() === 'at b', 'still on b, rows in above it');
  assert.equal(nav.index, 3);
  nav.handle('j', {});
  await until(() => app.lastFrame() === 'at c', 'moved on to c');
  app.rerender(h(List, { rows: ['c', 'a'], resetKey: 1 }));
  await until(() => app.lastFrame() === 'at c', 'c, moved up');
  app.rerender(h(List, { rows: ['a', 'z'], resetKey: 1 }));
  await until(() => app.lastFrame() === 'at a', 'c gone: the row where it was');
  app.rerender(h(List, { rows: ['q', 'r', 'a'], resetKey: 2 }));
  await until(() => app.lastFrame() === 'at q', 'a new resetKey: back on top');
  // Without keyOf, the index stays.
  app.rerender(h(List, { rows: ['q', 'r', 'a'], resetKey: 3, keyed: false }));
  nav.handle('j', {});
  await until(() => app.lastFrame() === 'at r', 'on r');
  app.rerender(h(List, { rows: ['n', 'q', 'r', 'a'], resetKey: 3, keyed: false }));
  await until(() => app.lastFrame() === 'at q', 'index 1 again');
  app.unmount();
});
