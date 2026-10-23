// The submodules list's pure parts (submodules.js): recorded commits, what a submodule has inside, a row's text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubmodules } from '../src/parse.js';
import { commitsLine, insideSummary, parseGitlinks, parseInside, submoduleInfo } from '../src/submodules.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('parseGitlinks keeps only submodules (mode 160000), paths with spaces included', () => {
  const raw = [`160000 ${A} 0\tlib`, `100644 ${B} 0\tlib.txt`, `160000 ${B} 0\tvendor/my lib`, ''].join('\n');
  assert.deepEqual(parseGitlinks(raw), { lib: A, 'vendor/my lib': B });
  assert.deepEqual(parseGitlinks(''), {});
});

test('parseInside reads the branch, the commit and the counts of changed and untracked files', () => {
  const raw = [
    `# branch.oid ${A}`,
    '# branch.head main',
    `1 .M N... 100644 100644 100644 ${A} ${A} a.txt`,
    `2 R. N... 100644 100644 100644 ${A} ${A} R100 new.txt`,
    'old.txt',
    '? scratch.txt',
    '? more.txt',
    '',
  ].join('\0');
  assert.deepEqual(parseInside(raw), { branch: 'main', oid: A, changes: 2, untracked: 2 });
  assert.deepEqual(parseInside(`# branch.oid ${B}\0# branch.head (detached)\0`), { branch: null, oid: B, changes: 0, untracked: 0 });
});

test('submoduleInfo puts the recorded commit beside the one checked out', () => {
  const [out, missing, ok] = parseSubmodules([`+${B} lib (heads/main)`, `-${A} other`, ` ${A} third (v1)`].join('\n'));
  const info = submoduleInfo(out, A, { branch: 'main', oid: B, changes: 1, untracked: 0 });
  assert.equal(info.recorded, A);
  assert.equal(info.current, B);
  assert.equal(info.branch, 'main');
  assert.equal(commitsLine(info), `recorded aaaaaaa · has bbbbbbb`);
  assert.equal(insideSummary(info), '1 changed file');

  const notThere = submoduleInfo(missing, undefined, null);
  assert.equal(notThere.current, null);
  assert.equal(notThere.recorded, A);
  assert.equal(commitsLine(notThere), 'recorded aaaaaaa');

  const same = submoduleInfo(ok, A, { branch: null, oid: A, changes: 0, untracked: 3 });
  assert.equal(commitsLine(same), 'at aaaaaaa');
  assert.equal(insideSummary(same), '3 untracked');
});
