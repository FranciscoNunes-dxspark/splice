import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absorbFiles, absorbText, blameTargets, fileProblem, groupPatch, lineRanges, planAbsorb } from '../src/absorb.js';
import { parseDiff } from '../src/patch.js';

const hunk = (header, lines) => parseDiff([header, ...lines].join('\n')).hunks[0];

test('a hunk is placed by the lines it removes', () => {
  assert.deepEqual(blameTargets(hunk('@@ -4,7 +4,7 @@', [' 4', ' 5', ' 6', '-7', '+seven', ' 8', ' 9', ' 10'])), [7]);
  assert.deepEqual(blameTargets(hunk('@@ -4,8 +4,7 @@', [' 4', ' 5', ' 6', '-7', '-8', '+78', ' 9', ' 10', ' 11'])), [7, 8]);
});

test('lines only added are placed by the lines around them', () => {
  assert.deepEqual(blameTargets(hunk('@@ -4,6 +4,7 @@', [' 4', ' 5', ' 6', '+new', ' 7', ' 8', ' 9'])), [6, 7]);
  // At the top of the file: only the line below. At the bottom: only the line above.
  assert.deepEqual(blameTargets(hunk('@@ -1,3 +1,4 @@', ['+first', ' 1', ' 2', ' 3'])), [1]);
  assert.deepEqual(blameTargets(hunk('@@ -8,3 +8,4 @@', [' 8', ' 9', ' 10', '+last'])), [10]);
  // Into an empty file: nothing to go by.
  assert.deepEqual(blameTargets(hunk('@@ -0,0 +1,2 @@', ['+a', '+b'])), []);
});

test('a hunk with a replacement and an addition blames both kinds of line', () => {
  const h = hunk('@@ -1,8 +1,9 @@', [' 1', '-2', '+two', ' 3', ' 4', '+between', ' 5', ' 6', ' 7', ' 8']);
  assert.deepEqual(blameTargets(h), [2, 4, 5]);
});

test('lineRanges joins neighbouring lines', () => {
  assert.deepEqual(lineRanges([7, 3, 4, 5, 9, 4]), [[3, 5], [7, 7], [9, 9]]);
  assert.deepEqual(lineRanges([]), []);
});

test('files that are added, deleted, renamed or binary stay whole', () => {
  const p = (header) => fileProblem(parseDiff(header.join('\n')));
  assert.equal(p(['diff --git a/x b/x', 'new file mode 100644', '--- /dev/null', '+++ b/x', '@@ -0,0 +1 @@', '+x']), 'a new file');
  assert.equal(p(['diff --git a/x b/x', 'deleted file mode 100644', '--- a/x', '+++ /dev/null', '@@ -1 +0,0 @@', '-x']), 'a deleted file');
  assert.equal(p(['diff --git a/x b/y', 'similarity index 90%', 'rename from x', 'rename to y', '--- a/x', '+++ b/y', '@@ -1 +1 @@', '-x', '+y']), 'renamed');
  assert.equal(p(['diff --git a/x b/x', 'index 1..2 100644', 'Binary files a/x and b/x differ']), 'a binary file');
  assert.equal(p(['diff --git a/x b/x', 'old mode 100644', 'new mode 100755']), 'its mode changed');
  assert.equal(p(['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-x', '+y']), null);
});

const DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,4 +1,4 @@',
  ' 1',
  '-2',
  '+two',
  ' 3',
  ' 4',
  '@@ -12,4 +12,4 @@',
  ' 12',
  ' 13',
  ' 14',
  '-15',
  '+fifteen',
  '@@ -18,3 +18,4 @@',
  ' 18',
  ' 19',
  ' 20',
  '+21',
  'diff --git a/b.txt b/b.txt',
  'index 3333333..4444444 100644',
  '--- a/b.txt',
  '+++ b/b.txt',
  '@@ -1,3 +1,3 @@',
  '-one',
  '+ONE',
  ' two',
  ' three',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..5555555',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1 @@',
  '+new',
  '',
].join('\n');

