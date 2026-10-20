import { existsSync, realpathSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { samePath } from './config.js';
import { git } from './git.js';
import {
  LOG_FORMAT,
  REF_FORMAT,
  STASH_FORMAT,
  groupChanges,
  parseGraph,
  parseNameStatus,
  parseRefs,
  parseStash,
  parseStatus,
  parseWorktrees,
} from './parse.js';

/** Resolves the repository that contains `path`. Throws if there isn't one. */
export async function findRepo(path) {
  if (!existsSync(path)) throw new Error(`${path} doesn't exist`);
  const out = await git(path, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  const [root, gitDir, commonDir] = out.trim().split('\n');
  if (!root || !gitDir) throw new Error(`${path} isn't inside a git working tree`);
  // The common dir (shared refs, config, stash) is gitDir itself unless this is a linked worktree.
  // Git may print it relative to `path`, and so in whatever form `path` came in (a Windows short
  // name like RUNNER~1, say), so it's made canonical: the same repo always gets the same one.
  return { root: resolve(root), gitDir: resolve(gitDir), commonDir: canonical(resolve(path, commonDir || gitDir)), name: basename(resolve(root)) };
}

function canonical(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Which multi-step operation is in progress, if any. */
export function repoState(gitDir) {
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return 'rebasing';
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merging';
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-picking';
  if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'reverting';
  return null;
}

// Every git process costs real time (around 100 ms to start on Windows), so a load asks for as
// little as it can: one ref listing serves both the views and the signature, and what rarely
// changes is reused until the file git keeps it in changes.

// The refs the views show; refs/stash is here so that stashing counts as a change.
const REF_PATTERNS = ['refs/heads', 'refs/remotes', 'refs/tags', 'refs/stash'];
const SIG_FORMAT = '%(objectname) %(refname)';

/** The SIG_FORMAT listing that a REF_FORMAT listing of the same refs stands for. */
function refsSignature(raw) {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, oid] = line.split('\x1f');
      return `${oid} ${ref}\n`;
    })
    .join('');
}

// No worktrees folder means no linked worktrees, and nothing to ask git.
const hasLinkedWorktrees = (repo) => existsSync(join(repo.commonDir, 'worktrees'));

