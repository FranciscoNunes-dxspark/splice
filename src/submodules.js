// The submodules list (/submodules): what each one records against what it has checked out, its branch and
// its own changes. Pure: the gits that feed these run in actions.js, only when the list opens.

/**
 * `git ls-files --stage -- <paths>` → { path: sha } for the gitlinks (mode 160000): the commit this repository
 * records for each submodule (in the index, as `git submodule status` compares with). A conflicted one has a
 * line per stage; the last one read wins, which is only shown as a hint.
 */
export function parseGitlinks(raw) {
  const out = {};
  for (const line of raw.split('\n')) {
    const m = /^160000 ([0-9a-f]{40,64}) \d\t(.+)$/.exec(line);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

/**
 * `git status --porcelain=v2 --branch -z` run inside a submodule → { branch, oid, changes, untracked }: its
 * branch (null when detached, as a submodule usually is), the commit it has out, and how many files it has
 * changed and not tracked.
 */
export function parseInside(raw) {
  const info = { branch: null, oid: null, changes: 0, untracked: 0 };
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('# branch.head ')) {
      const v = p.slice('# branch.head '.length);
      info.branch = v === '(detached)' ? null : v;
    } else if (p.startsWith('# branch.oid ')) {
      const v = p.slice('# branch.oid '.length);
      info.oid = v === '(initial)' ? null : v;
    } else if (p[0] === '?') info.untracked++;
    else if (p[0] === '1' || p[0] === 'u') info.changes++;
    else if (p[0] === '2') {
      info.changes++;
      // A rename's original path is the next field.
      i++;
    }
  }
  return info;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One row of the list from parseSubmodules's entry, its recorded commit and what parseInside read in it
 * (null when it isn't checked out): { path, state, recorded, current, branch, changes, untracked, summary }.
 */
export function submoduleInfo(sub, recorded, inside) {
  const checkedOut = sub.state === 'uninitialised' ? null : (inside?.oid ?? (sub.state === 'conflict' ? null : sub.sha));
  return {
    ...sub,
    recorded: recorded ?? (sub.state === 'out of date' || sub.state === 'conflict' ? null : sub.sha),
    current: checkedOut,
    branch: inside?.branch ?? null,
    changes: inside?.changes ?? 0,
    untracked: inside?.untracked ?? 0,
  };
}

/** What a row says about the submodule's own work: "2 changed files, 1 untracked", or ''. */
export function insideSummary(info) {
  const parts = [];
  if (info.changes) parts.push(plural(info.changes, 'changed file'));
  if (info.untracked) parts.push(`${info.untracked} untracked`);
  return parts.join(', ');
}

/** "recorded abc1234 · has def5678": the two commits when they differ, else the one. */
export function commitsLine(info) {
  const s = (h) => (h ? h.slice(0, 7) : '?');
  if (!info.current) return `recorded ${s(info.recorded)}`;
  if (info.recorded && info.recorded !== info.current) return `recorded ${s(info.recorded)} · has ${s(info.current)}`;
  return `at ${s(info.current)}`;
}
