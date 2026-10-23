// Blame of the future (F in blame, /future): the open pull requests whose changes touch a line. Pure:
// actions.js's `future` fetches the pull requests' heads and asks git for the diffs these read.
//
// Lines are compared in the merge base of each pull request: the line under the cursor (in the working
// file, or the file as of the commit blamed) is carried back to the merge base through `git diff -U0
// <merge-base> [<commit>] -- <file>`, and the pull request's own `-U0` hunks are in the merge base's
// numbering already. That carrying back is approximate: a line you changed or added counts as the merge
// base's line it took the place of (or, for one only added, the line before it), and a renamed file is
// only followed under its name in the pull request when that's the same name.
import { theme } from './theme.js';

/** The hunks of a `-U0` diff of one file: [{ header, oldStart, oldCount, newStart, newCount, lines }]. */
export function zeroHunks(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) out.push({ header: line, oldStart: Number(m[1]), oldCount: m[2] == null ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] == null ? 1 : Number(m[4]), lines: [] });
    else if (out.length && /^[-+ \\]/.test(line) && !/^(---|\+\+\+) /.test(line)) out.at(-1).lines.push(line);
  }
  return out;
}

/**
 * Line `n` of the new side of `diffText` (a `-U0` diff, old = the merge base) as a line of the old side:
 * { line, changed }, `changed` when the line itself differs there (so the answer is the nearest line).
 */
export function lineInBase(diffText, n) {
  let delta = 0;
  for (const h of zeroHunks(diffText)) {
    // A side with no lines names the line before the change.
    const newFirst = h.newCount ? h.newStart : h.newStart + 1;
    const oldFirst = h.oldCount ? h.oldStart : h.oldStart + 1;
    if (n < newFirst) break;
    if (n < newFirst + h.newCount) {
      const line = h.oldCount ? oldFirst + Math.min(n - newFirst, h.oldCount - 1) : Math.max(1, h.oldStart);
      return { line, changed: true };
    }
    delta = oldFirst + h.oldCount - (newFirst + h.newCount);
  }
  return { line: n + delta, changed: false };
}

/** Whether a hunk (old side: the merge base) changes line `n` of it, or adds lines right at it. */
export function hunkTouches(h, n) {
  if (h.oldCount) return n >= h.oldStart && n < h.oldStart + h.oldCount;
  return n === h.oldStart || n === h.oldStart + 1;
}

/** The hunks of a pull request's `-U0` diff of the file that touch merge-base line `n`. */
export const touchingHunks = (diffText, n) => zeroHunks(diffText).filter((h) => hunkTouches(h, n));

/** `git diff --name-only` output as a list. */
export const nameList = (raw) => String(raw ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

/** `git fetch` refspecs for the pull requests' heads (under refs/splice/future/<id>) and the branches they go into. */
export function futureRefspecs(prs, headRef, remoteName) {
  const specs = prs.map((pr) => `+${headRef(pr)}:refs/splice/future/${pr.id}`);
  for (const t of new Set(prs.map((pr) => pr.target).filter(Boolean))) specs.push(`+refs/heads/${t}:refs/remotes/${remoteName}/${t}`);
  return specs;
}

const MAX_HUNK_LINES = 12;

/**
 * The picker's rows: a heading per pull request (number, title, author), then its hunks that touch the
 * line, each row carrying its `pr` so ↵ anywhere opens that one's diff.
 */
export function futureItems(found) {
  const out = [];
  for (const { pr, hunks } of found) {
    out.push({ pr, segments: [{ text: pr.label ?? `#${pr.id}`, color: theme.warn, bold: true }, { text: `  ${pr.title}`, bold: true }, { text: `  ${pr.author ?? ''}`, color: theme.hunk }, { text: pr.draft ? '  draft' : '', color: theme.dim }] });
    for (const h of hunks) {
      out.push({ pr, segments: [{ text: `   ${h.header}`, color: theme.hunk }] });
      for (const l of h.lines.slice(0, MAX_HUNK_LINES)) out.push({ pr, segments: [{ text: `   ${l}`, color: l[0] === '+' ? theme.add : l[0] === '-' ? theme.del : theme.dim }] });
      if (h.lines.length > MAX_HUNK_LINES) out.push({ pr, segments: [{ text: `   … ${h.lines.length - MAX_HUNK_LINES} more lines (↵ the whole diff)`, color: theme.dim }] });
    }
  }
  return out;
}
