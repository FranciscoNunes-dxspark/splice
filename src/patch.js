// Partial staging: turn a picked subset of a file's diff into a patch git can apply.
// Pure functions, so the tricky part (which lines become context) is easy to test.

/** Splits a one-file `git diff` into its header lines and hunks. Line endings inside lines (\r) are kept. */
export function parseDiff(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const header = [];
  const hunks = [];
  for (const line of lines) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) hunks.push({ header: line, oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] });
    else if (hunks.length) hunks.at(-1).lines.push(line);
    else header.push(line);
  }
  return { header, hunks };
}

export const isChange = (line) => line[0] === '+' || line[0] === '-';

/** Every change line of hunk `hi`, as a picks map. */
export function hunkPicks(diff, hi) {
  const set = new Set();
  diff.hunks[hi].lines.forEach((l, li) => isChange(l) && set.add(li));
  return new Map([[hi, set]]);
}

/** True when `picks` holds every change line in the file, so the whole file can be staged as is. */
export function coversAll(diff, picks) {
  return diff.hunks.every((h, hi) => h.lines.every((l, li) => !isChange(l) || picks.get(hi)?.has(li)));
}

/**
 * Builds a patch holding only the picked lines. `picks` maps hunk index → Set of line indexes.
 * An unpicked change has to stay true to the side the patch is applied to: applied forwards
 * (staging) that side is the old one, so an unpicked "-" becomes context and an unpicked "+"
 * is left out. Applied in reverse (unstaging, discarding) it's the other way round.
 * Returns null when nothing was picked.
 */
export function buildPatch(diff, picks, { reverse = false } = {}) {
  const out = [...diff.header];
  let any = false;
  diff.hunks.forEach((h, hi) => {
    const chosen = picks.get(hi);
    if (!chosen?.size) return;
    const body = [];
    let changed = false;
    let lastKept = true;
    h.lines.forEach((line, li) => {
      const t = line[0];
      // "\ No newline at end of file" belongs to the line before it.
      if (t === '\\') {
        if (lastKept) body.push(line);
        return;
      }
      if (t === '+' || t === '-') {
        if (chosen.has(li)) {
          body.push(line);
          changed = true;
          lastKept = true;
          return;
        }
        lastKept = reverse ? t === '+' : t === '-';
        if (lastKept) body.push(` ${line.slice(1)}`);
        return;
      }
      body.push(line);
      lastKept = true;
    });
    if (!changed) return;
    any = true;
    const oldCount = body.filter((l) => l[0] === ' ' || l[0] === '-').length;
    const newCount = body.filter((l) => l[0] === ' ' || l[0] === '+').length;
    out.push(`@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@`, ...body);
  });
  return any ? `${out.join('\n')}\n` : null;
}
