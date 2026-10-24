// /cleanup: local branches and linked worktrees with nothing of yours on them, and branches on the PR
// host's remote whose pull request was merged. `readCleanup` asks git for the facts in a handful of
// processes; `planCleanup` (pure) decides what can go and why.
import { basename, dirname, relative, resolve } from 'node:path';
import { samePath } from './config.js';
import { git } from './git.js';
import { prSource } from './hosting.js';
import { REF_FORMAT, parseRefs, parseWorktrees } from './parse.js';

const lines = (s) => s.split('\n').filter(Boolean);

/** The pull request number of a branch /review-pr made (pr-<n>), else null. */
export const reviewBranchId = (name) => {
  const m = /^pr-(\d+)$/.exec(name ?? '');
  return m ? Number(m[1]) : null;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Whether worktree `w` is one /run-at made beside the main working tree `main` (prflow.js's runAtPath):
 * named <repo>-at-<short hash>, with HEAD detached at that commit. The short hash, else null.
 */
export function runAtHash(w, main) {
  if (!main || w.branch || !w.head) return null;
  const name = basename(w.path);
  const prefix = `${basename(main)}-at-`;
  const hash = name.startsWith(prefix) ? name.slice(prefix.length) : '';
  return /^[0-9a-f]{7,}$/.test(hash) && w.head.startsWith(hash) && samePath(dirname(w.path), dirname(main)) ? hash : null;
}

/**
 * The pattern of the "Keep on the remote" setting that `branch` (its name there) matches, else null. A
 * pattern is a name, where * stands for anything: release/* keeps release/1.0 and release/1.0/fix.
 */
export function keepMatch(branch, patterns = []) {
  const quote = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return patterns.find((p) => new RegExp(`^${p.split('*').map(quote).join('.*')}$`).test(branch)) ?? null;
}

/**
 * Reads what `planCleanup` needs, fresh rather than from the last load, so a branch that just moved
 * isn't judged by its old tip. `mergedRefs` are the default branch's names (local, and on the remote)
 * that exist; `hasRemotes` says whether there is anywhere commits could have been pushed to.
 * `server`, when the PR host was asked, is { remoteName, merged, open }: its merged and open PRs.
 */
export async function readCleanup(root, { defaultBranch = null, mergedRefs = [], hasRemotes = true, server = null } = {}) {
  const [refs, worktreeList, localOnly, merged] = await Promise.all([
    git(root, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', ...(server ? [`refs/remotes/${server.remoteName}`] : [])]),
    // -z needs git 2.36; before it, the same fields come a line each (paths with newlines aside).
    git(root, ['worktree', 'list', '--porcelain', '-z']).catch(async () => (await git(root, ['worktree', 'list', '--porcelain'])).replace(/\n/g, '\0')),
    // Every commit on a local branch that no remote-tracking branch has. A branch whose tip isn't
    // among them has nothing that exists only here. Without remotes, everything does.
    hasRemotes ? git(root, ['rev-list', '--branches', '--not', '--remotes']).then((s) => new Set(lines(s))) : null,
    // Given several times, --merged lists the branches merged into any of them.
    mergedRefs.length
      ? git(root, ['for-each-ref', '--format=%(refname)', ...mergedRefs.map((r) => `--merged=${r}`), 'refs/heads']).then(
          (s) => new Set(lines(s).map((r) => r.replace(/^refs\/heads\//, ''))),
        )
      : new Set(),
  ]);
  const worktrees = parseWorktrees(worktreeList).map((w) => ({ ...w, path: resolve(w.path), current: samePath(w.path, root) }));
  // Only the worktrees that could go need their status read: one git each.
  const candidates = worktrees.filter((w) => !w.main && !w.current && !w.bare && !w.locked && !w.prunable);
  const changes = {};
  await Promise.all(
    candidates.map(async (w) => {
      try {
        // Ignored files don't count, as with `git worktree remove`.
        changes[w.path] = (await git(w.path, ['status', '--porcelain', '-z', '--untracked-files=normal'])).split('\0').filter(Boolean).length;
      } catch {
        changes[w.path] = null;
      }
    }),
  );
  // A detached worktree may hold commits that no branch, remote branch or tag has; removing it would lose them.
  const heads = candidates.filter((w) => !w.branch && w.head).map((w) => w.head);
  const lostHeads = heads.length
    ? new Set(lines(await git(root, ['rev-list', ...heads, '--not', '--branches', '--remotes', '--tags']).catch(() => heads.join('\n'))))
    : new Set();
  const { local: branches, remote } = parseRefs(refs);
  // A branch whose pull request was merged (squashed, say) has nothing only here when its tip is the
  // PR's last commit, or one before it. Only the branches that would stay otherwise need asking. A fork's
  // branch names aren't this repository's, but /review-pr's pr-<n> branches go by the number, forks' too.
  const prMerged = new Map();
  if (server) {
    const stays = (b) => !merged.has(b.name) && (!localOnly || localOnly.has(b.oid));
    await Promise.all(
      branches.filter(stays).map(async (b) => {
        const source = prSource(b, server.remoteName);
        const review = reviewBranchId(b.name);
        const prs = server.merged.filter((p) => p.head && ((!p.fork && p.source === source) || (review != null && Number(p.id) === review)));
        let pr = prs.find((p) => p.head === b.oid);
        for (const p of prs) {
          if (pr) break;
          // Fails both when it isn't an ancestor and when the PR's commit was never fetched.
          if (await git(root, ['merge-base', '--is-ancestor', b.oid, p.head]).then(() => true, () => false)) pr = p;
        }
        if (pr) prMerged.set(b.name, pr);
      }),
    );
  }
  return {
    branches,
    worktrees,
    defaultBranch,
    merged,
    localOnly,
    changes,
    lostHeads,
    prMerged,
    ...(server && { remoteName: server.remoteName, remoteBranches: remote.filter((b) => b.remote === server.remoteName), prs: server.merged, openPrs: server.open }),
  };
}

/**
 * What can go, and why. Never the main working tree or the open one, never the current or the default
 * branch, and never a branch checked out in a worktree that stays.
 * Returns { worktrees: [{ path, branch, prune, why }], branches: [{ name, why, worktree }], remote: [{ name, remote, branch, why }],
 * kept: [{ name, why, worktree, at }] }.
 * A branch's `worktree` is the path of the worktree that has it checked out, which has to go first.
 * In `kept`, `worktree` marks a worktree (its `name` is the path); `at` is where a kept branch is checked out.
 * `remote` has the branches on `remoteName` whose PR was merged with the commit the branch is still at,
 * so nothing was pushed since, and that no open PR comes from or goes into. `keep` (the "Keep on the remote"
 * setting's patterns) keeps those it matches, listed in `kept` by their remote name.
 */
export function planCleanup({
  branches,
  worktrees,
  defaultBranch = null,
  merged = new Set(),
  localOnly = null,
  changes = {},
  lostHeads = new Set(),
  prMerged = new Map(),
  remoteName = null,
  remoteBranches = [],
  prs = [],
  openPrs = [],
  keep = [],
}) {
  const goWorktrees = [];
  const goBranches = [];
  const kept = [];
  const keepWorktree = (w, why) => kept.push({ name: w.path, worktree: true, why });
  const main = worktrees.find((w) => w.main)?.path;
  for (const w of worktrees) {
    if (w.main || w.bare || w.current) continue;
    const n = changes[w.path];
    // One /run-at made, to run an old commit: said as such, so it's clear what it was for.
    const runAt = runAtHash(w, main);
    if (w.locked) keepWorktree(w, 'locked');
    else if (w.prunable) goWorktrees.push({ path: w.path, branch: w.branch, prune: true, why: "its folder is gone: prune git's record of it" });
    else if (n == null) keepWorktree(w, "couldn't read its status");
    else if (n > 0) keepWorktree(w, runAt ? `made by /run-at for ${runAt}, but has ${plural(n, 'uncommitted change')} (x in Worktrees removes it)` : plural(n, 'uncommitted change'));
    else if (!w.branch && lostHeads.has(w.head)) keepWorktree(w, 'detached, with commits no branch has');
    else goWorktrees.push({ path: w.path, branch: w.branch, prune: false, why: runAt ? `made by /run-at for ${runAt}, no changes` : 'no changes' });
  }
  const leaving = new Set(goWorktrees.map((w) => w.path));
  const checkedOut = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch, w]));
  const unpushed = new Set();
  for (const b of branches) {
    if (b.current || b.name === defaultBranch) continue;
    let why = null;
    if (merged.has(b.name)) why = `merged into ${defaultBranch}`;
    else if (localOnly && !localOnly.has(b.oid)) {
      if (b.gone) why = 'upstream gone, nothing unpushed';
      else if (b.upstream && !b.ahead) why = `everything is on ${b.upstream}`;
      else why = 'all its commits are on a remote';
    }
    const pr = prMerged.get(b.name);
    if (!why && pr) why = `${pr.label} was merged into ${pr.target}`;
    const w = checkedOut.get(b.name);
    if (!why) {
      unpushed.add(b.name);
      kept.push({ name: b.name, why: 'has commits that are only here' });
    } else if (w && !leaving.has(w.path)) kept.push({ name: b.name, why, at: w.path });
    else goBranches.push({ name: b.name, why, worktree: w ? w.path : null });
  }
  // A worktree can go even when its branch can't: the branch stays, and the list says so.
  const going = new Set(goBranches.map((b) => b.name));
  for (const w of goWorktrees) {
    if (w.branch && !going.has(w.branch)) w.why += `; its branch ${w.branch} stays${unpushed.has(w.branch) ? ' (unpushed commits)' : ''}`;
  }
  const busy = new Set(openPrs.flatMap((p) => [p.source, p.target]));
  const goRemote = [];
  for (const b of remoteBranches) {
    const branch = b.name.slice(remoteName.length + 1);
    if (branch === defaultBranch || busy.has(branch)) continue;
    const pr = prs.find((p) => !p.fork && p.source === branch && p.head === b.oid);
    if (!pr) continue;
    const pattern = keepMatch(branch, keep);
    if (pattern) kept.push({ name: b.name, why: `${pr.label} was merged, but kept on the remote (${pattern}, in /settings)` });
    else goRemote.push({ name: b.name, remote: remoteName, branch, why: `${pr.label} was merged into ${pr.target}` });
  }
  return { worktrees: goWorktrees, branches: goBranches, remote: goRemote, kept };
}

/** The part of `plan` that `choice` ("all", "local", "branches", "worktrees" or "remote") covers. */
export function cleanupChoice(plan, choice) {
  const remote = plan.remote ?? [];
  if (choice === 'remote') return { worktrees: [], branches: [], remote };
  if (choice === 'local') return { worktrees: plan.worktrees, branches: plan.branches, remote: [] };
  if (choice === 'worktrees') return { worktrees: plan.worktrees, branches: [], remote: [] };
  // While the worktrees stay, so do the branches they have checked out.
  if (choice === 'branches') return { worktrees: [], branches: plan.branches.filter((b) => !b.worktree), remote: [] };
  return { worktrees: plan.worktrees, branches: plan.branches, remote };
}

/** "3 branches, 2 worktrees and 1 branch on origin" */
export function cleanupCount({ worktrees, branches, remote = [] }) {
  const parts = [];
  if (branches.length) parts.push(plural(branches.length, 'branch', 'branches'));
  if (worktrees.length) parts.push(plural(worktrees.length, 'worktree'));
  if (remote.length) parts.push(`${plural(remote.length, 'branch', 'branches')} on ${remote[0].remote}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join('');
}

/** The confirmation's choices for `plan`. */
export function cleanupOptions(plan) {
  const remote = plan.remote ?? [];
  if ([plan.worktrees, plan.branches, remote].filter((k) => k.length).length < 2) {
    return [{ label: `Yes, ${cleanupCount(plan)}`, value: 'all' }, { label: 'No', value: null }];
  }
  const only = (choice) => ({ label: `Only the ${cleanupCount(cleanupChoice(plan, choice))}`, value: choice });
  const both = plan.worktrees.length && plan.branches.length;
  return [
    { label: `Yes, all ${cleanupCount(plan)}`, value: 'all' },
    ...(remote.length ? [only('local')] : []),
    ...(both && cleanupChoice(plan, 'branches').branches.length ? [only('branches')] : []),
    ...(both ? [only('worktrees')] : []),
    ...(remote.length ? [only('remote')] : []),
    { label: 'No', value: null },
  ];
}

/** The list for the viewer: what goes and why, then what stays. Paths are shown relative to `root`. */
export function cleanupText(plan, root) {
  const show = (p) => relative(root, p) || p;
  const rows = (items) => {
    const w = Math.min(40, Math.max(...items.map((i) => i.label.length)));
    return items.map((i) => `  ${i.label.padEnd(w)}  ${i.why}`);
  };
  const out = [];
  if (plan.worktrees.length) {
    const items = plan.worktrees.map((w) => ({ label: show(w.path), why: w.why }));
    out.push(`Worktrees to remove (${items.length})`, ...rows(items), '');
  }
  if (plan.branches.length) {
    const items = plan.branches.map((b) => ({ label: b.name, why: b.worktree ? `${b.why}, after its worktree ${show(b.worktree)}` : b.why }));
    out.push(`Branches to delete (${items.length})`, ...rows(items), '');
  }
  if (plan.remote?.length) {
    const items = plan.remote.map((b) => ({ label: b.branch, why: b.why }));
    out.push(`Branches to delete on ${plan.remote[0].remote} (${items.length})`, ...rows(items), '');
  }
  if (plan.kept.length) {
    const items = plan.kept.map((k) => ({ label: k.worktree ? show(k.name) : k.name, why: k.at ? `${k.why}, but checked out in ${show(k.at)}` : k.why }));
    out.push(`Staying (${items.length})`, ...rows(items));
  }
  return out.join('\n').trimEnd();
}
