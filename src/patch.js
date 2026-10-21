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

/** Splits a multi-file `git diff` into one diff per file: { path, text }. */
export function splitFiles(text) {
  const out = [];
  const parts = text.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '));
  for (const part of parts) {
    const lines = part.split('\n');
    const plus = lines.find((l) => l.startsWith('+++ '));
    const minus = lines.find((l) => l.startsWith('--- '));
    let path = null;
    if (plus && plus !== '+++ /dev/null') path = plus.slice(4).replace(/^b\//, '');
    else if (minus && minus !== '--- /dev/null') path = minus.slice(4).replace(/^a\//, '');
    else {
      // No ---/+++ lines (a binary file, a mode change): the header's "a/x b/x", both halves the same.
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(lines[0]);
      path = m ? m[2] : lines[0].slice(11);
    }
    out.push({ path: path.replace(/\t$/, ''), text: part.endsWith('\n') ? part : `${part}\n` });
  }
  return out;
}

/** A hunk's identity that survives other hunks being staged: its changed lines, not its line numbers. */
export const hunkSignature = (hunk) => hunk.lines.filter(isChange).join('\n');

/**
 * The units Claude groups into commits: every hunk of every file (H1, H2, ...), in diff order, as
 * { id, path, signature, text } where `text` is the file's header and that one hunk. A file without hunks
 * (binary, mode only) is one unit with `whole` set.
 */
export function splitUnits(diffText) {
  const units = [];
  for (const file of splitFiles(diffText)) {
    const diff = parseDiff(file.text);
    if (!diff.hunks.length) {
      units.push({ id: `H${units.length + 1}`, path: file.path, whole: true, signature: null, text: file.text });
      continue;
    }
    for (const h of diff.hunks) {
      units.push({ id: `H${units.length + 1}`, path: file.path, whole: false, signature: hunkSignature(h), text: [...diff.header, h.header, ...h.lines].join('\n') });
    }
  }
  return units;
}

/**
 * Picks, in `fresh` (a file's diff as it is now), the hunks whose signatures are in `signatures` (each used
 * once). Returns { picks, missing }: the picks map for buildPatch, and how many signatures weren't found.
 */
export function picksBySignature(fresh, signatures) {
  const want = new Map();
  for (const s of signatures) want.set(s, (want.get(s) ?? 0) + 1);
  const picks = new Map();
  fresh.hunks.forEach((h, hi) => {
    const sig = hunkSignature(h);
    if (!want.get(sig)) return;
    want.set(sig, want.get(sig) - 1);
    const set = new Set();
    h.lines.forEach((l, li) => isChange(l) && set.add(li));
    picks.set(hi, set);
  });
  let missing = 0;
  for (const n of want.values()) missing += n;
  return { picks, missing };
}
