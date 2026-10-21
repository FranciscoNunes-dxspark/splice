// Claude splits a large change into commits: cutting the diff into hunks, reading Claude's grouping, finding
// a hunk again after others were committed, and the whole flow through the real UI with Claude stubbed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { App } from '../src/ui/App.jsx';
import { parseSplit, splitInput, splitPrompt } from '../src/claude.js';
import { parseDiff, picksBySignature, splitFiles, splitUnits } from '../src/patch.js';

const DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' l1',
  '-l2',
  '+TOP',
  ' l3',
  '@@ -20,3 +20,3 @@',
  ' l20',
  '-l21',
  '+BOTTOM',
  ' l22',
  'diff --git a/img.png b/img.png',
  'index 3333333..4444444 100644',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/new file.txt b/new file.txt',
  'new file mode 100644',
  'index 0000000..5555555',
  '--- /dev/null',
  '+++ b/new file.txt',
  '@@ -0,0 +1 @@',
  '+hello',
  '',
].join('\n');

test('a diff cut into files, then into numbered hunks (a binary file is one)', () => {
  assert.deepEqual(splitFiles(DIFF).map((f) => f.path), ['a.txt', 'img.png', 'new file.txt']);
  const units = splitUnits(DIFF);
  assert.deepEqual(units.map((u) => [u.id, u.path, u.whole]), [
    ['H1', 'a.txt', false],
    ['H2', 'a.txt', false],
    ['H3', 'img.png', true],
    ['H4', 'new file.txt', false],
  ]);
  assert.equal(units[1].signature, '-l21\n+BOTTOM');
  assert.match(units[1].text, /^diff --git a\/a.txt b\/a.txt\n[\s\S]*@@ -20,3 \+20,3 @@\n l20\n-l21\n\+BOTTOM\n l22$/);
  assert.match(splitInput(units), /^### H1 \(a\.txt\)\n/);
  assert.match(splitPrompt(['Add it']), /COMMIT: <subject[\s\S]*HUNKS: H1[\s\S]*- Add it/);
});

test("Claude's grouping: messages and hunks, made-up and repeated hunks dropped, the rest left over", () => {
  const answer = '**COMMIT:** "Add the top line"\nHUNKS: H1, H9\n\nCommit 2: Change the bottom\nHunks: H2 H1 h4\n\nCOMMIT: Nothing real\nHUNKS: H7\n';
  assert.deepEqual(parseSplit(answer, ['H1', 'H2', 'H3', 'H4']), {
    groups: [
      { message: 'Add the top line', ids: ['H1'] },
      { message: 'Change the bottom', ids: ['H2', 'H4'] },
    ],
    leftover: ['H3'],
    error: null,
  });
  assert.match(parseSplit('Sorry, no.', ['H1']).error, /didn't propose/);
});

test('a hunk is found again by its changed lines once the hunks around it are committed', () => {
  const fresh = parseDiff(['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -19,3 +19,3 @@', ' l20', '-l21', '+BOTTOM', ' l22', ''].join('\n'));
  assert.deepEqual(picksBySignature(fresh, ['-l21\n+BOTTOM']), { picks: new Map([[0, new Set([1, 2])]]), missing: 0 });
  assert.equal(picksBySignature(fresh, ['-l2\n+TOP']).missing, 1);
});

let base;
let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const lines = (edit) => `${Array.from({ length: 30 }, (_, i) => edit[i] ?? `l${i + 1}`).join('\n')}\n`;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-split-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), lines({}));
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

test('S in Changes: Claude proposes commits, each is reviewed, committed with just its hunks, or skipped', async () => {
  writeFileSync(join(dir, 'a.txt'), lines({ 1: 'TOP', 27: 'BOTTOM' }));
  writeFileSync(join(dir, 'b.txt'), 'brand new\n');
  writeFileSync(join(dir, 'c.txt'), 'scratch\n');
  git('add', 'a.txt');
  const asked = [];
  const askClaude = async (prompt, opts) => {
    asked.push({ prompt, input: opts.input, tools: opts.tools });
    return 'COMMIT: Change the top line\nHUNKS: H1\n\nCOMMIT: Add notes\nHUNKS: H3\n\nCOMMIT: Change the bottom with b\nHUNKS: H2 H4\n';
  };
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, askClaude }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    app.stdin.write('2');
    await until(() => frame().includes('Staged (1)'), 'the Changes view');
    app.stdin.write('S');
    await until(() => frame().includes('Unstage everything first'), 'the question about what is staged');
    app.stdin.write('1');
    await until(() => frame().includes('Commit 1 of 3: "Change the top line"?') && frame().includes('+TOP'), 'the first commit, with its diff');
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].tools, []);
    assert.match(asked[0].input, /### H1 \(a\.txt\)[\s\S]*### H3 \(b\.txt\)[\s\S]*### H4 \(c\.txt\)/);
    app.stdin.write('1');
    await until(() => git('log', '-1', '--format=%s') === 'Change the top line', 'the first commit');
    assert.equal(git('show', '--format=', 'HEAD').includes('BOTTOM'), false, 'only the top hunk');

    await until(() => frame().includes('Commit 2 of 3: "Add notes"?'), 'the second commit');
    app.stdin.write('2'); // skip it: b.txt stays as it was
    await until(() => frame().includes('Commit 3 of 3: "Change the bottom with b"?'), 'the third commit');
    app.stdin.write('1');
    await until(() => git('log', '-1', '--format=%s') === 'Change the bottom with b', 'the third commit');
    assert.equal(git('show', '--name-only', '--format=', 'HEAD'), 'a.txt\nc.txt');
    await until(() => frame().includes('Made 2 commits'), 'the summary');
    // The skipped new file is untracked again, as it was.
    assert.equal(git('status', '--porcelain'), '?? b.txt');
  } finally {
    app.unmount();
  }
});
