// /sync and /update-branch: bringing local branches up to date with their remotes, and the current one
// up to date with the default branch. What to do with each branch, and the report, are pure; reading
// which branches other worktrees are rebasing is the one thing that reads files.
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The upstream's commit, a remote branch or (for a branch tracking another local one) a local branch. */
const oidOf = (refs, name) => refs.remote.find((b) => b.name === name)?.oid ?? refs.local.find((b) => b.name === name)?.oid ?? null;

/**
 * What /sync does with each local branch that has an upstream, once fetched: `refs` from parseRefs,
 * `current` the branch checked out here, `elsewhere` a Map of the branches checked out (or being rebased)
 * in other worktrees to their folders, `dirty` whether this worktree has changes to tracked files.
 * - `forward`: only behind, so fast-forwarded where they are (update-ref, never touching a worktree);
 * - `current`: the one checked out here, when it's only behind and the working tree is clean (merge --ff-only);
 * - `ahead`, `diverged`, `upToDate`: left alone; `gone`: the upstream was deleted; `skipped`: { ..., why }.
 */
export function planSync({ refs, current = null, elsewhere = new Map(), dirty = false }) {
  const plan = { forward: [], current: null, upToDate: [], ahead: [], diverged: [], gone: [], skipped: [] };
  for (const b of refs.local) {
    if (!b.upstream) continue;
    const item = { name: b.name, upstream: b.upstream, ahead: b.ahead, behind: b.behind, from: b.oid, to: oidOf(refs, b.upstream), current: b.name === current };
    if (b.gone) plan.gone.push(item);
    else if (!b.behind) (b.ahead ? plan.ahead : plan.upToDate).push(item);
    else if (b.ahead) plan.diverged.push(item);
    else if (!item.to) plan.skipped.push({ ...item, why: `${b.upstream} isn't here to move it to` });
    else if (item.current && dirty) plan.skipped.push({ ...item, why: 'has uncommitted changes: commit or stash them, then pull (p)' });
    else if (!item.current && elsewhere.has(b.name)) plan.skipped.push({ ...item, why: `checked out in ${elsewhere.get(b.name)}` });
    else if (item.current) plan.current = item;
    else plan.forward.push(item);
  }
  return plan;
}

/** `git update-ref --stdin` input moving each branch from where it was (or not at all, if it moved since). */
export const forwardInput = (list) => list.map((b) => `update refs/heads/${b.name} ${b.to} ${b.from}\n`).join('');

const short = (hash) => (hash ?? '').slice(0, 7);
const commits = (n) => `${n} commit${n === 1 ? '' : 's'}`;

/** The viewer's report of a sync: what moved, what didn't and why. `moved` names the branches that did; `failed` is [{ name, why }]. */
export function syncText(plan, { moved = [], failed = [] } = {}) {
  const done = new Set(moved);
  const tried = [...(plan.current ? [plan.current] : []), ...plan.forward];
  const forwarded = tried.filter((b) => done.has(b.name));
  const all = [...tried, ...plan.upToDate, ...plan.ahead, ...plan.diverged, ...plan.gone, ...plan.skipped];
  if (!all.length) return 'Fetched. No local branch tracks a remote branch, so there was nothing to bring up to date.\nU on a local branch in Branches sets what it tracks.';
  const w = Math.min(32, Math.max(...all.map((b) => b.name.length)));
  const row = (b, text) => `  ${b.name.padEnd(w)}  ${text}`;
  const out = ['Fetched every remote (pruning deleted branches).', ''];
  const section = (title, list, text) => {
    if (list.length) out.push(`${title} (${list.length})`, ...list.map((b) => row(b, text(b))), '');
  };
  section('Fast-forwarded', forwarded, (b) => `${short(b.from)} → ${short(b.to)}, ${commits(b.behind)} from ${b.upstream}`);
  section("Couldn't be moved", failed, (b) => b.why);
  section('Diverged, left alone', plan.diverged, (b) =>
    `↑${b.ahead} ↓${b.behind} against ${b.upstream}: ${b.current ? `rebase it onto ${b.upstream} (offered now), or /pull` : `check it out, then /sync offers to rebase it`}`,
  );
  section('Ahead, left alone', plan.ahead, (b) => `↑${b.ahead} on ${b.upstream}: ${b.current ? 'P pushes it' : 'push it from there'}`);
  section('Not moved', plan.skipped, (b) => `↓${b.behind} behind ${b.upstream}, but ${b.why}`);
  section('Upstream gone', plan.gone, (b) => `${b.upstream} was deleted: /cleanup (C) deletes the branch if nothing of yours is left on it`);
  if (plan.upToDate.length) out.push(`Up to date: ${plan.upToDate.map((b) => b.name).join(', ')}`);
  return out.join('\n').trimEnd();
}

