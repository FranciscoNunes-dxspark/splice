// Conflict markers in a working file: finding the blocks git left, taking a side of one, and
// showing a whole-file change as a diff. Pure functions over the file's text; every line keeps
// its own ending, so CRLF files stay CRLF and a missing last newline stays missing.

// Git's markers are seven characters, then a space and a label (or nothing). Longer runs are
// content, or the inner markers of a recursive merge, which git makes longer on purpose.
const START = /^<{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;
const SPLIT = /^={7}$/;
const END = /^>{7}(?: |$)/;

/** The lines of `text`, each with its own ending: "\r\n", "\n", or "" for a last line without one. */
export function splitLines(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    if (nl < 0) {
      out.push({ text: text.slice(i), eol: '' });
      break;
    }
    const cr = nl > i && text[nl - 1] === '\r';
    out.push({ text: text.slice(i, cr ? nl - 1 : nl), eol: cr ? '\r\n' : '\n' });
    i = nl + 1;
  }
  return out;
}

const joinLines = (lines) => lines.map((l) => l.text + l.eol).join('');

/**
 * The conflict blocks in `text`. Each block has the line indexes of its markers (`start`, `end`),
 * the [from, to) line ranges of `ours`, `base` (diff3/zdiff3 style only, otherwise null) and `theirs`,
 * and the labels after the markers ("HEAD", "feature", ...). A block that never closes isn't one.
 */
export function parseConflicts(text) {
  const lines = splitLines(text);
  const blocks = [];
  let open = null;
  lines.forEach(({ text: t }, i) => {
    // A new start before the last one closed: the earlier one was just text that looked like a marker.
    if (START.test(t)) return (open = { start: i, oursLabel: t.slice(8), baseAt: null, baseLabel: '', split: null });
    if (!open) return;
    if (open.split == null && open.baseAt == null && BASE.test(t)) {
      open.baseAt = i;
      open.baseLabel = t.slice(8);
    } else if (open.split == null && SPLIT.test(t)) {
      open.split = i;
    } else if (open.split != null && END.test(t)) {
      const { start, baseAt, split } = open;
      blocks.push({
        start,
        end: i,
        ours: [start + 1, baseAt ?? split],
        base: baseAt == null ? null : [baseAt + 1, split],
        theirs: [split + 1, i],
        oursLabel: open.oursLabel,
        baseLabel: open.baseLabel,
        theirsLabel: t.slice(8),
      });
      open = null;
    }
  });
  return { lines, blocks };
}

/** True when `text` still has a line that starts or ends a conflict. */
export function hasMarkers(text) {
  return /^(?:<{7}|>{7})(?: |\r?$)/m.test(text);
}

/**
 * `text` with conflict block `index` replaced by one side: "ours", "theirs", or "both" (ours, then
 * theirs; a diff3 base is dropped either way). Null when there is no such block.
 */
export function takeSide(text, index, side) {
  const { lines, blocks } = parseConflicts(text);
  const b = blocks[index];
  if (!b) return null;
  const range = ([from, to]) => lines.slice(from, to);
  const kept = side === 'ours' ? range(b.ours) : side === 'theirs' ? range(b.theirs) : [...range(b.ours), ...range(b.theirs)];
  const before = lines.slice(0, b.start);
  // The closing marker was the file's last line, without a newline: so is whatever ends the file now.
  if (lines[b.end].eol === '' && b.end === lines.length - 1) {
    const last = kept.length ? kept : before;
    if (last.length) last[last.length - 1] = { ...last.at(-1), eol: '' };
  }
  return joinLines([...before, ...kept, ...lines.slice(b.end + 1)]);
}

/** The line ending most of `text` uses. */
export function lineEnding(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** `text` with the line endings of `like`, and a last newline if and only if `like` has one. */
export function matchLineEndings(text, like) {
  const eol = lineEnding(like);
  const body = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return body.split('\n').join(eol) + (/\n$/.test(like) ? eol : '');
}

// Above this many cells, the middle of the two files is shown as removed and added whole.
const MAX_CELLS = 4_000_000;

/** The edit from lines `a` to lines `b`: [' ' | '-' | '+', text] pairs, in order. */
function editScript(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const x = a.slice(pre, a.length - suf);
  const y = b.slice(pre, b.length - suf);
  const ops = a.slice(0, pre).map((t) => [' ', t]);
  const n = x.length;
  const m = y.length;
  if (n * m > MAX_CELLS) {
    ops.push(...x.map((t) => ['-', t]), ...y.map((t) => ['+', t]));
  } else {
    // Longest common subsequence, from the end, so the walk below goes forwards.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) {
        ops.push([' ', x[i]]);
        i++;
        j++;
      } else if (i < n && (j === m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        // Removals before additions, as git shows them.
        ops.push(['-', x[i++]]);
      } else {
        ops.push(['+', y[j++]]);
      }
    }
  }
  ops.push(...a.slice(a.length - suf).map((t) => [' ', t]));
  return ops;
}

/** A unified diff (with `context` lines around each change) from `before` to `after`, or '' when they're the same. */
export function unifiedDiff(before, after, path, context = 3) {
  const lines = (t) => splitLines(t).map((l) => l.text);
  const ops = editScript(lines(before), lines(after));
  const changed = ops.map((o, i) => (o[0] === ' ' ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return '';
  // Changes closer together than twice the context share a hunk.
  const spans = [];
  for (const i of changed) {
    const last = spans.at(-1);
    if (last && i - last[1] <= context * 2 + 1) last[1] = i;
    else spans.push([i, i]);
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  // Line numbers on each side where op `k` sits.
  const oldAt = [];
  const newAt = [];
  let o = 1;
  let nw = 1;
  for (const [t] of ops) {
    oldAt.push(o);
    newAt.push(nw);
    if (t !== '+') o++;
    if (t !== '-') nw++;
  }
  for (const [first, last] of spans) {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length, last + context + 1);
    const part = ops.slice(from, to);
    const oldLen = part.filter(([t]) => t !== '+').length;
    const newLen = part.filter(([t]) => t !== '-').length;
    // An empty side is numbered by the line before it, as git does.
    const oldStart = oldLen ? oldAt[from] : oldAt[from] - 1;
    const newStart = newLen ? newAt[from] : newAt[from] - 1;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`, ...part.map(([t, text]) => t + text));
  }
  return `${out.join('\n')}\n`;
}
