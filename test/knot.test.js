import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FACES, PALETTE, knotPixels, knotRows, moodFor } from '../src/knot.js';

test('every mood is a full 16 × 10 drawing in palette colours', () => {
  for (const mood of Object.keys(FACES)) {
    const px = knotPixels(mood);
    assert.equal(px.length, 10, mood);
    for (const row of px) {
      assert.equal(row.length, 16, `${mood}: ${row}`);
      assert.match(row, new RegExp(`^[.${Object.keys(PALETTE).join('')}]+$`));
    }
  }
});

test('the terminal version is 5 rows of 16 half-block cells', () => {
  const rows = knotRows('idle');
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.length === 16 && r.every((s) => [' ', '▀', '▄'].includes(s.text))));
  // A cell with both pixels filled draws the bottom one as background.
  assert.ok(rows.flat().some((s) => s.text === '▀' && s.bg));
});

test('moods follow the repository', () => {
  const data = (over = {}) => ({ state: null, changes: { conflicts: [] }, status: { branch: { ahead: 0 }, files: [] }, ...over });
  const now = 1_000_000;
  assert.equal(moodFor({ data: data(), now }), 'sleep');
  assert.equal(moodFor({ data: data({ status: { branch: { ahead: 0 }, files: [{}] } }), now }), 'idle');
  assert.equal(moodFor({ data: data({ status: { branch: { ahead: 2 }, files: [] } }), now }), 'wave');
  assert.equal(moodFor({ data: data({ state: 'merging' }), now }), 'worried');
  assert.equal(moodFor({ data: data(), busy: {}, now }), 'look');
  assert.equal(moodFor({ data: data(), lastEntry: { status: 'ok', at: now - 1000 }, now }), 'happy');
  assert.equal(moodFor({ data: data(), lastEntry: { status: 'ok', at: now - 9000 }, now }), 'sleep');
  assert.equal(moodFor({ data: data(), lastEntry: { status: 'error', at: now - 1000 }, now }), 'worried');
});
