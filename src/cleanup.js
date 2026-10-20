// /cleanup: local branches and linked worktrees with nothing of yours on them. `readCleanup` asks git
// for the facts in a handful of processes; `planCleanup` (pure) decides what can go and why.
import { relative, resolve } from 'node:path';
import { samePath } from './config.js';
import { git } from './git.js';
import { REF_FORMAT, parseRefs, parseWorktrees } from './parse.js';

const lines = (s) => s.split('\n').filter(Boolean);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Reads what `planCleanup` needs, fresh rather than from the last load, so a branch that just moved
 * isn't judged by its old tip. `mergedRefs` are the default branch's names (local, and on the remote)
 * that exist; `hasRemotes` says whether there is anywhere commits could have been pushed to.
 */
export async function readCleanup(root, { defaultBranch = null, mergedRefs = [], hasRemotes = true } = {}) {
  const [refs, worktreeList, localOnly, merged] = await Promise.all([
    git(root, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads']),
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
  return { branches: parseRefs(refs).local, worktrees, defaultBranch, merged, localOnly, changes, lostHeads };
}

/**
 * What can go, and why. Never the main working tree or the open one, never the current or the default
 * branch, and never a branch checked out in a worktree that stays.
 * Returns { worktrees: [{ path, branch, prune, why }], branches: [{ name, why, worktree }], kept: [{ name, why, worktree, at }] }.
 * A branch's `worktree` is the path of the worktree that has it checked out, which has to go first.
 * In `kept`, `worktree` marks a worktree (its `name` is the path); `at` is where a kept branch is checked out.
 */
export function planCleanup({ branches, worktrees, defaultBranch = null, merged = new Set(), localOnly = null, changes = {}, lostHeads = new Set() }) {
  const goWorktrees = [];
  const goBranches = [];
  const kept = [];
  const keepWorktree = (w, why) => kept.push({ name: w.path, worktree: true, why });
  for (const w of worktrees) {
    if (w.main || w.bare || w.current) continue;
    const n = changes[w.path];
    if (w.locked) keepWorktree(w, 'locked');
    else if (w.prunable) goWorktrees.push({ path: w.path, branch: w.branch, prune: true, why: "its folder is gone: prune git's record of it" });
    else if (n == null) keepWorktree(w, "couldn't read its status");
    else if (n > 0) keepWorktree(w, plural(n, 'uncommitted change'));
    else if (!w.branch && lostHeads.has(w.head)) keepWorktree(w, 'detached, with commits no branch has');
    else goWorktrees.push({ path: w.path, branch: w.branch, prune: false, why: 'no changes' });
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
  return { worktrees: goWorktrees, branches: goBranches, kept };
}

/** The part of `plan` that `choice` ("all", "branches" or "worktrees") covers. */
export function cleanupChoice(plan, choice) {
  if (choice === 'worktrees') return { worktrees: plan.worktrees, branches: [] };
  // While the worktrees stay, so do the branches they have checked out.
  if (choice === 'branches') return { worktrees: [], branches: plan.branches.filter((b) => !b.worktree) };
  return { worktrees: plan.worktrees, branches: plan.branches };
}

/** "3 branches and 2 worktrees" */
export function cleanupCount({ worktrees, branches }) {
  const parts = [];
  if (branches.length) parts.push(plural(branches.length, 'branch', 'branches'));
  if (worktrees.length) parts.push(plural(worktrees.length, 'worktree'));
  return parts.join(' and ');
}

/** The confirmation's choices for `plan`. */
export function cleanupOptions(plan) {
  if (!plan.worktrees.length || !plan.branches.length) return [{ label: `Yes, ${cleanupCount(plan)}`, value: 'all' }, { label: 'No', value: null }];
  const branches = cleanupChoice(plan, 'branches');
  return [
    { label: `Yes, all ${cleanupCount(plan)}`, value: 'all' },
    ...(branches.branches.length ? [{ label: `Only the ${cleanupCount(branches)}`, value: 'branches' }] : []),
    { label: `Only the ${cleanupCount(cleanupChoice(plan, 'worktrees'))}`, value: 'worktrees' },
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
  if (plan.kept.length) {
    const items = plan.kept.map((k) => ({ label: k.worktree ? show(k.name) : k.name, why: k.at ? `${k.why}, but checked out in ${show(k.at)}` : k.why }));
    out.push(`Staying (${items.length})`, ...rows(items));
  }
  return out.join('\n').trimEnd();
}
