import { existsSync, realpathSync, statSync } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { samePath } from './config.js';
import { git } from './git.js';
import { layoutGraph } from './graph.js';
import { theme } from './theme.js';
import { isPointer, lfsMissing, parseLfsFiles, usesLfs } from './lfs.js';
import {
  COMMIT_FORMAT,
  DECORATE_REFS,
  LOG_FORMAT,
  REF_FORMAT,
  STASH_FORMAT,
  defaultBranch,
  groupChanges,
  parseAheadBehind,
  parseCommits,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStash,
  parseStashFiles,
  parseStatus,
  parseSubmodules,
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

/** `p` as the file system names it: symbolic links followed and, on Windows, short names like RUNNER~1 made long. */
export function canonical(p) {
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
  if (existsSync(join(gitDir, 'BISECT_LOG'))) return 'bisecting';
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

/** Whether a listing's line (its refname first, up to \x1f) is one of REF_PATTERNS's refs, as for-each-ref matches them. */
const shownRef = (line) => {
  const ref = line.slice(0, line.indexOf('\x1f'));
  return REF_PATTERNS.some((p) => ref === p || ref.startsWith(`${p}/`));
};

/**
 * Status, refs (in `refFormat`) and linked worktrees, with the signature polling compares. With `allRefs`
 * (a REF_FORMAT listing) every ref is listed, in `allRefs` of the result, and `refs` keeps REF_PATTERNS's:
 * what `git log --all` shows depends on all of them, and it's still one git.
 */
async function readState(repo, refFormat, toSignature, { allRefs = false, listRefs = null } = {}) {
  const [status, listed, worktrees] = await Promise.all([
    git(repo.root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    listRefs ? listRefs() : git(repo.root, ['for-each-ref', `--format=${refFormat}`, ...(allRefs ? [] : REF_PATTERNS)]),
    // -z needs git 2.36; older ones just show no worktrees.
    hasLinkedWorktrees(repo) ? git(repo.root, ['worktree', 'list', '--porcelain', '-z']).catch(() => '') : '',
  ]);
  const refs = allRefs ? listed.split('\n').filter((l) => l && shownRef(l)).map((l) => `${l}\n`).join('') : listed;
  const state = repoState(repo.gitDir);
  return { status, refs, allRefs: allRefs ? listed : null, worktrees, state, signature: `${state}\n${status}\n${toSignature(refs)}\n${worktrees}` };
}

// Polling's ref listing, by common dir, kept while the files git keeps the refs in are as they were (see
// refFilesStamp), and listed again at least every RELIST_MS whatever they say.
const polledRefs = new Map();
const RELIST_MS = 30_000;

/**
 * When packed-refs and each folder under refs/ were last changed: git writes a ref by renaming a lock file
 * over it, which changes its folder, so a ref written, added or removed changes this. Null for the reftable
 * backend, whose refs aren't files.
 */
export async function refFilesStamp(commonDir) {
  if (existsSync(join(commonDir, 'reftable'))) return null;
  const parts = [`packed-refs ${await fileStamp(join(commonDir, 'packed-refs'))}`];
  const walk = async (dir) => {
    let entries;
    try {
      // The folder's time before its entries: a change in between makes the next stamp differ.
      parts.push(`${dir} ${(await stat(dir)).mtimeMs}`);
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => walk(join(dir, e.name))));
  };
  await walk(join(commonDir, 'refs'));
  return parts.sort().join('\n');
}

/**
 * The cheap read polling runs: a different `signature` from the loaded one means something changed outside.
 * The status is read every time; the refs only when the files they're kept in changed (or a while has passed).
 */
export function snapshot(repo) {
  const stamp = refFilesStamp(repo.commonDir);
  const listRefs = async () => {
    const now = Date.now();
    const before = await stamp;
    const kept = polledRefs.get(repo.commonDir);
    if (before && kept?.stamp === before && now - kept.at < RELIST_MS) return kept.refs;
    const refs = await git(repo.root, ['for-each-ref', `--format=${SIG_FORMAT}`, ...REF_PATTERNS]);
    polledRefs.delete(repo.commonDir);
    polledRefs.set(repo.commonDir, { stamp: before, refs, at: now });
    if (polledRefs.size > 4) polledRefs.delete(polledRefs.keys().next().value);
    return refs;
  };
  return readState(repo, SIG_FORMAT, (refs) => refs, { listRefs });
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

// `git lfs ls-files` starts a dozen gits of its own, so its answer is kept with what it depends on: HEAD's
// commit, the index (what it lists), and the size of each file it listed (how it tells content from a
// pointer). Only answers, not failures, are kept: installing git lfs is noticed at the next load.
const lfsLists = new Map();

async function lfsStamp(repo, snap, files) {
  const head = snap.status.split('\0').find((p) => p.startsWith('# branch.oid ')) ?? '';
  const sizes = await Promise.all(
    Object.keys(files).map((p) => stat(join(repo.root, p)).then((s) => `${s.size}:${s.mtimeMs}`, () => '-')),
  );
  return [head, await fileStamp(join(repo.gitDir, 'index')), ...sizes].join('\n');
}

/**
 * Git LFS, for a repository that uses it (a .gitattributes line with filter=lfs, or LFS's folder in .git), else
 * null, at the cost of reading one file: { installed, files } with ls-files's files, each pointer or content.
 * Not part of the signature: pulling turns pointers into content without git status seeing a change, and
 * everything that does that reloads afterwards. `state` is the load's readState, which the kept answer is
 * checked against; the first load in a repository asks ls-files alongside it.
 */
async function readLfs(repo, state) {
  const attributes = await readFile(join(repo.root, '.gitattributes'), 'utf8').catch(() => '');
  if (!usesLfs(attributes) && !existsSync(join(repo.commonDir, 'lfs'))) return null;
  const kept = lfsLists.get(repo.root);
  const stamp = kept ? await lfsStamp(repo, await state, kept.value.files) : null;
  if (kept && kept.stamp === stamp) return kept.value;
  try {
    const value = { installed: true, files: parseLfsFiles(await git(repo.root, ['lfs', 'ls-files'])) };
    lfsLists.delete(repo.root);
    lfsLists.set(repo.root, { stamp, value });
    if (lfsLists.size > 4) lfsLists.delete(lfsLists.keys().next().value);
    return value;
  } catch (e) {
    // Before the first commit there's nothing to list.
    return { installed: !lfsMissing(e.message), files: {} };
  }
}

/**
 * ls-files's `files` with `paths` (changed files, which it marks as pointers whatever they hold) looked at
 * on disk: content unless the file's first bytes are a pointer. A missing file is left as it was.
 */
export async function checkPointers(root, files, paths) {
  const out = { ...files };
  await Promise.all(
    paths
      .filter((p) => out[p])
      .map(async (p) => {
        let fh;
        try {
          fh = await open(join(root, p), 'r');
          const { buffer, bytesRead } = await fh.read({ buffer: Buffer.alloc(64), position: 0 });
          out[p] = { ...out[p], content: !isPointer(buffer.subarray(0, bytesRead).toString('latin1')) };
        } catch {
          // Deleted, or not readable: as ls-files said.
        } finally {
          await fh?.close();
        }
      }),
  );
  return out;
}

// The graph's log, by worktree: `git log --all` is the slowest git a load runs (it walks the history to
// order it), and most loads (staging, an editor saving) change nothing it shows. What it shows depends on
// every ref, HEAD (each worktree's), the shallow boundary and how many commits are asked for: its `stamp`.
const logs = new Map();

const logStamp = (repo, snap, graphLimit) =>
  [
    graphLimit,
    snap.allRefs,
    // HEAD: its commit and branch, from the status's header lines.
    snap.status.split('\0').filter((p) => p.startsWith('# branch.oid ') || p.startsWith('# branch.head ')).join('\n'),
    snap.worktrees,
    shallowStamp(repo),
  ].join('\0');

function shallowStamp(repo) {
  try {
    const s = statSync(join(repo.commonDir, 'shallow'));
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '';
  }
}

// A few repositories' worth: opening one after another from Repos shouldn't keep every graph.
function keepLog(repo, entry) {
  logs.delete(repo.root);
  logs.set(repo.root, entry);
  if (logs.size > 4) logs.delete(logs.keys().next().value);
  return entry;
}

function readLog(repo, graphLimit) {
  // An empty repository has nothing to log, which git reports as an error.
  return git(repo.root, [
    'log', '--date-order', '--decorate=full', ...DECORATE_REFS, `-n${graphLimit}`,
    `--format=${LOG_FORMAT}`, '--exclude=refs/stash', '--all',
  ]).catch(() => '');
}

/**
 * The state and the log. Once a log has been read for this worktree and limit, the state is read first
 * and the log only when its stamp changed; otherwise both at once, and nothing kept, since a ref that
 * moved while they ran could leave the log older than the stamp. Read in turn, the log is never older.
 */
async function readStateAndLog(repo, graphLimit, state) {
  const kept = logs.get(repo.root);
  if (kept?.limit !== graphLimit) {
    const [snap, log] = await Promise.all([state, readLog(repo, graphLimit)]);
    keepLog(repo, { limit: graphLimit, stamp: null, log });
    return { snap, log, kept: null };
  }
  const snap = await state;
  const stamp = logStamp(repo, snap, graphLimit);
  if (kept.stamp === stamp) return { snap, log: kept.log, kept };
  const log = await readLog(repo, graphLimit);
  const entry = keepLog(repo, { limit: graphLimit, stamp, log });
  return { snap, log, kept: entry };
}

// `git submodule status` starts a few gits, and two `git describe`s in each submodule, so its answer is kept
// with what it depends on: .gitmodules, HEAD's commit and the index (the commits recorded), the status's
// lines about submodules, and in each submodule whether it's checked out, its HEAD and its refs (the commit
// it has out and what describes it).
const subLists = new Map();

/** A submodule's git folder: its .git, or the folder a .git file names. Null when it isn't checked out. */
async function subGitDir(path) {
  try {
    if ((await stat(join(path, '.git'))).isDirectory()) return join(path, '.git');
    const m = /^gitdir: (.+)$/m.exec(await readFile(join(path, '.git'), 'utf8'));
    return m ? resolve(path, m[1].trim()) : null;
  } catch {
    return null;
  }
}

async function subStamp(repo, path) {
  const dir = await subGitDir(join(repo.root, path));
  if (!dir) return `${path}\t-`;
  const head = (await readFile(join(dir, 'HEAD'), 'utf8').catch(() => '')).trim();
  const ref = /^ref: (.+)$/.exec(head)?.[1];
  const refs = await Promise.all([ref ? fileStamp(join(dir, ref)) : '', fileStamp(join(dir, 'packed-refs')), fileStamp(join(dir, 'refs', 'tags'))]);
  return `${path}\t${head}\t${refs.join('\t')}`;
}

async function readSubmodules(repo, state) {
  const kept = subLists.get(repo.root);
  let stamp = null;
  if (kept) {
    const snap = await state;
    const lines = snap.status.split('\0').filter((p) => p.startsWith('# branch.oid ') || /^[12u] \S+ S/.test(p));
    const [modules, index, ...subs] = await Promise.all([
      fileStamp(join(repo.root, '.gitmodules')),
      fileStamp(join(repo.gitDir, 'index')),
      ...parseSubmodules(kept.raw).map((sub) => subStamp(repo, sub.path)),
    ]);
    stamp = [modules, index, ...lines, ...subs].join('\n');
    if (kept.stamp === stamp) return kept.raw;
  }
  let raw;
  try {
    raw = await git(repo.root, ['submodule', 'status']);
  } catch {
    return '';
  }
  subLists.delete(repo.root);
  subLists.set(repo.root, { stamp, raw });
  if (subLists.size > 4) subLists.delete(subLists.keys().next().value);
  return raw;
}

/** Loads everything the views show. */
export async function loadRepo(repo, { graphLimit = 400 } = {}) {
  const state = readState(repo, REF_FORMAT, refsSignature, { allRefs: true });
  const [{ snap, log, kept }, remotes, subs, lfs] = await Promise.all([
    readStateAndLog(repo, graphLimit, state),
    readRemotes(repo),
    // Only a repository with submodules pays for asking about them. Not part of the signature: what
    // polling needs to notice (a submodule's commit or changes) is in the status already.
    existsSync(join(repo.root, '.gitmodules')) ? readSubmodules(repo, state) : '',
    readLfs(repo, state),
  ]);
  const status = parseStatus(snap.status);
  const refs = parseRefs(snap.refs);
  const wip = status.files.length ? status.branch.oid : null;
  const main = defaultBranch(refs, remotes.remotes)?.name;
  // The same log laid out the same way, in the same colours, is the same graph: kept with the log.
  const colours = `${theme.lanes.join()} ${theme.accent}`;
  const graph =
    kept?.graph && kept.wip === wip && kept.main === main && kept.colours === colours
      ? kept.graph
      : layoutGraph(parseLog(log), { wip, main });
  if (kept) Object.assign(kept, { graph, wip, main, colours });
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
    graph: graph.rows,
    // The working-tree row's cells, in HEAD's column; null when there are no changes or HEAD isn't loaded.
    graphWip: graph.wip,
    graphLimit,
    graphComplete: graph.rows.filter((r) => r.commit).length < graphLimit,
    refs,
    stashes: await readStashes(repo, snap.refs),
    worktrees,
    submodules: parseSubmodules(subs, status.files),
    lfs: lfs && { ...lfs, files: await checkPointers(repo.root, lfs.files, status.files.map((f) => f.path)) },
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
  // %G? and %GS: whether it's signed, and by whom (checking a signature never asks for a passphrase).
  const out = await git(root, ['show', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%P%x1f%G?%x1f%GS%x1f%B%x1e', '--name-status', '-M', '--diff-merges=first-parent', hash]);
  const end = out.indexOf('\x1e');
  const files = out.slice(end + 1);
  const [full, author, email, time, committer, parents, signature, signer, ...body] = out.slice(0, end).split('\x1f');
  return {
    hash: full,
    author,
    email,
    time: Number(time),
    committer,
    parents: parents ? parents.split(' ') : [],
    signature: signature || 'N',
    signer: signer ?? '',
    message: body.join('\x1f').trimEnd(),
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

/**
 * How `ref` compares with `base` (the default branch), for the Branches view: how far it is ahead and
 * behind, the commits it has that `base` doesn't (up to `n`), and its other recent commits. Three gits,
 * run side by side.
 */
export async function compareRefs(root, ref, base, n = 60) {
  const range = `${base}...${ref}`;
  const [counts, mine, log] = await Promise.all([
    git(root, ['rev-list', '--left-right', '--count', range, '--']),
    git(root, ['log', `-n${n}`, `--format=${COMMIT_FORMAT}`, `${base}..${ref}`, '--']),
    git(root, ['log', `-n${n}`, `--format=${COMMIT_FORMAT}`, ref, '--']),
  ]);
  const ahead = parseCommits(mine);
  const own = new Set(ahead.map((c) => c.full));
  return { ...parseAheadBehind(counts), commits: ahead, history: parseCommits(log).filter((c) => !own.has(c.full)) };
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

/** Each file in a stash with its change (M, A, D), then the untracked files it took, from its third parent. */
export async function stashFiles(root, ref) {
  const [tracked, untracked] = await Promise.all([
    git(root, ['diff', '--name-status', '-z', '--no-renames', `${ref}^1`, ref]),
    // Only a stash made with --include-untracked (as Splice's are) has a third parent.
    git(root, ['ls-tree', '-r', '-z', '--name-only', `${ref}^3`]).catch(() => ''),
  ]);
  return parseStashFiles(tracked, untracked);
}

/** One file's diff in a stash: against the commit it was made on, or all added for an untracked one. */
export function stashFileDiff(root, ref, file) {
  if (file.untracked) return git(root, ['show', '--format=', `${ref}^3`, '--', file.path]);
  return git(root, ['diff', `${ref}^1`, ref, '--', file.path]);
}
