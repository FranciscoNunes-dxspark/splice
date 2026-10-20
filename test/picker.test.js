import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Picker } from '../src/ui/Picker.jsx';

const until = async (check, what) => {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

test('the picker loads its items, moves, picks with ↵, runs its keys and closes on esc', async () => {
  const picked = [];
  const ctx = { overlayHasKeys: () => true, closeOverlay: () => picked.push('closed'), mouseHandlers: [] };
  const picker = {
    title: 'Pick one',
    hint: '↵ take it',
    load: async () => ['alpha', 'beta', 'gamma'].map((name) => ({ name, segments: [{ text: name }] })),
    onPick: (it) => picked.push(`pick ${it.name}`),
    keys: { x: (it) => picked.push(`x ${it.name}`) },
  };
  const app = render(React.createElement(Picker, { picker, ctx, width: 60, height: 8, active: true }));
  try {
    await until(() => app.lastFrame().includes('gamma'), 'the items');
    assert.match(app.lastFrame(), /Pick one/);
    app.stdin.write('j');
    await until(() => /❯ beta/.test(app.lastFrame()), 'the cursor on beta');
    app.stdin.write('\r');
    app.stdin.write('x');
    app.stdin.write('\x1b');
    await until(() => picked.length === 3, 'the actions');
    assert.deepEqual(picked, ['pick beta', 'x beta', 'closed']);
    // Loaded once and kept on the overlay, with the cursor, for coming back to it.
    assert.equal(picker.items.length, 3);
    assert.equal(picker.index, 1);
  } finally {
    app.unmount();
  }
});
