import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/markdown.js';
import { theme } from '../src/theme.js';
import { stringWidth } from '../src/text.js';

const text = (lines) => lines.map((l) => l.map((s) => s.text).join('').trimEnd());
const seg = (lines, t) => lines.flat().find((s) => s.text === t);

test('headings, emphasis, code and links keep their words and gain styles', () => {
  const out = renderMarkdown('# Title\n\nSome **bold**, *italic*, _also_ and `code`. See [the docs](https://x.dev/a).', 80);
  assert.deepEqual(text(out), ['Title', '', 'Some bold, italic, also and code. See the docs (https://x.dev/a).']);
  assert.equal(seg(out, 'Title').bold, true);
  assert.equal(seg(out, 'Title').color, theme.accent);
  assert.equal(seg(out, 'bold').bold, true);
  assert.equal(seg(out, 'italic').italic, true);
  assert.equal(seg(out, 'also').italic, true);
  assert.equal(seg(out, 'code').color, theme.hunk);
  assert.equal(seg(out, 'docs').color, theme.local);
});

test('snake_case, 2 * 3 * 4 and escaped stars stay as written', () => {
  assert.deepEqual(text(renderMarkdown('call load_repo_data and 2 * 3 * 4 and \\*not\\*', 80)), ['call load_repo_data and 2 * 3 * 4 and *not*']);
});

test('lists get bullets and a hanging indent; task lists get boxes', () => {
  const out = renderMarkdown('- one two three four five six\n  - nested\n1. first\n- [ ] todo\n- [x] done', 16);
  assert.deepEqual(text(out), ['• one two three', '  four five six', '  • nested', '1. first', '○ todo', '✓ done']);
});

test('fenced code is kept as is, not wrapped or formatted', () => {
  const out = renderMarkdown('Before\n```js\nconst a = b * c * d; // a long line that is not wrapped\n```\nAfter', 20);
  assert.deepEqual(text(out), ['Before', '  const a = b * c * d; // a long line that is not wrapped', 'After']);
  assert.equal(out[1][0].color, theme.hunk);
});

test('quotes, rules, HTML comments and tags', () => {
  const out = renderMarkdown('<!-- template\nhint -->\n> quoted\n\n---\n<details><summary>More</summary>\n\n\n\nEnd', 10);
  assert.deepEqual(text(out), ['│ quoted', '', '──────────', 'More', '', 'End']);
});

test('tables line up their columns', () => {
  const out = renderMarkdown('| Name | Size |\n|---|--:|\n| a | 100 |\n| longer | 2 |', 80);
  assert.deepEqual(text(out), ['Name   │ Size', '───────┼─────', 'a      │ 100', 'longer │ 2']);
  assert.equal(seg(out, 'Name').bold, true);
});

test('wraps to the width, cutting a word longer than a line rather than losing it', () => {
  const out = renderMarkdown(`See https://example.com/${'x'.repeat(30)} for more`, 20);
  for (const l of out) assert.ok(stringWidth(l.map((s) => s.text).join('')) <= 20, `too wide: ${l.map((s) => s.text).join('')}`);
  assert.equal(text(out)[0], 'See');
  assert.equal(text(out).join(''), `Seehttps://example.com/${'x'.repeat(30)} for more`);
});
