// Git LFS: telling whether a repository uses it, and reading what `git lfs` says. Pure; the gits run in
// repo.js (ls-files, only for a repository that uses LFS) and actions.js.

/** Whether a .gitattributes text sends any files through LFS (`filter=lfs` on a line that isn't a comment). */
export function usesLfs(attributes) {
  return String(attributes ?? '')
    .split('\n')
    .some((line) => !/^\s*#/.test(line) && /(^|\s)filter=lfs(\s|$)/.test(line));
}

/** What git says when git-lfs isn't installed (`git lfs` isn't a command it knows). */
export function lfsMissing(message) {
  return /'lfs' is not a git command|git-lfs: (command )?not found|unknown (sub)?command.*lfs/i.test(String(message ?? ''));
}

/** git lfs's error as one message: its `hint:` lines left out, and a clear word when LFS isn't installed. */
export function lfsError(message) {
  if (lfsMissing(message)) return LFS_MISSING;
  return withoutHints(message) || 'git lfs failed.';
}

/** git lfs's output without its `hint:` lines (about file:// remotes, say) and the blank lines around them. */
export function withoutHints(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l && !/^hint:/.test(l))
    .join('\n');
}

export const LFS_MISSING = "Git LFS isn't installed, so Splice can't ask it anything. Install it (https://git-lfs.com, or your package manager's git-lfs), then run git lfs install once.";

/**
 * `git lfs ls-files` → { path: { oid, content } }: the files LFS keeps, each with its short object id and
 * whether the working tree has its content (`*`) or only the pointer git stores in its place (`-`).
 */
export function parseLfsFiles(raw) {
  const out = {};
  for (const line of String(raw ?? '').split('\n')) {
    const m = /^([0-9a-f]+) ([*-]) (.+)$/.exec(line.replace(/\r$/, ''));
    if (m) out[m[3]] = { oid: m[1], content: m[2] === '*' };
  }
  return out;
}

/** Whether a file's first bytes are an LFS pointer (the small text file git stores in place of the content). */
export function isPointer(head) {
  return String(head ?? '').startsWith('version https://git-lfs.github.com/spec/v1\n');
}

/** How many files LFS keeps, and how many of them are only pointers here: { total, pointers, paths } (the pointers' paths). */
export function lfsSummary(files) {
  const entries = Object.entries(files ?? {});
  const pointers = entries.filter(([, f]) => !f.content).map(([p]) => p);
  return { total: entries.length, pointers: pointers.length, paths: pointers };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The text /lfs shows: the summary, the files that are only pointers, then `git lfs status`. */
export function lfsText(files, status) {
  const { total, pointers, paths } = lfsSummary(files);
  const lines = [];
  if (!total) lines.push('No files are in LFS in this commit yet.');
  else {
    lines.push(`${plural(total, 'file')} in LFS: ${total - pointers} downloaded${pointers ? `, ${pointers} only a pointer (/lfs pull downloads ${pointers === 1 ? 'it' : 'them'})` : ''}.`);
    if (pointers) lines.push('', 'Only a pointer here:', ...paths.map((p) => `  ${p}`));
  }
  const s = String(status ?? '').trimEnd();
  if (s) lines.push('', 'git lfs status', '', s);
  return lines.join('\n');
}

const lockOf = (l, mine) => ({
  id: String(l.id ?? ''),
  path: l.path ?? '',
  owner: l.owner?.name ?? '',
  lockedAt: l.locked_at ?? '',
  ...(mine == null ? {} : { mine }),
});

/**
 * `git lfs locks --json` (a list) or `--verify --json` ({ ours, theirs }) → [{ id, path, owner, lockedAt,
 * mine? }], sorted by path. `mine` is only known from --verify.
 */
export function parseLfsLocks(raw) {
  // Only the JSON line: git lfs may print hints around it.
  const text = String(raw ?? '').split('\n').find((l) => /^\s*[[{]/.test(l))?.trim();
  if (!text) return [];
  const json = JSON.parse(text);
  const list = Array.isArray(json)
    ? json.map((l) => lockOf(l))
    : [...(json.ours ?? []).map((l) => lockOf(l, true)), ...(json.theirs ?? []).map((l) => lockOf(l, false))];
  return list.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * `/lfs [status | pull | fetch | locks | lock <path> | unlock <path> [--force]]` → { action, path?, force?, args? },
 * or { error }. pull and fetch pass what follows on to git lfs (a remote, --all).
 */
export function lfsCommand(text) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const [action = 'status', ...rest] = words;
  if (action === 'status' || action === 'files') return rest.length ? { error: `Use: /lfs ${action}` } : { action: 'status' };
  if (action === 'pull' || action === 'fetch') return { action, args: rest };
  if (action === 'locks') return rest.length ? { error: 'Use: /lfs locks' } : { action };
  if (action === 'lock' || action === 'unlock') {
    const force = rest.includes('--force') || rest.includes('-f');
    const path = rest.filter((w) => w !== '--force' && w !== '-f').join(' ').replace(/\\/g, '/');
    if (!path) return { error: `Use: /lfs ${action} <path>${action === 'unlock' ? ' [--force]' : ''}` };
    if (force && action === 'lock') return { error: 'Only unlocking takes --force.' };
    return { action, path, ...(action === 'unlock' ? { force } : {}) };
  }
  return { error: `/lfs doesn't know "${action}". Use: /lfs, /lfs pull, /lfs fetch, /lfs locks, /lfs lock <path>, /lfs unlock <path> [--force]` };
}
