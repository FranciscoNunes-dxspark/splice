// The commit message file M writes for your editor, and what git keeps of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentChar, messageFileText, promptMessage, readMessage } from '../src/message.js';

test('the message file: the message, then comment lines saying how to use it and what will be committed', () => {
  const text = messageFileText({
    message: 'Count to three\r\n\r\nAnd add b.\n\n',
    files: [{ code: 'M', path: 'a.txt' }, { code: 'A', path: 'b.txt' }, { code: 'R', path: 'new.txt', orig: 'old.txt' }, { code: 'X', path: 'odd' }],
  });
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 4), ['Count to three', '', 'And add b.', '']);
  assert.match(text, /^# Lines starting with # are left out\. Save the file, then press enter in Splice to commit\.$/m);
  assert.match(text, /^# Changes to be committed:\n#\tmodified: {3}a\.txt\n#\tnew file: {3}b\.txt\n#\trenamed: {4}old\.txt -> new\.txt\n#\tchanged: {4}odd$/m);
  assert.ok(text.endsWith('\n'));
  // What git keeps of it, untouched: the message alone.
  assert.equal(readMessage(text), 'Count to three\n\nAnd add b.');
});

test('the message file for an amend, with nothing staged, another comment character, and many files', () => {
  const amend = messageFileText({ message: 'Old subject', files: [{ code: 'M', path: 'a.txt' }], amend: true, comment: ';' });
  assert.match(amend, /^; The amended commit's message:/m);
  assert.match(amend, /^; In the amended commit:\n;\tmodified: {3}a\.txt$/m);
  assert.match(amend, /press enter in Splice to amend\./);
  assert.equal(readMessage(amend, ';'), 'Old subject');
  const empty = messageFileText({});
  assert.ok(empty.startsWith('\n# '));
  assert.match(empty, /Nothing is staged yet/);
  assert.equal(readMessage(empty), '');
  const many = messageFileText({ files: Array.from({ length: 205 }, (_, i) => ({ code: 'M', path: `f${i}` })) });
  assert.match(many, /#\tmodified: {3}f199\n#\t… and 5 more\n/);
  assert.doesNotMatch(many, /f200/);
});

test('what git keeps of a message: no comments, trailing spaces or extra blank lines', () => {
  assert.equal(readMessage('\n\nSubject  \n\n\n\nBody line\n# a comment\n  indented\n\n'), 'Subject\n\nBody line\n  indented');
  assert.equal(readMessage('# only comments\n#\n'), '');
  assert.equal(readMessage(undefined), '');
  // Only lines starting with the comment character go.
  assert.equal(readMessage('Fix #12\n #13 stays'), 'Fix #12\n #13 stays');
});

test("git's comment character, and the message typed in the prompt", () => {
  assert.equal(commentChar(''), '#');
  assert.equal(commentChar('auto\n'), '#');
  assert.equal(commentChar(';\n'), ';');
  assert.deepEqual(promptMessage('/commit Fix the poll\\n\\nIt reloaded twice.'), { amend: false, message: 'Fix the poll\n\nIt reloaded twice.' });
  assert.deepEqual(promptMessage('/amend  Better words '), { amend: true, message: 'Better words' });
  assert.deepEqual(promptMessage('/amend'), { amend: true, message: '' });
  assert.deepEqual(promptMessage('/commit --file /tmp/x'), { amend: false, message: '' });
  assert.deepEqual(promptMessage('/commit --files are fun'), { amend: false, message: '--files are fun' });
  assert.deepEqual(promptMessage('/checkout main'), { amend: false, message: '' });
  assert.deepEqual(promptMessage(''), { amend: false, message: '' });
});
