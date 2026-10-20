// The pure parts of file history and blame: parsing git's output, the rows drawn, path completion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoDate, parseBlame, parseFileHistory } from '../src/parse.js';
import { blameItems, repoPath } from '../src/history.js';
import { completionKind, suggestionsFor } from '../src/commands.js';
import { fitSegments, stringWidth } from '../src/text.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

const details = (hash, author, summary, file, extra = []) => [
  `author ${author}`,
  `author-mail <${author.toLowerCase()}@example.com>`,
  'author-time 1700000000',
  'author-tz -0500',
  `committer ${author}`,
  'committer-mail <c@example.com>',
  'committer-time 1700000000',
  'committer-tz -0500',
  `summary ${summary}`,
  ...extra,
  `filename ${file}`,
];

test('blame: details come once per commit, later groups and lines reuse them', () => {
  const raw = [
    `${A} 1 1 2`,
    ...details(A, 'Ana', 'First', 'old name.txt', ['boundary']),
    '\tline one',
    `${A} 2 2`,
    '\tline two',
    `${B} 3 3 1`,
    ...details(B, 'Bo', 'Second', 'src/file.txt', [`previous ${A} old name.txt`]),
    '\t\tindented\twith tabs\r',
    // A's second group: just the header, no details and no filename.
    `${A} 3 4 1`,
    '\tcafé ☕ 漢字\r',
    `${ZERO} 5 5 1`,
    ...details(ZERO, 'Not Committed Yet', 'Version of src/file.txt from src/file.txt', 'src/file.txt'),
    '\tnew, not committed',
    '',
  ].join('\n');
  const lines = parseBlame(raw);
  assert.deepEqual(
    lines.map((l) => [l.line, l.orig, l.commit.hash[0], l.start, l.path, l.text]),
    [
      [1, 1, 'a', true, 'old name.txt', 'line one'],
      [2, 2, 'a', false, 'old name.txt', 'line two'],
      [3, 3, 'b', true, 'src/file.txt', '\tindented\twith tabs'],
      [4, 3, 'a', true, 'old name.txt', 'café ☕ 漢字'],
      [5, 5, '0', true, 'src/file.txt', 'new, not committed'],
    ],
  );
  // One object per commit, details filled in from its first appearance.
  assert.equal(lines[0].commit, lines[3].commit);
  assert.deepEqual(
    { ...lines[0].commit },
    { hash: A, author: 'Ana', time: 1700000000, tz: '-0500', summary: 'First', filename: 'old name.txt', previous: null, boundary: true, uncommitted: false },
  );
  assert.deepEqual(lines[2].commit.previous, { hash: A, path: 'old name.txt' });
  assert.equal(lines[4].commit.uncommitted, true);
  assert.equal(lines[2].commit.uncommitted, false);
});

test('blame: a group naming another file than its commit first did keeps that name', () => {
  const raw = [`${A} 1 1 1`, ...details(A, 'Ana', 'S', 'a.txt'), '\tx', `${A} 1 2 1`, 'filename b.txt', '\ty', ''].join('\n');
  assert.deepEqual(parseBlame(raw).map((l) => l.path), ['a.txt', 'b.txt']);
  assert.deepEqual(parseBlame(''), []);
});

test('blame rows: gutter on the first line of each run only, widths in columns, not characters', () => {
  const raw = [
    `${A} 1 1 2`,
    ...details(A, 'Zoë Ünïcode', 'First', 'f.txt'),
    '\tone',
    `${A} 2 2`,
    '\ttwo\tthree',
    `${ZERO} 3 3 1`,
    ...details(ZERO, 'Not Committed Yet', 'Version', 'f.txt'),
    '\t漢字',
    '',
  ].join('\n');
  const rows = blameItems(parseBlame(raw)).map((it) => fitSegments(it.segments, 80).map((s) => s.text).join(''));
  assert.match(rows[0], /^aaaaaaa Zoë Ünïcode 2023-11-14 1 │ one/);
  // Tabs stop every 4 columns of the code itself.
  assert.match(rows[1], /^ {31}2 │ two three/);
  assert.match(rows[2], /^Not committed yet\s+3 │ 漢字/);
  // Every row lines its number up at the same column.
  const at = rows.map((r) => stringWidth(r.slice(0, r.indexOf(' │ '))));
  assert.deepEqual(at, [at[0], at[0], at[0]]);
});

test('isoDate uses the author time zone', () => {
  assert.equal(isoDate(1700000000, '+0000'), '2023-11-14');
  assert.equal(isoDate(1700006400, '-0500'), '2023-11-14');
  assert.equal(isoDate(1700006400, '+0530'), '2023-11-15');
});

test('file history: -z output with renames, deletions and a merge without a file line', () => {
  const rec = (hash, subject, ...fields) => `\x1e${hash}\x1fAna\x1f1700000000\x1f${subject}\0${fields.length ? `\n${fields.join('\0')}\0` : ''}`;
  const raw = [
    rec(A, 'Delete it', 'D', 'new name.txt'),
    rec('c'.repeat(40), 'Merge branch x'),
    rec(B, 'Rename', 'R100', 'old.txt', 'new name.txt'),
    rec('d'.repeat(40), 'Edit', 'M', 'old.txt'),
    rec('e'.repeat(40), 'Add', 'A', 'old.txt'),
  ].join('');
  const list = parseFileHistory(raw, 'new name.txt');
  assert.deepEqual(
    list.map((e) => [e.hash[0], e.status, e.path, e.orig, e.subject]),
    [
      ['a', 'D', 'new name.txt', null, 'Delete it'],
      ['c', null, 'new name.txt', null, 'Merge branch x'],
      ['b', 'R', 'new name.txt', 'old.txt', 'Rename'],
      ['d', 'M', 'old.txt', null, 'Edit'],
      ['e', 'A', 'old.txt', null, 'Add'],
    ],
  );
  assert.equal(list[0].author, 'Ana');
  assert.equal(list[0].time, 1700000000);
  assert.deepEqual(parseFileHistory('', 'x'), []);
});

test('typed paths become relative to the repository root', () => {
  const root = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  assert.equal(repoPath(root, '  src\\ui\\App.jsx '), 'src/ui/App.jsx');
  assert.equal(repoPath(root, './a.txt'), 'a.txt');
  assert.equal(repoPath(root, '"my file.txt"'), 'my file.txt');
  assert.equal(repoPath(root, process.platform === 'win32' ? 'C:\\repo\\docs\\x.md' : '/repo/docs/x.md'), 'docs/x.md');
  assert.equal(repoPath(root, ''), '');
});

test('/history and /blame complete tracked files', () => {
  assert.equal(completionKind('/history src'), 'files');
  assert.equal(completionKind('/blame '), 'files');
  assert.equal(completionKind('/checkout ma'), 'refs');
  assert.equal(completionKind('/history'), null);
  assert.equal(completionKind('/history a b'), null);
  const files = ['README.md', 'src/app.js', 'src/history.js', 'test/history.test.js'];
  const got = suggestionsFor('/history hist', { data: null, files });
  assert.deepEqual(got.map((s) => s.insert), ['/history src/history.js', '/history test/history.test.js']);
  assert.equal(got[0].run, true);
  assert.deepEqual(suggestionsFor('/blame READ', { data: null, files }).map((s) => s.label), ['README.md']);
});
