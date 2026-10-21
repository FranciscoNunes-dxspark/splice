// Side-by-side diffs: the old file on the left, the new one on the right, as GitHub's split view shows
// them. Pure, so the pairing is tested without the UI; TextViewer and ChangesView draw the rows.

/** The least width (in columns, the panel's) a diff is offered side by side at. */
export const SPLIT_WIDTH = 120;

/**
 * A diff's lines as side-by-side rows. A row is { full: i } for a line drawn across both columns
 * (file and hunk headers, "\ No newline at end of file", anything outside a hunk), or
 * { left, right, old, new }: the indexes of the lines on each side (null where that side is blank)
 * and their line numbers. Unchanged lines are on both sides. A run of removed lines is paired with
 * the run of added lines that follows it, in order (the first - with the first +, ...); what's left
 * of the longer run faces a blank.
 */
export function splitRows(lines) {
  const out = [];
  let o = 0;
  let n = 0;
  // Lines left in the hunk on each side, from its header; a hunk ends when both run out.
  let oldLeft = 0;
  let newLeft = 0;
  let i = 0;
  const inHunk = () => oldLeft > 0 || newLeft > 0;
  while (i < lines.length) {
    const line = lines[i];
    const hunk = typeof line === 'string' && /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      o = Number(hunk[1]);
      n = Number(hunk[3]);
      oldLeft = hunk[2] == null ? 1 : Number(hunk[2]);
      newLeft = hunk[4] == null ? 1 : Number(hunk[4]);
      out.push({ full: i++ });
      continue;
    }
    if (typeof line !== 'string' || !inHunk() || line[0] === '\\') {
      out.push({ full: i++ });
      continue;
    }
    if (line[0] === '-' || line[0] === '+') {
      // A run of removals, then the additions after it; "\ No newline" notes among them go after the pairs.
      const dels = [];
      const adds = [];
      const notes = [];
      while (i < lines.length && typeof lines[i] === 'string' && lines[i][0] === '-' && oldLeft > 0) {
        dels.push(i++);
        oldLeft--;
        while (i < lines.length && typeof lines[i] === 'string' && lines[i][0] === '\\') notes.push(i++);
      }
      while (i < lines.length && typeof lines[i] === 'string' && lines[i][0] === '+' && newLeft > 0) {
        adds.push(i++);
        newLeft--;
        while (i < lines.length && typeof lines[i] === 'string' && lines[i][0] === '\\') notes.push(i++);
      }
      if (!dels.length && !adds.length) {
        // A + or - the header's counts have no room for: not part of the hunk after all.
        out.push({ full: i++ });
        oldLeft = newLeft = 0;
        continue;
      }
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const l = dels[k] ?? null;
        const r = adds[k] ?? null;
        out.push({ left: l, right: r, old: l == null ? null : o++, new: r == null ? null : n++ });
      }
      for (const k of notes) out.push({ full: k });
      continue;
    }
    // Unchanged (an empty line too: some tools trim the space off a blank one).
    out.push({ left: i, right: i, old: o++, new: n++ });
    oldLeft--;
    newLeft--;
    i++;
  }
  return out;
}

/**
 * The viewer's lines laid out side by side: { view, rowOf, digits }. `lines` are the viewer's lines,
 * `rows` what each one is (review.js's withThreads: a `diff` index for the diff's own lines), or null
 * when every line is the diff's. Lines that aren't the diff's (review threads) go across both columns
 * under the row of the line they follow, so a thread sits under the pair its line is in. `view` holds
 * the rows (as splitRows', with indexes into `lines`), `rowOf` the row each line is in, and `digits`
 * how wide the line numbers get.
 */
export function splitView(lines, rows = null) {
  const own = [];
  // The other lines after each diff line (by its index in `own`), and those before the first.
  const after = new Map();
  const before = [];
  lines.forEach((l, i) => {
    if (!rows || rows[i]?.diff != null) {
      own.push(i);
      return;
    }
    if (!own.length) before.push(i);
    else {
      const k = own.length - 1;
      if (!after.has(k)) after.set(k, []);
      after.get(k).push(i);
    }
  });
  const view = before.map((i) => ({ full: i }));
  let most = 0;
  const at = (k) => (k == null ? null : own[k]);
  for (const r of splitRows(own.map((i) => lines[i]))) {
    if (r.full != null) view.push({ full: own[r.full] });
    else {
      view.push({ left: at(r.left), right: at(r.right), old: r.old, new: r.new });
      most = Math.max(most, r.old ?? 0, r.new ?? 0);
    }
    const ks = r.full != null ? [r.full] : [...new Set([r.left, r.right].filter((k) => k != null))];
    for (const k of ks) for (const i of after.get(k) ?? []) view.push({ full: i });
  }
  const rowOf = new Array(lines.length).fill(0);
  view.forEach((r, v) => {
    for (const i of rowLines(r)) rowOf[i] = v;
  });
  return { view, rowOf, digits: String(most).length };
}

/** The lines a row holds: one, or the two sides (once, for an unchanged line). */
export function rowLines(row) {
  if (row.full != null) return [row.full];
  if (row.left === row.right) return [row.left];
  return [row.left, row.right].filter((i) => i != null);
}

/** The line of a row on `side` ('old' or 'new'), or the other side's where that one is blank. */
export function lineOn(row, side) {
  if (row.full != null) return row.full;
  return side === 'old' ? (row.left ?? row.right) : (row.right ?? row.left);
}

/** Which side a line is drawn on in its row: 'old', 'new', 'both' (unchanged) or null (across both). */
export function sideOf(row, i) {
  if (row.full != null) return null;
  if (row.left === i && row.right === i) return 'both';
  return row.left === i ? 'old' : 'new';
}
