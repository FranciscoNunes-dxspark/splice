// A file's history and blame, as pickers (ctx.showPicker): each one opens the other, and ↵ shows a commit's diff.
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
// actions.js imports this module too; only functions cross, called long after both have loaded.
import { claudeBlame, future } from './actions.js';
import { HISTORY_FORMAT, isoDate, parseBlame, parseFileHistory, relTime } from './parse.js';
import { parseDiff } from './patch.js';
import { theme } from './theme.js';
import { fit, stringWidth } from './text.js';

const short = (hash) => hash.slice(0, 7);
const MAX_HISTORY = 2000;

/** A path as typed in a command, made relative to the repository root with forward slashes. */
export function repoPath(root, typed) {
  let p = String(typed ?? '').trim();
  if (/^(["']).+\1$/.test(p)) p = p.slice(1, -1);
  if (isAbsolute(p)) p = relative(root, p);
  return p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

const authorWidth = (names) => Math.min(16, Math.max(1, ...names.map(stringWidth)));

/** One row of a file's history: hash, age, author, the path then (if it was another), subject. */
export function historySegments(e, path, authorW, now = Date.now() / 1000) {
  const segs = [
    { text: short(e.hash), color: theme.warn },
    { text: ` ${fit(relTime(e.time, now), 4, 'right')}`, color: theme.dim },
    { text: `  ${fit(e.author, authorW)}`, color: theme.hunk },
  ];
  if (e.path !== path) segs.push({ text: `  ${e.path}`, color: theme.local });
  if (e.orig) segs.push({ text: `  ← ${e.orig}`, color: theme.dim });
  if (e.status === 'D') segs.push({ text: '  deleted', color: theme.del });
  segs.push({ text: `  ${e.subject}` });
  return segs;
}

/** Blame lines as picker items: a gutter (hash, author, date) on the first line of each run, then the number and the code. */
export function blameItems(lines) {
  const authorW = authorWidth([...new Set(lines.filter((l) => !l.commit.uncommitted).map((l) => l.commit.author))]);
  const gutterW = 7 + 1 + authorW + 1 + 10 + 1;
  const numW = String(lines.at(-1)?.line ?? 1).length;
  const blank = { text: ' '.repeat(gutterW) };
  return lines.map((l) => {
    const c = l.commit;
    let gutter;
    if (!l.start) gutter = [blank];
    else if (c.uncommitted) gutter = [{ text: fit('Not committed yet', gutterW), color: theme.add }];
    else {
      gutter = [
        { text: short(c.hash), color: c.boundary ? theme.dim : theme.warn },
        { text: ` ${fit(c.author, authorW)} `, color: theme.hunk },
        { text: `${isoDate(c.time, c.tz)} `, color: theme.dim },
      ];
    }
    return { ...l, segments: [...gutter, { text: fit(String(l.line), numW, 'right'), color: theme.dim }, { text: ' │ ', color: theme.border }, { text: l.text }] };
  });
}

/** The commits that touched `path` (following renames), newest first. ↵ shows the commit's diff of the file; B blames it as of then. */
export function historyPicker(ctx, path) {
  return {
    title: `History of ${path}`,
    hint: '↵ diff · B blame as of then',
    empty: `No commits touched ${path}.`,
    load: async () => {
      const raw = await ctx.git(['log', '--follow', '-M', '--name-status', '-z', `-n${MAX_HISTORY}`, `--format=${HISTORY_FORMAT}`, '--', path]);
      const list = parseFileHistory(raw, path);
      const authorW = authorWidth(list.map((e) => e.author));
      const now = Date.now() / 1000;
      return list.map((e) => ({ ...e, segments: historySegments(e, path, authorW, now) }));
    },
    // Both names at a rename, so the diff shows it as one.
    onPick: (e) => ctx.showPatch(e, e.orig ? [e.orig, e.path] : [e.path]),
    keys: {
      y: (e) => ctx.copy(e.hash, `the hash of ${short(e.hash)}`),
      // A commit that deleted the file has nothing to blame; the one before it does.
      B: (e) => ctx.showPicker(blamePicker(ctx, e.path, { rev: e.status === 'D' ? `${e.hash}^` : e.hash })),
    },
  };
}

/**
 * Where lines `from` to `to` of a changed working-tree file were in the committed one, given
 * `git diff HEAD -- <file>`: { from, to } over the lines that are committed, or null if none are.
 */
export function committedRange(diffText, from, to) {
  const hunks = parseDiff(diffText).hunks.map((h) => {
    const count = (c) => h.lines.filter((l) => l[0] === c || l[0] === ' ').length;
    // A side with no lines in the hunk names the line before it.
    return { ...h, oldStart: h.oldStart + (count('-') ? 0 : 1), newStart: h.newStart + (count('+') ? 0 : 1) };
  });
  const committed = (n) => {
    let delta = 0;
    for (const h of hunks) {
      if (n < h.newStart) break;
      let o = h.oldStart;
      let w = h.newStart;
      for (const l of h.lines) {
        if (l[0] === ' ') {
          if (w === n) return o;
          o++;
          w++;
        } else if (l[0] === '-') o++;
        else if (l[0] === '+') {
          if (w === n) return null;
          w++;
        }
      }
      delta = o - w;
    }
    return n + delta;
  };
  const lines = [];
  for (let n = from; n <= to; n++) {
    const c = committed(n);
    if (c != null) lines.push(c);
  }
  return lines.length ? { from: Math.min(...lines), to: Math.max(...lines) } : null;
}

/**
 * What `git log -L` should look at for lines `from` to `to` of `path` (of `rev`, or else the working tree):
 * { range: { from, to }, rev } in the committed file, the range null when none of the lines is committed.
 */
export async function linesRange(ctx, path, from, to, rev) {
  // A file gone from the working tree was blamed as of HEAD (see blamePicker).
  if (!rev && !existsSync(join(ctx.data.root, path))) rev = 'HEAD';
  if (!rev && (await ctx.git(['diff', '--quiet', 'HEAD', '--', path]).then(() => false, () => true))) {
    // Changed since the last commit: git log -L counts lines in the committed file.
    return { range: committedRange(await ctx.git(['diff', '--no-color', '-U0', 'HEAD', '--', path]), from, to), rev };
  }
  return { range: { from, to }, rev };
}

/** `git log -L` for `range` of `path`, as of `rev` (else HEAD); `n` caps the commits. */
export const lineLogArgs = (path, range, rev, n) => ['log', '--no-color', '--date=short', ...(n ? [`-n${n}`] : []), `-L${range.from},${range.to}:${path}`, ...(rev ? [rev] : [])];

/**
 * L in blame: every commit that changed lines `from` to `to` of `path` (of `rev`, or else the working
 * tree), with what each did to them (`git log -L`), in the viewer.
 */
export async function lineHistory(ctx, path, from, to, rev) {
  const { range, rev: at } = await linesRange(ctx, path, from, to, rev);
  if (!range) return ctx.note(from === to ? `Line ${from} isn't committed yet.` : `Lines ${from}–${to} aren't committed yet.`);
  const what = range.from === range.to ? `Line ${range.from}` : `Lines ${range.from}–${range.to}`;
  ctx.showAsync(
    `${what} of ${path}${at ? ` at ${at.replace(/^[0-9a-f]{40,64}/, short)}` : ''}`,
    async () => (await ctx.git(lineLogArgs(path, range, at))) || `No commits changed ${what.toLowerCase()}.`,
    { diff: true },
  );
}

/**
 * Who last changed each line of `path`: the working-tree version (uncommitted lines show as such),
 * or as of `rev`, with the cursor on `line` when given. ↵ shows the diff of the line's commit to that file;
 * H opens the file's history.
 */
export function blamePicker(ctx, path, { rev = null, line = null } = {}) {
  // Every row, for the file around lines Claude explains.
  let all = [];
  return {
    title: `Blame ${path}${rev ? ` at ${rev.replace(/^[0-9a-f]{40,64}/, short)}` : ''}${line ? `, line ${line}` : ''}`,
    // The cursor starts on `line` (Picker.jsx's `index`), once the lines are in.
    index: line ? line - 1 : undefined,
    hint: '↵ diff · H history · v select · L lines’ history · e why · F open PRs changing it',
    range: true,
    // What /future reads, with the line under the cursor.
    blame: { path, rev },
    empty: `${path} is empty.`,
    load: async () => {
      // A file deleted from the working tree still has a blame in HEAD.
      const at = rev ?? (existsSync(join(ctx.data.root, path)) ? null : 'HEAD');
      const raw = await ctx.git(['blame', '--porcelain', ...(at ? [at] : []), '--', path]);
      all = blameItems(parseBlame(raw));
      return all;
    },
    onPick: (l) => {
      const c = l.commit;
      if (c.uncommitted) return ctx.note(`Line ${l.line} isn't committed yet.`);
      const before = c.previous?.path;
      return ctx.showPatch({ hash: c.hash, subject: c.summary }, before && before !== l.path ? [before, l.path] : [l.path]);
    },
    keys: {
      H: () => ctx.showPicker(historyPicker(ctx, path)),
      L: (l, lines) => lineHistory(ctx, path, lines[0].line, lines.at(-1).line, rev),
      e: (l, lines) => claudeBlame(ctx, path, lines, all, rev),
      F: (l) => future(ctx, { path, line: l.line, rev }),
      y: (l) => (l.commit.uncommitted ? ctx.note(`Line ${l.line} isn't committed yet.`) : ctx.copy(l.commit.hash, `the hash of ${short(l.commit.hash)}`)),
    },
  };
}
