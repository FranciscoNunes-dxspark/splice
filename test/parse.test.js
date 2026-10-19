import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupChanges,
  parseDecorations,
  parseGraph,
  parseNameStatus,
  parseRefs,
  parseStatus,
  parseTrack,
  parseWorktrees,
  relTime,
  splitArgs,
} from '../src/parse.js';
import { suggestionsFor, findCommand } from '../src/commands.js';
import { fitSegments, clean } from '../src/text.js';
import { graphSegments, refPills } from '../src/ui/GraphView.jsx';

test('status: branch header, all entry kinds, and paths with spaces', () => {
  const raw = [
    '# branch.oid 4e9f0080cb38cfa0ec89696ff49897fb39acc9e1',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/my file.js',
    '1 A. N... 000000 100644 100644 000 ccc new.txt',
    '2 R. N... 100644 100644 100644 ddd ddd R100 renamed.js',
    'old name.js',
    'u UU N... 100644 100644 100644 100644 e f g conflict.js',
    '? untracked dir/file.md',
    '',
  ].join('\0');
  const { branch, files } = parseStatus(raw);
  assert.deepEqual(branch, { oid: '4e9f0080cb38cfa0ec89696ff49897fb39acc9e1', head: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
  assert.deepEqual(
    files.map((f) => [f.kind, f.x + f.y, f.path, f.orig]),
    [
      ['changed', '.M', 'src/my file.js', undefined],
      ['changed', 'A.', 'new.txt', undefined],
      ['renamed', 'R.', 'renamed.js', 'old name.js'],
      ['unmerged', 'UU', 'conflict.js', undefined],
      ['untracked', '??', 'untracked dir/file.md', undefined],
    ],
  );
  const g = groupChanges(files);
  assert.deepEqual(g.unstaged.map((f) => f.path), ['src/my file.js', 'untracked dir/file.md']);
  assert.deepEqual(g.staged.map((f) => [f.code, f.path]), [['A', 'new.txt'], ['R', 'renamed.js']]);
  assert.deepEqual(g.conflicts.map((f) => f.path), ['conflict.js']);
});

test('status: a fresh repository and a detached HEAD', () => {
  assert.equal(parseStatus('# branch.oid (initial)\0# branch.head main\0').branch.oid, null);
  assert.equal(parseStatus('# branch.oid abc\0# branch.head (detached)\0').branch.head, null);
});

test('decorations: HEAD, locals, remotes, tags; origin/HEAD is dropped', () => {
  assert.deepEqual(parseDecorations('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0'), [
    { type: 'local', name: 'main', head: true },
    { type: 'remote', name: 'origin/main' },
    { type: 'tag', name: 'v1.0' },
  ]);
  assert.deepEqual(parseDecorations('HEAD'), [{ type: 'head', name: 'HEAD' }]);
  assert.deepEqual(parseDecorations(''), []);
});

test('graph: commit rows and connector rows', () => {
  const raw = [
    '*   \x1faaa\x1fbbb ccc\x1fHEAD -> refs/heads/main\x1fAna\x1f1700000000\x1fMerge feature',
    '|\\  ',
    '| * \x1fccc\x1fbbb\x1f\x1fBo\x1f1699999000\x1fWork, with \x1f-free subject',
    '|/  ',
    '* \x1fbbb\x1f\x1f\x1fAna\x1f1699990000\x1fFirst',
  ].join('\n');
  const rows = parseGraph(raw);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].graph, '*');
  assert.deepEqual(rows[0].commit.parents, ['bbb', 'ccc']);
  assert.equal(rows[0].commit.refs[0].name, 'main');
  assert.equal(rows[1].commit, undefined);
  assert.equal(rows[1].graph, '|\\');
  assert.deepEqual(rows[4].commit.parents, []);
});

test('refs: tracking info, current branch, remotes without HEAD, tags newest first', () => {
  const line = (...f) => f.join('\x1f');
  const raw = [
    line('refs/heads/main', 'a1', 'origin/main', '[ahead 1, behind 2]', '*', '100', 'Top'),
    line('refs/heads/old', 'a2', 'origin/old', '[gone]', ' ', '90', 'Old'),
    line('refs/remotes/origin/HEAD', 'a1', '', '', ' ', '100', 'Top'),
    line('refs/remotes/origin/main', 'a1', '', '', ' ', '100', 'Top'),
    line('refs/tags/v1', 't1', '', '', ' ', '50', 'one'),
    line('refs/tags/v2', 't2', '', '', ' ', '80', 'two'),
  ].join('\n');
  const { local, remote, tags } = parseRefs(raw);
  assert.deepEqual(local.map((b) => [b.name, b.current, b.ahead, b.behind, b.gone]), [
    ['main', true, 1, 2, false],
    ['old', false, 0, 0, true],
  ]);
  assert.deepEqual(remote.map((b) => [b.name, b.remote]), [['origin/main', 'origin']]);
  assert.deepEqual(tags.map((t) => t.name), ['v2', 'v1']);
  assert.deepEqual(parseTrack(''), { ahead: 0, behind: 0, gone: false });
});

