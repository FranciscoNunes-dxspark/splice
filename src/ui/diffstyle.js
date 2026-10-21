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