/** Status, refs (in `refFormat`) and linked worktrees, with the signature polling compares. */
async function readState(repo, refFormat, toSignature) {
  const [status, refs, worktrees] = await Promise.all([
    git(repo.root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    git(repo.root, ['for-each-ref', `--format=${refFormat}`, ...REF_PATTERNS]),
    // -z needs git 2.36; older ones just show no worktrees.
    hasLinkedWorktrees(repo) ? git(repo.root, ['worktree', 'list', '--porcelain', '-z']).catch(() => '') : '',
  ]);
  const state = repoState(repo.gitDir);
  return { status, refs, worktrees, state, signature: `${state}\n${status}\n${toSignature(refs)}\n${worktrees}` };
}

/** The cheap read polling runs: a different `signature` from the loaded one means something changed outside. */
export function snapshot(repo) {
  return readState(repo, SIG_FORMAT, (refs) => refs);
}

const reused = new Map();

/** `load()`'s last value for `key` while `stamp` is unchanged. A null stamp always loads. */
async function reuse(key, stamp, load) {
  const hit = reused.get(key);
  if (stamp != null && hit?.stamp === stamp) return hit.value;
  const value = await load();
  reused.set(key, { stamp, value });
  return value;
}

async function fileStamp(file) {
  try {
    const s = await stat(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

async function readRemotes(repo) {
  const stamp = await fileStamp(join(repo.commonDir, 'config'));
  return reuse(`remotes:${repo.commonDir}`, stamp, async () => parseRemotes(await git(repo.root, ['remote', '-v']).catch(() => '')));
}

/** The stash list. No refs/stash means no stashes; otherwise it's read again when the stash's reflog changes. */
async function readStashes(repo, refs) {
  const top = refs.split('\n').find((l) => l.startsWith('refs/stash\x1f'));
  if (!top) return [];
  const log = await fileStamp(join(repo.commonDir, 'logs', 'refs', 'stash'));
  const stamp = log && `${top.split('\x1f')[1]}:${log}`;
  return reuse(`stash:${repo.commonDir}`, stamp, async () =>
    parseStash(await git(repo.root, ['stash', 'list', `--format=${STASH_FORMAT}`]).catch(() => '')),
  );
}

/** Loads everything the views show. */
export async function loadRepo(repo, { graphLimit = 400 } = {}) {
  const [snap, log, remotes] = await Promise.all([
    readState(repo, REF_FORMAT, refsSignature),
    // An empty repository has nothing to log, which git reports as an error.
    git(repo.root, [
      'log', '--graph', '--date-order', '--decorate=full', `-n${graphLimit}`,
      `--format=${LOG_FORMAT}`, '--exclude=refs/stash', '--all',
    ]).catch(() => ''),
    readRemotes(repo),
  ]);
  const status = parseStatus(snap.status);
  const graph = parseGraph(log);
  // Without linked worktrees, the main one is the open one, and status already says what it has out.
  const worktrees = snap.worktrees
    ? parseWorktrees(snap.worktrees).map((w) => ({ ...w, path: resolve(w.path), current: samePath(w.path, repo.root) }))
    : [{ path: repo.root, head: status.branch.oid, branch: status.branch.head, main: true, bare: false, locked: false, prunable: false, reason: '', current: true }];
  return {
    ...repo,
    signature: snap.signature,
    state: snap.state,
    status,
    changes: groupChanges(status.files),
    graph,
    graphLimit,
    graphComplete: graph.filter((r) => r.commit).length < graphLimit,
    refs: parseRefs(snap.refs),
    stashes: await readStashes(repo, snap.refs),
    worktrees,
    ...remotes,
  };
}

/** `git remote -v` → the remote names, and each one's fetch URL. */
export function parseRemotes(raw) {
  const remoteUrls = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\S+)\t(\S+) \(fetch\)/);
    if (m) remoteUrls[m[1]] = m[2];
  }
  return { remotes: Object.keys(remoteUrls), remoteUrls };
}

/** Full message, author and changed files of one commit. */
export async function commitDetail(root, hash) {
  // One git: the header ends at \x1e, and the file list follows it.
  const out = await git(root, ['show', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%P%x1f%B%x1e', '--name-status', '-M', '--diff-merges=first-parent', hash]);
  const end = out.indexOf('\x1e');
  const files = out.slice(end + 1);
  const [full, author, email, time, committer, parents, body] = out.slice(0, end).split('\x1f');
  return {
    hash: full,
    author,
    email,
    time: Number(time),
    committer,
    parents: parents ? parents.split(' ') : [],
    message: (body ?? '').trimEnd(),
    files: parseNameStatus(files),
  };
}

/** The patch a commit introduces (first parent for merges), with its header; only to `paths`, if given. */
export function commitPatch(root, hash, paths = []) {
  return git(root, ['show', '--stat', '--patch', '-M', '--diff-merges=first-parent', '--format=fuller', hash, ...(paths.length ? ['--', ...paths] : [])]);
}

const MAX_PREVIEW = 512 * 1024;

/** The diff for one entry of the Changes view. Untracked files are shown as all-added. */
export async function changeDiff(root, entry) {
  if (entry.kind === 'untracked') {
    const file = join(root, entry.path);
    const info = await stat(file);
    if (info.isDirectory()) return `${entry.path}/ (directory)\n${(await readdir(file)).join('\n')}`;
    if (info.size > MAX_PREVIEW) return `${entry.path}: new file, ${Math.round(info.size / 1024)} KB (too large to preview)`;
    const buf = await readFile(file);
    if (buf.includes(0)) return `${entry.path}: new binary file`;
    const lines = buf.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    // Shaped like git's own diff of a new file, so hunks and lines can be picked from it the same way.
    return [
      `diff --git a/${entry.path} b/${entry.path}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${entry.path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`),
    ].join('\n');
  }
  if (entry.area === 'conflict') return git(root, ['diff', '--', entry.path]);
  const args = entry.area === 'staged' ? ['diff', '--cached', '-M'] : ['diff'];
  return git(root, [...args, '--', ...(entry.orig ? [entry.orig] : []), entry.path]);
}

/** Recent commits on one ref, for the Branches view. */
export async function refLog(root, ref, n = 60) {
  const out = await git(root, ['log', `-n${n}`, '--format=%h%x1f%an%x1f%at%x1f%s', ref, '--']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, author, time, subject] = l.split('\x1f');
      return { hash, author, time: Number(time), subject };
    });
}

/** Status and recent commits of one worktree, for the Worktrees view. */
export async function worktreeDetail(path, n = 40) {
  const [status, log] = await Promise.all([
    git(path, ['status', '--short', '--branch', '--untracked-files=all']),
    git(path, ['log', `-n${n}`, '--format=%h%x1f%at%x1f%s']).catch(() => ''),
  ]);
  return {
    status: status.split('\n').filter(Boolean),
    commits: log
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, time, subject] = l.split('\x1f');
        return { hash, time: Number(time), subject };
      }),
  };
}

/** Files in a stash, untracked ones included. */
export function stashStat(root, ref) {
  return git(root, ['stash', 'show', '--stat', '--include-untracked', ref]).catch(() =>
    git(root, ['stash', 'show', '--stat', ref]),
  );
}

export function stashPatch(root, ref) {
  return git(root, ['stash', 'show', '--patch', '--include-untracked', ref]).catch(() =>
    git(root, ['stash', 'show', '--patch', ref]),
  );
}
