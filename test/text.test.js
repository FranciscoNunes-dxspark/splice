// text.js against string-width and cli-truncate, which it stands in front of: its own way through
// strings of characters that never join must give exactly what they give.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fullWidth from 'string-width';
import cliTruncate from 'cli-truncate';
import { clean, fit, fitSegments, stringWidth, wrap } from '../src/text.js';

// The ranges text.js takes characters from one at a time (its SIMPLE).
const RANGES = [
  [0x20, 0x7e], [0xa0, 0x2ff], [0x370, 0x482], [0x2010, 0x2027], [0x2030, 0x205e], [0x2070, 0x20cf], [0x2100, 0x27bf],
  [0x2800, 0x2bff], [0x3000, 0x3029], [0x3030, 0x303f], [0x3041, 0x3098], [0x309b, 0x30ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xff01, 0xff9d], [0x1f300, 0x1f3fa], [0x1f400, 0x1faff],
];
const all = RANGES.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i)));

// The same strings every run.
let seed = 42;
const random = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
const sample = (n, from) => Array.from({ length: n }, () => from[random(from.length)]).join('');

const graphemes = new Intl.Segmenter();

test('every character text.js adds up is a grapheme of its own, even beside itself and the others', () => {
  for (const ch of all) assert.equal([...graphemes.segment(`a${ch}${ch}a`)].length, 4, `U+${ch.codePointAt(0).toString(16)}`);
  for (let i = 0; i < 3000; i++) {
    const s = sample(1 + random(8), all);
    assert.equal([...graphemes.segment(s)].length, [...s].length, JSON.stringify(s));
  }
});

test('stringWidth is what string-width says', () => {
  for (let i = 0; i < 300; i++) {
    const ch = all[random(all.length)];
    assert.equal(stringWidth(ch), fullWidth(ch), `U+${ch.codePointAt(0).toString(16)}`);
  }
  const samples = ['', 'plain', '❯ ● main', '╭─ Graph ─╮', '修复 光标', 'ｆｕｌｌ', '🎉 release ✨', 'café', 'Ωμέγα', 'Привет', 'かな カナ', '→ ← ↑ ↓', '⏺'];
  // And the ones it hands over whole: joined emoji, skin tones, combining marks, flags, Hangul, ANSI codes.
  samples.push('👨‍👩‍👧 family', '👍🏽', 'é', '🇳🇱', '한국어', '\x1b[31mred\x1b[39m', 'a​b', '❤️');
  for (let i = 0; i < 500; i++) samples.push(sample(1 + random(30), all));
  for (const s of samples) assert.equal(stringWidth(s), fullWidth(s), JSON.stringify(s));
});

test('fit and fitSegments cut where cli-truncate does', () => {
  const samples = ['修复 光标 跳动 问题 中文提交信息', '🎉 release ✨ sparkle', '❯ ● main → origin/main', '╭─ Graph ──────╮', 'Ünïcödé façade', '👨‍👩‍👧 family'];
  for (let i = 0; i < 500; i++) samples.push(sample(1 + random(30), all));
  for (const s of samples) {
    for (const w of [1, 2, 3, 5, 8, 13, 21]) {
      const want = fullWidth(s) > w ? cliTruncate(s, w) : s + ' '.repeat(w - fullWidth(s));
      assert.equal(fit(s, w), want, `${JSON.stringify(s)} in ${w}`);
      assert.deepEqual(fitSegments([{ text: s, color: 'red' }], w, false).map((x) => x.text).join(''), fullWidth(s) > w ? cliTruncate(s, w) : s);
    }
  }
});

test('fit pads, aligns and cleans', () => {
  assert.equal(fit('ab', 4), 'ab  ');
  assert.equal(fit('ab', 4, 'right'), '  ab');
  assert.equal(fit('abcdef', 4), 'abc…');
  assert.equal(fit('abc', 1), '…');
  assert.equal(fit('abc', 0), '');
  assert.equal(fit('中文', 3), '中…');
  assert.equal(fit('中文字', 4), '中…');
  assert.equal(fit('a\tb\r', 6), 'a   b ');
  assert.equal(clean('a\x1b[31mb'), 'a[31mb');
});

test('fitSegments keeps segments that fit as they are and pads the rest', () => {
  const a = { text: '❯ ', color: 'blue' };
  const b = { text: '● main', color: 'green' };
  const out = fitSegments([a, b, { text: '' }, null], 10);
  assert.equal(out[0], a);
  assert.equal(out[1], b);
  assert.deepEqual(out[2], { text: '  ' });
  assert.deepEqual(fitSegments([a, b], 6), [a, { text: '● m…', color: 'green' }]);
});

test('wrap breaks at spaces, by columns', () => {
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(wrap('中文 中文 中文', 9), ['中文 中文', '中文']);
  assert.deepEqual(wrap('a\r\nb', 9), ['a', 'b']);
  assert.deepEqual(wrap('averyveryverylongword x', 5), ['averyveryverylongword', 'x']);
});