/** The line in the activity log: "Synced: 2 fast-forwarded, 1 diverged". */
export function syncSummary(plan, { moved = [], failed = [] } = {}) {
  const parts = [
    moved.length && `${moved.length} fast-forwarded`,
    failed.length && `${failed.length} couldn't be moved`,
    plan.diverged.length && `${plan.diverged.length} diverged`,
    plan.ahead.length && `${plan.ahead.length} ahead`,
    plan.skipped.length && `${plan.skipped.length} not moved`,
    plan.gone.length && `${plan.gone.length} with the upstream gone`,
  ].filter(Boolean);
  return `Synced: ${parts.length ? parts.join(', ') : 'every branch is up to date'}`;
}

/**
 * The branches being rebased in other worktrees (and in the main one, seen from a linked one), which
 * show as detached there but mustn't be moved under the rebase: a Map of branch → worktree folder.
 */
export async function rebasingElsewhere(commonDir, gitDir) {
  const found = new Map();
  const look = async (dir, folder) => {
    for (const sub of ['rebase-merge', 'rebase-apply']) {
      const name = (await readFile(join(dir, sub, 'head-name'), 'utf8').catch(() => '')).trim();
      if (name.startsWith('refs/heads/')) found.set(name.slice(11), folder);
    }
  };
  if (gitDir !== commonDir) await look(commonDir, dirname(commonDir));
  const list = join(commonDir, 'worktrees');
  if (!existsSync(list)) return found;
  for (const id of await readdir(list).catch(() => [])) {
    const dir = join(list, id);
    if (dir === gitDir) continue;
    // `gitdir` holds the path of the worktree's .git file.
    const folder = dirname((await readFile(join(dir, 'gitdir'), 'utf8').catch(() => '')).trim()) || id;
    await look(dir, folder);
  }
  return found;
}

/**
 * Force-pushes for the branches a rebase rewrote that are on a remote: one `git push --force-with-lease`
 * per remote, each branch to its upstream's name. `branches` is [{ name, upstream }] (upstream as
 * "origin/feature"); `remotes` the remote names, to tell where the remote's name ends.
 */
export function forcePushes(branches, remotes) {
  const byRemote = new Map();
  for (const b of branches) {
    const remote = [...remotes].sort((x, y) => y.length - x.length).find((r) => b.upstream?.startsWith(`${r}/`));
    if (!remote) continue;
    if (!byRemote.has(remote)) byRemote.set(remote, []);
    byRemote.get(remote).push(`${b.name}:${b.upstream.slice(remote.length + 1)}`);
  }
  return [...byRemote].map(([remote, specs]) => ['push', '--force-with-lease', remote, ...specs]);
}

/** Parses /update-branch's arguments: [base] [--stack]. */
export function updateBranchArgs(words) {
  const stack = words.includes('--stack');
  const unknown = words.find((w) => w.startsWith('-') && w !== '--stack');
  const bases = words.filter((w) => !w.startsWith('-'));
  if (unknown) return { error: `/update-branch takes a base and --stack, not ${unknown}.` };
  if (bases.length > 1) return { error: 'Name one branch to rebase onto: /update-branch [base] [--stack]' };
  return { base: bases[0] ?? null, stack };
}
