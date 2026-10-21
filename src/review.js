// Review comments in a pull request's diff: each thread placed under the line it's about, drawn as a
// box of its comments. Pure, so placing them is tested without a server; hosting.js fetches the
// threads (githubReviewThreads, azureThreads) and TextViewer shows the result.
import { renderMarkdown } from './markdown.js';
import { relTime } from './parse.js';
import { theme } from './theme.js';

/**
 * Where each line of a diff is: { path, old, new } (line numbers on each side, null on the side a
 * line isn't on), or null for the lines around the hunks (headers, "diff --git").
 */
export function diffPositions(lines) {
  const out = [];
  let path = null;
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const line of lines) {
    const file = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (file) {
      path = file[2];
      inHunk = false;
      out.push(null);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      o = Number(hunk[1]);
      n = Number(hunk[2]);
      inHunk = true;
      out.push(null);
      continue;
    }
    if (!inHunk) {
      // A renamed or deleted file names itself here rather than in "diff --git" alone.
      const plus = /^\+\+\+ b\/(.+)$/.exec(line);
      if (plus) path = plus[1];
      out.push(null);
      continue;
    }
    if (line[0] === '+') out.push({ path, old: null, new: n++ });
    else if (line[0] === '-') out.push({ path, old: o++, new: null });
    else if (line[0] === ' ' || line === '') out.push({ path, old: o++, new: n++ });
    else out.push(null); // "\ No newline at end of file"
  }
  return out;
}

/**
 * Which diff line each thread goes under: { at: Map(line index → threads), away: threads }, `away`
 * being the ones whose line isn't in the diff (outdated, or outside the hunks shown).
 */
export function placeThreads(lines, threads, pos = diffPositions(lines)) {
  const at = new Map();
  const away = [];
  for (const t of threads) {
    const i = t.line == null ? -1 : pos.findIndex((p) => p && p.path === t.path && p[t.side] === t.line);
    if (i < 0) away.push(t);
    else at.set(i, [...(at.get(i) ?? []), t]);
  }
  return { at, away };
}

/**
 * Where a new comment on a diff line goes: { path, line, side, text } (`text` the line without its
 * + - or space), or null for a line no comment can go on (headers, hunk headers, "\ No newline").
 * Added lines are on the new side, removed lines on the old, and the unchanged ones around them on
 * `prefer`'s (the new side unless asked: side by side, the one the cursor is on). An unchanged line
 * also has its number on the other side, `old` or `new` (GitLab wants both).
 */
export function lineTarget(pos, line, prefer = 'new') {
  if (!pos?.path) return null;
  const side = pos[prefer] != null ? prefer : prefer === 'new' ? 'old' : 'new';
  const out = { path: pos.path, line: pos[side], side, text: (line ?? '').slice(1) };
  const other = side === 'new' ? 'old' : 'new';
  if (pos[other] != null) out[other] = pos[other];
  return out;
}

/** A thread as viewer lines (segments): a box of its comments, Markdown formatted, `width` wide. */
export function threadLines(thread, width, { current = false, now = Date.now() / 1000, where = false } = {}) {
  const edge = current ? theme.accent : theme.hunk;
  const bar = { text: '  │ ', color: edge };
  const out = [];
  const state = thread.resolved ? '  resolved' : thread.outdated ? '  outdated' : '';
  out.push([
    { text: current ? '  ┏ ' : '  ┌ ', color: edge },
    { text: where ? `${thread.path}${thread.line ? `:${thread.line}` : ''}  ` : '', color: theme.local },
    { text: `${thread.comments.length} comment${thread.comments.length === 1 ? '' : 's'}`, color: theme.dim },
    { text: state, color: theme.dim, italic: true },
  ]);
  thread.comments.forEach((c, k) => {
    if (k) out.push([bar]);
    out.push([bar, { text: c.author || 'someone', bold: true }, { text: ` · ${relTime(c.time, now)}`, color: theme.dim }]);
    for (const l of renderMarkdown(c.body, Math.max(10, width - 4))) out.push([bar, ...l]);
  });
  out.push([{ text: '  └', color: edge }]);
  return out;
}

/**
 * A diff with its review threads drawn in: { lines, starts, rows }. `lines` mixes the diff's own lines
 * (strings) with the threads' (segments); `starts` is where each thread's box begins and ends, in order.
 * `rows` says what each line is: a `key` that stays the same when threads come and go around it, and
 * either `thread` (a line of its box) or `diff` (its index in `diffLines`) with `at` (diffPositions').
 * Threads whose line isn't in the diff come first, under a heading. `current` is the picked thread.
 */
export function withThreads(diffLines, threads, width, { current = null, now } = {}) {
  const pos = diffPositions(diffLines);
  const { at, away } = placeThreads(diffLines, threads, pos);
  const lines = [];
  const starts = [];
  const rows = [];
  const add = (t, where) => {
    const box = threadLines(t, width, { current: current === t.id, now, where });
    starts.push({ thread: t, at: lines.length, end: lines.length + box.length });
    box.forEach((_, k) => rows.push({ key: `t${t.id}:${k}`, thread: t }));
    lines.push(...box);
  };
  if (away.length) {
    lines.push([{ text: 'Comments on lines this diff no longer shows', color: theme.dim, bold: true }]);
    rows.push({ key: 'away' });
    away.forEach((t) => add(t, true));
    lines.push('');
    rows.push({ key: 'away:end' });
  }
  diffLines.forEach((l, i) => {
    lines.push(l);
    rows.push({ key: `d${i}`, diff: i, at: pos[i] });
    for (const t of at.get(i) ?? []) add(t, false);
  });
  return { lines, starts, rows };
}
