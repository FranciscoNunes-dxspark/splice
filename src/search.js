// Searching the viewer's text (/ then n/N), and picking out parts of a line in its segments: the
// matches, and the words a diff changed. Pure, so it's tested without the UI.

/**
 * A function finding `query` in a text, as [from, to) offsets. Smart case: a query with a capital
 * letter matches case for case, one without matches any case. Null for an empty query.
 */
export function matcher(query) {
  if (!query) return null;
  const sensitive = /[A-Z]/.test(query);
  const q = sensitive ? query : query.toLowerCase();
  return (text) => {
    const t = sensitive ? text : text.toLowerCase();
    const out = [];
    for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) out.push([i, i + q.length]);
    return out;
  };
}

/** A viewer line's text: the line itself, or its segments' text joined. */
export const lineText = (line) => (typeof line === 'string' ? line : line.map((s) => s.text).join(''));

/** The indexes of the lines `query` is found in. */
export function matchingLines(lines, query) {
  const find = matcher(query);
  if (!find) return [];
  const out = [];
  lines.forEach((l, i) => find(lineText(l)).length && out.push(i));
  return out;
}

/** `segments` with the parts inside `ranges` ([from, to) offsets into their joined text) restyled with `style`. */
export function markRanges(segments, ranges, style) {
  if (!ranges?.length) return segments;
  const inside = (at) => ranges.some(([a, b]) => at >= a && at < b);
  const out = [];
  let pos = 0;
  for (const s of segments) {
    const end = pos + s.text.length;
    const cuts = new Set([pos, end]);
    for (const [a, b] of ranges) {
      if (a > pos && a < end) cuts.add(a);
      if (b > pos && b < end) cuts.add(b);
    }
    const points = [...cuts].sort((x, y) => x - y);
    for (let k = 0; k < points.length - 1; k++) {
      const text = s.text.slice(points[k] - pos, points[k + 1] - pos);
      if (text) out.push(inside(points[k]) ? { ...s, ...style, text } : { ...s, text });
    }
    pos = end;
  }
  return out;
}

// Words, runs of spaces, and single other characters: what a word diff compares.
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
const MAX_TOKENS = 200;
const isDel = (l) => l[0] === '-' && !l.startsWith('--- ');
const isAdd = (l) => l[0] === '+' && !l.startsWith('+++ ');

/**
 * The words a diff changed within its lines, for highlighting: a Map from line index to the
 * [from, to) ranges in that line. A run of removed lines followed by a run of added ones pairs
 * them up in order (the first - with the first +, ...), and each pair is compared word by word.
 * A pair that changed more than it kept is left alone: highlighting all of it says nothing.
 */
export function wordChanges(lines) {
  const out = new Map();
  let i = 0;
  while (i < lines.length) {
    if (!isDel(lines[i])) {
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && isDel(lines[d])) d++;
    let e = d;
    while (e < lines.length && isAdd(lines[e])) e++;
    for (let k = 0; k < Math.min(d - i, e - d); k++) {
      const pair = comparePair(lines[i + k], lines[d + k]);
      if (!pair) continue;
      out.set(i + k, pair.old);
      out.set(d + k, pair.new);
    }
    i = Math.max(d, e);
  }
  return out;
}

// The comparison's table, big enough for the longest lines compared.
const TABLE = new Uint16Array((MAX_TOKENS + 1) * (MAX_TOKENS + 1));

/** The changed ranges of an old and a new line (both with their - or + in front), or null. */
function comparePair(oldLine, newLine) {
  const a = oldLine.slice(1).match(TOKEN) ?? [];
  const b = newLine.slice(1).match(TOKEN) ?? [];
  if (!a.length || !b.length || a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;
  // Longest common subsequence of the tokens. The tokens both lines start with are kept as they come (the
  // walk below takes a match whenever there is one), so the table only covers what follows them: one
  // table, row x - p at (x - p) * w, shared by every pair.
  const n = a.length;
  const m = b.length;
  let p = 0;
  while (p < n && p < m && a[p] === b[p]) p++;
  const w = m - p + 1;
  const len = TABLE;
  const at = (x, y) => (x - p) * w + (y - p);
  len.fill(0, at(n, p), at(n, m) + 1);
  for (let x = n - 1; x >= p; x--) {
    const row = at(x, p) - p;
    len[row + m] = 0;
    for (let y = m - 1; y >= p; y--) len[row + y] = a[x] === b[y] ? len[row + w + y + 1] + 1 : Math.max(len[row + w + y], len[row + y + 1]);
  }
  const keptA = new Array(n).fill(false);
  const keptB = new Array(m).fill(false);
  for (let x = 0, y = 0; x < n && y < m; ) {
    if (a[x] === b[y]) {
      keptA[x++] = true;
      keptB[y++] = true;
    } else if (len[at(x + 1, y)] >= len[at(x, y + 1)]) x++;
    else y++;
  }
  const old = ranges(a, keptA);
  const neu = ranges(b, keptB);
  if (!old.ranges.length && !neu.ranges.length) return null;
  // Mostly rewritten: no highlighting. Spaces don't count either way.
  if (old.changed > old.kept || neu.changed > neu.kept) return null;
  return { old: old.ranges, new: neu.ranges };
}

/** Ranges (offset by the line's first character) of the tokens not kept, joining neighbours across spaces. */
function ranges(tokens, kept) {
  const out = [];
  let pos = 1;
  let changed = 0;
  let keptChars = 0;
  tokens.forEach((t, k) => {
    const blank = !t.trim();
    if (!kept[k] && !blank) {
      changed += t.length;
      const last = out.at(-1);
      // A space between two changed words joins them into one range.
      if (last && /^\s*$/.test(tokens.slice(last.k + 1, k).join(''))) {
        last[1] = pos + t.length;
        last.k = k;
      } else out.push(Object.assign([pos, pos + t.length], { k }));
    } else if (!blank) keptChars += t.length;
    pos += t.length;
  });
  return { ranges: out.map(([a, b]) => [a, b]), changed, kept: keptChars };
}
