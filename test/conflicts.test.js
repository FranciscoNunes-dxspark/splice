// Conflict blocks: the marker parser and the edits it makes, Claude's prompt and answer, and both
// ways of resolving through the real UI against a throwaway repository with a real merge conflict.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { hasMarkers, matchLineEndings, parseConflicts, takeSide, unifiedDiff } from '../src/conflict.js';
import { READ_ONLY, parseResolution, resolveInput, resolvePrompt } from '../src/claude.js';
import { App } from '../src/ui/App.jsx';

const TWO = 'a\n<<<<<<< HEAD\nours 1\n=======\ntheirs 1\n>>>>>>> feature\nb\n<<<<<<< HEAD\nours 2\n=======\ntheirs 2\ntheirs 2b\n>>>>>>> feature\nc\n';

test('parseConflicts: several blocks, with their labels and line ranges', () => {
  const { lines, blocks } = parseConflicts(TWO);
  assert.equal(lines.length, 14);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { start: 1, end: 5, ours: [2, 3], base: null, theirs: [4, 5], oursLabel: 'HEAD', baseLabel: '', theirsLabel: 'feature' });
  assert.deepEqual(blocks[1].theirs, [10, 12]);
  assert.equal(takeSide(TWO, 0, 'ours'), 'a\nours 1\nb\n<<<<<<< HEAD\nours 2\n=======\ntheirs 2\ntheirs 2b\n>>>>>>> feature\nc\n');
  assert.equal(takeSide(TWO, 1, 'theirs'), 'a\n<<<<<<< HEAD\nours 1\n=======\ntheirs 1\n>>>>>>> feature\nb\ntheirs 2\ntheirs 2b\nc\n');
  assert.equal(takeSide(takeSide(TWO, 1, 'both'), 0, 'both'), 'a\nours 1\ntheirs 1\nb\nours 2\ntheirs 2\ntheirs 2b\nc\n');
  assert.equal(takeSide(TWO, 2, 'ours'), null);
});

test('parseConflicts: a diff3 base section, dropped whichever side is taken', () => {
  const text = 'x\n<<<<<<< HEAD\nmine\n||||||| merged common ancestors\nold\n=======\nyours\n>>>>>>> topic\n';
  const [b] = parseConflicts(text).blocks;
  assert.deepEqual(b.base, [4, 5]);
  assert.equal(b.baseLabel, 'merged common ancestors');
  assert.deepEqual(b.ours, [2, 3]);
  assert.deepEqual(b.theirs, [6, 7]);
  assert.equal(takeSide(text, 0, 'both'), 'x\nmine\nyours\n');
  assert.equal(takeSide(text, 0, 'theirs'), 'x\nyours\n');
});

test('takeSide keeps CRLF line endings, and a missing last newline stays missing', () => {
  const crlf = TWO.replace(/\n/g, '\r\n');
  assert.equal(parseConflicts(crlf).blocks.length, 2);
  assert.equal(takeSide(takeSide(crlf, 0, 'ours'), 0, 'theirs'), 'a\r\nours 1\r\nb\r\ntheirs 2\r\ntheirs 2b\r\nc\r\n');
  const bare = 'a\n<<<<<<< HEAD\nx\n=======\n>>>>>>> b';
  assert.equal(takeSide(bare, 0, 'ours'), 'a\nx');
  assert.equal(takeSide(bare, 0, 'theirs'), 'a');
});

test('text that only looks like markers is not a conflict', () => {
  assert.deepEqual(parseConflicts('plain\ntext\n').blocks, []);
  assert.equal(takeSide('plain\n', 0, 'ours'), null);
  assert.equal(hasMarkers('plain\n'), false);
  // A Markdown underline, a lone closing marker, longer marker runs, and a block that never closes.
  const lookalikes = 'Title\n=======\n>>>>>>> stray\n<<<<<<<< eight\nx\n========\n>>>>>>>> eight\n<<<<<<< HEAD\nopen\n=======\nnever closed\n';
  assert.deepEqual(parseConflicts(lookalikes).blocks, []);
  // A second ======= inside theirs is just a line of theirs.
  const [b] = parseConflicts('<<<<<<< a\nx\n=======\ny\n=======\n>>>>>>> b\n').blocks;
  assert.deepEqual(b.theirs, [3, 5]);
  assert.equal(hasMarkers('ok\r\n<<<<<<< HEAD\r\n'), true);
  assert.equal(hasMarkers('ok\n>>>>>>>\n'), true);
});

