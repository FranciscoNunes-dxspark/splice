// How diff lines are coloured in the views and the viewer.
import { theme } from '../theme.js';
import { markRanges } from '../search.js';
import { clean } from '../text.js';

/** A diff line coloured by its prefix. */
export function diffSegment(line) {
  const text = clean(line);
  if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename (from|to))/.test(line)) return { text, color: theme.dim, bold: true };
  if (line.startsWith('@@')) return { text, color: theme.hunk };
  if (line.startsWith('+')) return { text, color: theme.add };
  if (line.startsWith('-')) return { text, color: theme.del };
  if (/^commit [0-9a-f]{7,}/.test(line)) return { text, color: theme.warn, bold: true };
  return { text };
}

/** A diff line as segments, with the words it changed (`ranges`, from search.js's wordChanges) picked out. */
export function diffSegments(line, ranges) {
  const seg = diffSegment(line);
  if (!ranges) return [seg];
  return markRanges([seg], ranges, { bg: line[0] === '+' ? theme.addWord : theme.delWord, bold: true });
}

// A commit's line in git range-diff's output: "2:  d64780f ! 2:  c5383a9 Subject".
export const RANGE_COMMIT = /^\s*(?:\d+|-+):\s+(?:[0-9a-f]+|-+) ([=!<>]) (?:\d+|-+):\s+(?:[0-9a-f]+|-+) /;
const RANGE_TONE = { '=': 'dim', '!': 'warn', '<': 'del', '>': 'add' };

/**
 * A line of git range-diff's output: each commit's line coloured by what happened to it (= the same,
 * ! changed, < only before, > only after), and under a changed one, the diff of its diffs by its own
 * first column (indented four spaces): + what the new version has, - what the old one had.
 */
export function rangeDiffSegments(line) {
  const text = clean(line);
  const commit = RANGE_COMMIT.exec(line);
  if (commit) return [{ text, color: theme[RANGE_TONE[commit[1]]], bold: commit[1] !== '=' }];
  if (!line.startsWith('    ')) return [{ text }];
  const inner = line.slice(4);
  if (inner.startsWith('@@')) return [{ text, color: theme.hunk }];
  if (inner.startsWith('+')) return [{ text, color: theme.add }];
  if (inner.startsWith('-')) return [{ text, color: theme.del }];
  // "## Commit message ##", "## a.txt ##": which part of the commit the lines below are about.
  return [inner.trimStart().startsWith('## ') ? { text, color: theme.dim, bold: true } : { text }];
}
