import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
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
} from './parse.js';

/** Resolves the repository that contains `path`. Throws if there isn't one. */
export async function findRepo(path) {
  if (!existsSync(path)) throw new Error(`${path} doesn't exist`);
  const out = await git(path, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
  const [root, gitDir] = out.trim().split('\n');
  if (!root || !gitDir) throw new Error(`${path} isn't inside a git working tree`);
  return { root: resolve(root), gitDir: resolve(gitDir), name: basename(resolve(root)) };
}

/** Which multi-step operation is in progress, if any. */
export function repoState(gitDir) {
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return 'rebasing';
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merging';
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-picking';
  if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'reverting';
  return null;
}

/** The cheap part of a load: status plus every ref's hash. Polling compares `signature` to spot outside changes. */
export async function snapshot(repo) {
  const [status, refs] = await Promise.all([
    git(repo.root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    git(repo.root, ['for-each-ref', '--format=%(objectname) %(refname)']),
  ]);
  const state = repoState(repo.gitDir);
  return { status, state, signature: `${state}\n${status}\n${refs}` };
}

/** Loads everything the views show. */
export async function loadRepo(repo, { graphLimit = 400 } = {}) {
  const [snap, log, refs, stash, remotes] = await Promise.all([
    snapshot(repo),
    // An empty repository has nothing to log, which git reports as an error.
    git(repo.root, [
      'log', '--graph', '--date-order', '--decorate=full', `-n${graphLimit}`,
      `--format=${LOG_FORMAT}`, '--exclude=refs/stash', '--all',
    ]).catch(() => ''),
    git(repo.root, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
    git(repo.root, ['stash', 'list', `--format=${STASH_FORMAT}`]).catch(() => ''),
    git(repo.root, ['remote', '-v']).catch(() => ''),
  ]);
  const status = parseStatus(snap.status);
  const graph = parseGraph(log);
  return {
    ...repo,
    signature: snap.signature,
    state: snap.state,
    status,
    changes: groupChanges(status.files),
    graph,
    graphLimit,
    graphComplete: graph.filter((r) => r.commit).length < graphLimit,
    refs: parseRefs(refs),
    stashes: parseStash(stash),
    ...parseRemotes(remotes),
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
  const [meta, files] = await Promise.all([
    git(root, ['show', '-s', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%P%x1f%B', hash]),
    git(root, ['show', '--format=', '--name-status', '-M', '--diff-merges=first-parent', hash]),
  ]);
  const [full, author, email, time, committer, parents, body] = meta.split('\x1f');
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

/** The patch a commit introduces (first parent for merges), with its header. */
export function commitPatch(root, hash) {
  return git(root, ['show', '--stat', '--patch', '-M', '--diff-merges=first-parent', '--format=fuller', hash]);
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