const A = { hash: 'a'.repeat(40), subject: 'Alpha', parents: ['b'.repeat(40)] };
const B = { hash: 'c'.repeat(40), subject: 'Beta', parents: [A.hash] };
const FIX = { hash: 'd'.repeat(40), subject: 'fixup! Alpha', parents: [B.hash] };
const OLD = 'e'.repeat(40);
const blame = (entries) => new Map(Object.entries(entries).map(([line, hash]) => [Number(line), { hash, summary: hash === OLD ? 'Base' : '' }]));

test('each hunk goes to the one branch commit its lines come from; the rest stay, with why', () => {
  const files = absorbFiles(DIFF);
  const blames = new Map([
    // a.txt: line 2 from Alpha; line 15 from Beta; lines 20 (above the addition, at the end) from the base.
    ['a.txt', blame({ 2: A.hash, 15: B.hash, 20: OLD })],
    // b.txt: line 1 from the fixup! of Alpha, which counts as Alpha.
    ['b.txt', blame({ 1: FIX.hash })],
  ]);
  const plan = planAbsorb(files, blames, [FIX, B, A]);
  assert.deepEqual(
    plan.groups.map((g) => [g.commit.subject, g.hunks.map((h) => `${h.path}:${h.line}`)]),
    [
      ['Beta', ['a.txt:15']],
      ['Alpha', ['a.txt:2', 'b.txt:1']],
    ],
  );
  assert.equal(plan.oldest, A);
  assert.deepEqual(
    plan.stays.map((s) => [s.path, s.line, s.why]),
    [
      ['a.txt', 21, `its lines come from eeeeeee "Base", which isn't one of the branch's own commits`],
      ['new.txt', null, 'a new file'],
    ],
  );
  const text = absorbText(plan);
  assert.match(text, /Into the branch's commits, as fixup! commits \(3 hunks into 2 commits\)/);
  assert.match(text, /ccccccc Beta\n      a.txt:15/);
  assert.match(text, /Staying staged \(2\)/);
  assert.match(text, /new\.txt\s+a new file/);
});

test('a hunk whose lines come from several commits stays', () => {
  const files = absorbFiles(DIFF.split('diff --git a/b.txt')[0]);
  const plan = planAbsorb(files, new Map([['a.txt', blame({ 2: A.hash, 15: A.hash, 20: B.hash })]]), [B, A]);
  // The addition at the end has only the line above it, from Beta: that's one commit.
  assert.deepEqual(plan.groups.map((g) => [g.commit.subject, g.hunks.length]), [['Beta', 1], ['Alpha', 2]]);
  const mixed = planAbsorb(absorbFiles(DIFF.split('diff --git a/b.txt')[0].replace('-2\n+two\n 3', '-2\n+two\n-3\n+three')), new Map([['a.txt', blame({ 2: A.hash, 3: B.hash, 15: A.hash, 20: A.hash })]]), [B, A]);
  assert.equal(mixed.stays[0].why, 'its lines come from 2 commits (aaaaaaa, ccccccc)');
  // A file that couldn't be blamed stays too.
  assert.equal(planAbsorb(files, new Map(), [A]).stays[0].why, "its lines couldn't be blamed");
});

test('groupPatch stages just the group\'s hunks of each file', () => {
  const files = absorbFiles(DIFF);
  const patch = groupPatch(files, { hunks: [{ path: 'a.txt', index: 1 }, { path: 'b.txt', index: 0 }] });
  assert.equal(
    patch,
    [
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -12,4 +12,4 @@',
      ' 12',
      ' 13',
      ' 14',
      '-15',
      '+fifteen',
      'diff --git a/b.txt b/b.txt',
      'index 3333333..4444444 100644',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1,3 +1,3 @@',
      '-one',
      '+ONE',
      ' two',
      ' three',
      '',
    ].join('\n'),
  );
});
