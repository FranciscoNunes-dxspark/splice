// Running another program with input on its stdin (a diff for Claude, a body for gh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cli } from '../src/hosting.js';

test('a program that exits before reading its input is an error, not a crash', async () => {
  // Bigger than the pipe holds, so the write is still going when the program has gone.
  for (let i = 0; i < 5; i++) {
    await assert.rejects(cli(process.execPath, ['-e', 'console.error("refused"); process.exit(3)'], { input: 'x'.repeat(2_000_000) }), /refused/);
  }
});