test('matchLineEndings and unifiedDiff', () => {
  assert.equal(matchLineEndings('x\ny', 'a\r\nb\r\n'), 'x\r\ny\r\n');
  assert.equal(matchLineEndings('x\r\ny\n', 'a\nb'), 'x\ny');
  const before = 'a\n<<<<<<< H\nx\n=======\ny\n>>>>>>> t\nb\n';
  assert.equal(unifiedDiff(before, 'a\nx\ny\nb\n', 'f.txt'), '--- a/f.txt\n+++ b/f.txt\n@@ -1,7 +1,4 @@\n a\n-<<<<<<< H\n x\n-=======\n y\n->>>>>>> t\n b\n');
  assert.equal(unifiedDiff(before, before, 'f.txt'), '');
  // Changes far apart make separate hunks.
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  const changed = lines.map((l, i) => (i === 1 || i === 17 ? l.toUpperCase() : l));
  const diff = unifiedDiff(`${lines.join('\n')}\n`, `${changed.join('\n')}\n`, 'f');
  assert.deepEqual(diff.split('\n').filter((l) => l.startsWith('@@')), ['@@ -1,5 +1,5 @@', '@@ -15,6 +15,6 @@']);
});

test("Claude's resolution: the prompt, the input, and the answer without fences", () => {
  assert.match(resolvePrompt('src/a.js'), /src\/a\.js[\s\S]*complete resolved file and nothing else/);
  const input = resolveInput({ path: 'a.txt', state: 'merging', ours: { ref: 'HEAD', message: 'abc Ours' }, theirs: { ref: 'MERGE_HEAD', message: 'def Theirs' }, text: 'FILE' });
  assert.match(input, /Ours: the branch you are on, HEAD:\nabc Ours/);
  assert.match(input, /Theirs: the branch being merged in, MERGE_HEAD:\ndef Theirs/);
  assert.ok(input.endsWith('conflict markers:\nFILE'));
  assert.match(resolveInput({ path: 'a', state: null, ours: null, theirs: null, text: '' }), /Theirs: the changes being applied \(a stash, say\)\./);
  assert.deepEqual(parseResolution('```js\nconst a = 1;\n```'), { text: 'const a = 1;' });
  assert.deepEqual(parseResolution('one\r\ntwo'), { text: 'one\ntwo' });
  assert.match(parseResolution('x\n<<<<<<< HEAD\ny').error, /still has conflict markers/);
  assert.match(parseResolution('  ').error, /didn't send back/);
});

// Through the UI.

const KEYS = { enter: '\r', esc: '\x1b' };
let base;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'tiller-conflicts-'));
  process.env.TILLER_HOME = join(base, 'home');
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

/** A repository stopped in a merge of `feature` into `main`, both having changed `lines` of `file` (CRLF). */
function conflictRepo(name, file, lines, { style = 'merge' } = {}) {
  const dir = join(base, name);
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'merge.conflictStyle', style);
  // No background maintenance after the merge, holding the folder open while the test cleans up.
  const content = (side) => `${Array.from({ length: 20 }, (_, i) => (lines.includes(i + 1) && side ? `${side} ${i + 1}` : `line ${i + 1}`)).join('\r\n')}\r\n`;
  writeFileSync(join(dir, file), content(null));
  git('add', '.');
  git('commit', '-q', '-m', 'Base');
  git('switch', '-q', '-c', 'feature');
  writeFileSync(join(dir, file), content('feat'));
  git('commit', '-q', '-am', 'Feature side');
  git('switch', '-q', 'main');
  writeFileSync(join(dir, file), content('main'));
  git('commit', '-q', '-am', 'Main side');
  try {
    git('merge', '-q', 'feature');
  } catch {
    // Stopping on the conflict is the point.
  }
  const read = () => readFileSync(join(dir, file), 'utf8');
  assert.match(read(), /<<<<<<< HEAD/);
  return { dir, git, read, content };
}

const start = (dir, props = {}) => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, ...props }));
  return lastApp;
};

const markers = (text) => (text.match(/^<<<<<<< /gm) ?? []).length;