test('name-status with renames', () => {
  assert.deepEqual(parseNameStatus('M\ta.js\nR087\told.js\tnew.js\n'), [
    { code: 'M', path: 'a.js' },
    { code: 'R', orig: 'old.js', path: 'new.js' },
  ]);
});

test('splitArgs keeps quoted text together and backslashes literal', () => {
  assert.deepEqual(splitArgs('commit -m "fix the \\"thing\\"" --no-verify'), ['commit', '-m', 'fix the "thing"', '--no-verify']);
  assert.deepEqual(splitArgs("log 'a b' C:\\Team\\x"), ['log', 'a b', 'C:\\Team\\x']);
  assert.deepEqual(splitArgs('  '), []);
  assert.deepEqual(splitArgs('tag ""'), ['tag', '']);
});

test('relTime buckets', () => {
  const now = 1_000_000_000;
  assert.equal(relTime(now - 5, now), 'now');
  assert.equal(relTime(now - 300, now), '5m');
  assert.equal(relTime(now - 7200, now), '2h');
  assert.equal(relTime(now - 86400 * 3, now), '3d');
  assert.equal(relTime(now - 86400 * 400, now), '1y');
});

test('fitSegments truncates at the edge and pads to width', () => {
  const out = fitSegments([{ text: 'abc', color: 'red' }, { text: 'defgh' }], 6);
  assert.equal(out.map((s) => s.text).join(''), 'abcde…');
  assert.equal(out[0].color, 'red');
  assert.equal(fitSegments([{ text: 'ab' }], 4).map((s) => s.text).join(''), 'ab  ');
  assert.equal(clean('a\tb\r'), 'a   b');
});

test('graph glyphs are padded and coloured per lane', () => {
  const segs = graphSegments('| *', 5);
  assert.equal(segs.map((s) => s.text).join(''), '│ ●  ');
  assert.notEqual(segs[0].color, segs.find((s) => s.text.includes('●')).color);
});

test('a local branch absorbs its remote twin in the pills', () => {
  const text = refPills([
    { type: 'local', name: 'main', head: true },
    { type: 'remote', name: 'origin/main' },
    { type: 'remote', name: 'origin/other' },
  ])
    .map((s) => s.text)
    .join('');
  assert.match(text, /● main ⇅ origin/);
  assert.match(text, /origin\/other/);
  assert.doesNotMatch(text, /origin\/main/);
});

test('slash suggestions: command names, then ref completion', () => {
  const data = { refs: { local: [{ name: 'main' }, { name: 'feature/login' }], remote: [{ name: 'origin/main' }], tags: [] } };
  const names = suggestionsFor('/pu', { data }).map((s) => s.label);
  assert.deepEqual(names, ['/pull', '/push']);
  const checkout = suggestionsFor('/checkout ', { data });
  assert.equal(checkout[0].insert, '/checkout main');
  assert.deepEqual(suggestionsFor('/checkout log', { data }).map((s) => s.label), ['feature/login']);
  assert.deepEqual(suggestionsFor('/checkout main', { data }).map((s) => s.label), ['main', 'origin/main']);
  assert.equal(suggestionsFor('/commit ', { data }).length, 0);
  assert.equal(findCommand('co'), null, 'ambiguous: commit, continue, checkout');
  assert.equal(findCommand('chec').name, 'checkout');
});

test('worktrees: main, branch, detached, locked and missing ones, paths with spaces', () => {
  const raw = [
    'worktree C:/Team/Keel', 'HEAD aaaa', 'branch refs/heads/main', '',
    'worktree C:/Team/Keel feature', 'HEAD bbbb', 'branch refs/heads/feature/login', 'locked on a USB drive', '',
    'worktree C:/Team/Keel-review', 'HEAD cccc', 'detached', 'locked', '',
    'worktree C:/Team/gone', 'HEAD dddd', 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location', '',
    '',
  ].join('\0');
  const list = parseWorktrees(raw);
  assert.deepEqual(
    list.map((w) => [w.path, w.branch, w.head, w.main, w.locked, w.prunable, w.reason]),
    [
      ['C:/Team/Keel', 'main', 'aaaa', true, false, false, ''],
      ['C:/Team/Keel feature', 'feature/login', 'bbbb', false, true, false, 'on a USB drive'],
      ['C:/Team/Keel-review', null, 'cccc', false, true, false, ''],
      ['C:/Team/gone', 'gone', 'dddd', false, false, true, 'gitdir file points to non-existent location'],
    ],
  );
  assert.deepEqual(parseWorktrees(['worktree /srv/repo.git', 'bare', '', ''].join('\0')).map((w) => [w.bare, w.main]), [[true, true]]);
  assert.deepEqual(parseWorktrees(''), []);
});
