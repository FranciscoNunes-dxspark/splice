import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPatch, coversAll, hunkPicks, parseDiff } from '../src/patch.js';
import { run } from '../src/git.js';

const DIFF = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,4 @@
 one
-two
+TWO
+two and a half
 three
@@ -10,2 +10,3 @@ section
 ten
+eleven
 twelve
`;

test('parseDiff: header, hunks and their start lines', () => {
  const d = parseDiff(DIFF);
  assert.equal(d.header.length, 4);
  assert.equal(d.hunks.length, 2);
  assert.equal(d.hunks[1].oldStart, 10);
  assert.deepEqual(d.hunks[0].lines, [' one', '-two', '+TWO', '+two and a half', ' three']);
});

test('staging one line: the unpicked "-" stays as context, the unpicked "+" goes', () => {
  const d = parseDiff(DIFF);
  const patch = buildPatch(d, new Map([[0, new Set([2])]]));
  assert.equal(patch.split('\n').slice(4).join('\n'), '@@ -1,3 +1,4 @@\n one\n two\n+TWO\n three\n');
});

test('unstaging one line works the other way round', () => {
  const d = parseDiff(DIFF);
  const patch = buildPatch(d, new Map([[0, new Set([1])]]), { reverse: true });
  assert.equal(patch.split('\n').slice(4).join('\n'), '@@ -1,5 +1,4 @@\n one\n-two\n TWO\n two and a half\n three\n');
});

test('a whole hunk, nothing picked, and covering the file', () => {
  const d = parseDiff(DIFF);
  assert.match(buildPatch(d, hunkPicks(d, 1)), /@@ -10,2 \+10,3 @@\n ten\n\+eleven\n twelve\n$/);
  assert.equal(buildPatch(d, new Map()), null);
  assert.equal(coversAll(d, hunkPicks(d, 0)), false);
  assert.equal(coversAll(d, new Map([...hunkPicks(d, 0), ...hunkPicks(d, 1)])), true);
});

test('"no newline at end of file" follows the line it belongs to', () => {
  const d = parseDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
  const patch = buildPatch(d, new Map([[0, new Set([2])]]));
  assert.equal(patch.split('\n').slice(2).join('\n'), '@@ -1,1 +1,2 @@\n old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
});

// The same patches, applied by real git.
let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
const lines = (n, edit = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'tiller-patch-'));
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  writeFileSync(join(dir, 'f.txt'), lines(30));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
});
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));

const applyCached = (patch, ...flags) => run(dir, ['apply', '--cached', ...flags, '--recount', '-'], { input: patch });

test('git applies a staged hunk and a staged line, and unstages a line', async () => {
  writeFileSync(join(dir, 'f.txt'), lines(30, { 2: 'two!', 3: 'three!', 25: 'twenty-five!' }));
  let d = parseDiff(git('diff', '--', 'f.txt'));
  assert.equal(d.hunks.length, 2);

  await applyCached(buildPatch(d, hunkPicks(d, 1)));
  assert.match(git('diff', '--cached'), /\+twenty-five!/);
  assert.doesNotMatch(git('diff', '--cached'), /two!/);

  d = parseDiff(git('diff', '--', 'f.txt'));
  const plus = d.hunks[0].lines.findIndex((l) => l === '+three!');
  await applyCached(buildPatch(d, new Map([[0, new Set([plus])]])));
  const staged = git('diff', '--cached');
  assert.match(staged, /\+three!/);
  assert.doesNotMatch(staged, /\+two!/);

  d = parseDiff(git('diff', '--cached', '--', 'f.txt'));
  const back = d.hunks[0].lines.findIndex((l) => l === '+three!');
  await applyCached(buildPatch(d, new Map([[0, new Set([back])]]), { reverse: true }), '--reverse');
  assert.doesNotMatch(git('diff', '--cached'), /three!/);
  assert.match(git('diff', '--cached'), /twenty-five!/);
});

test('part of a brand-new file can be staged after --intent-to-add', async () => {
  writeFileSync(join(dir, 'new.txt'), 'a\nb\nc\n');
  git('add', '--intent-to-add', '--', 'new.txt');
  const d = parseDiff(git('diff', '--', 'new.txt'));
  await applyCached(buildPatch(d, new Map([[0, new Set([0])]])));
  assert.equal(git('show', ':new.txt'), 'a\n');
});