test('through the UI: taking ours, theirs and both, block by block', async () => {
  const { dir, git, read, content } = conflictRepo('blocks', 'f.txt', [2, 10, 18], { style: 'diff3' });
  const app = start(dir);
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('MERGING'), 'the merge banner');
    app.stdin.write('2');
    await until(() => /❯ ! f\.txt/.test(frame()) && frame().includes('Conflict 1 of 3'), 'the conflicted file, with its blocks beside it');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('o ours · t theirs · b both'), 'the conflict pane');
    assert.match(frame(), / ours  HEAD/);
    assert.match(frame(), / base  /);
    assert.match(frame(), / theirs  feature/);
    assert.match(frame(), /│ main 2/);
    assert.match(frame(), /│ feat 2/);

    app.stdin.write('n');
    await until(() => frame().includes('▌Conflict 2 of 3'), 'the next block');
    app.stdin.write('N');
    await until(() => frame().includes('▌Conflict 1 of 3'), 'back to the first block');

    app.stdin.write('o');
    await until(() => markers(read()) === 2, 'the first block to take ours');
    await until(() => frame().includes('▌Conflict 1 of 2'), 'the pane to follow');
    app.stdin.write('t');
    await until(() => markers(read()) === 1, 'the second block to take theirs');
    await until(() => frame().includes('▌Conflict 1 of 1'), 'the last block');
    app.stdin.write('b');
    await until(() => markers(read()) === 0, 'the last block to keep both');
    await until(() => frame().includes('No conflicts left in f.txt: space marks it resolved'), 'the note');

    const expected = content('main').replace('main 10', 'feat 10').replace('main 18\r\n', 'main 18\r\nfeat 18\r\n');
    assert.equal(read(), expected);
    // Not staged: the file is still conflicted until you say so.
    assert.equal(git('diff', '--name-only', '--diff-filter=U'), 'f.txt');

    // Back in the file list, space marks it resolved.
    await until(() => frame().includes('↵ resolve block by block'), 'the file list');
    app.stdin.write(' ');
    await until(() => git('diff', '--name-only', '--diff-filter=U') === '', 'the file to be marked resolved');
    assert.equal(git('show', ':f.txt'), expected.trim());
  } finally {
    app.unmount();
  }
});

test('through the UI: Claude proposes a resolution, shown as a diff, written only on yes', async () => {
  const { dir, git, read, content } = conflictRepo('claude', 'g.txt', [5]);
  const before = read();
  const resolved = content('main').replace('main 5', 'main 5 and feat 5');
  const asked = [];
  // The answer comes back fenced and with LF endings; the file is CRLF.
  const askClaude = async (prompt, opts) => {
    asked.push({ prompt, ...opts });
    return `\`\`\`\n${resolved.replace(/\r\n/g, '\n')}\`\`\``;
  };
  const app = start(dir, { askClaude });
  const frame = () => app.lastFrame() ?? '';
  const ask = async () => {
    app.stdin.write('C');
    await until(() => frame().includes("Use Claude's resolution for g.txt?"), 'the question');
  };
  try {
    await until(() => frame().includes('MERGING'), 'the merge banner');
    app.stdin.write('2');
    await until(() => /❯ ! g\.txt/.test(frame()), 'the conflicted file');
    await ask();
    assert.match(frame(), /Claude's resolution of g\.txt/);
    assert.match(frame(), /-<<<<<<< HEAD/);
    assert.match(frame(), /\+main 5 and feat 5/);
    const [first] = asked;
    assert.match(first.prompt, /Resolve the merge conflicts in g\.txt/);
    assert.match(first.input, /Ours: the branch you are on, HEAD:\n[0-9a-f]{7} Main side/);
    assert.match(first.input, /Theirs: the branch being merged in, MERGE_HEAD:\n[0-9a-f]{7} Feature side/);
    assert.ok(first.input.endsWith(before));
    assert.deepEqual(first.tools, READ_ONLY);

    // No leaves the file as it was.
    app.stdin.write('2');
    await until(() => !frame().includes("Use Claude's resolution"), 'the question to go');
    assert.ok(!frame().includes("Claude's resolution of"));
    assert.equal(read(), before);

    // Reading the diff first, then yes.
    await ask();
    app.stdin.write('3');
    await until(() => !frame().includes("Use Claude's resolution") && frame().includes("Claude's resolution of g.txt"), 'the diff on its own');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes("Use Claude's resolution for g.txt?"), 'the question again');
    app.stdin.write('1');
    await until(() => read() === resolved, 'the resolution to be written, CRLF and all');
    await until(() => frame().includes("Wrote Claude's resolution to g.txt"), 'the note');
    assert.ok(!frame().includes("Claude's resolution of"));
    assert.equal(git('diff', '--name-only', '--diff-filter=U'), 'g.txt');
    assert.equal(asked.length, 2);
  } finally {
    app.unmount();
  }
});
