// A file's history and blame, as pickers (ctx.showPicker): each one opens the other, and ↵ shows a commit's diff.
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { HISTORY_FORMAT, isoDate, parseBlame, parseFileHistory, relTime } from './parse.js';
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
 * Who last changed each line of `path`: the working-tree version (uncommitted lines show as such),
 * or as of `rev`. ↵ shows the diff of the line's commit to that file; H opens the file's history.
 */
export function blamePicker(ctx, path, { rev = null } = {}) {
  return {
    title: `Blame ${path}${rev ? ` at ${rev.replace(/^[0-9a-f]{40,64}/, short)}` : ''}`,
    hint: '↵ commit diff · H history',
    empty: `${path} is empty.`,
    load: async () => {
      // A file deleted from the working tree still has a blame in HEAD.
      const at = rev ?? (existsSync(join(ctx.data.root, path)) ? null : 'HEAD');
      const raw = await ctx.git(['blame', '--porcelain', ...(at ? [at] : []), '--', path]);
      return blameItems(parseBlame(raw));
    },
    onPick: (l) => {
      const c = l.commit;
      if (c.uncommitted) return ctx.note(`Line ${l.line} isn't committed yet.`);
      const before = c.previous?.path;
      return ctx.showPatch({ hash: c.hash, subject: c.summary }, before && before !== l.path ? [before, l.path] : [l.path]);
    },
    keys: {
      H: () => ctx.showPicker(historyPicker(ctx, path)),
      y: (l) => (l.commit.uncommitted ? ctx.note(`Line ${l.line} isn't committed yet.`) : ctx.copy(l.commit.hash, `the hash of ${short(l.commit.hash)}`)),
    },
  };
}
