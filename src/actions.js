// Every git operation the UI offers, written once. Keys and slash commands both call these.
// `ctx` is the app's handle: data, exec, confirm, note, prefill, and so on (see App.jsx).
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { splitArgs } from './parse.js';

const short = (hash) => hash.slice(0, 7);
const YES_NO = (yes) => [
  { label: yes, value: true },
  { label: 'No', value: false },
];

function needRepo(ctx) {
  if (ctx.data) return true;
  ctx.note('Open a repository first: press 5 for Repos, or /open <path>.', 'error');
  return false;
}

const isInitial = (ctx) => !ctx.data.status.branch.oid;

// After a merge, rebase or pick stops on conflicts, say what to do next.
function afterConflicts(ctx) {
  const state = ctx.data?.state;
  if (state && ctx.data.changes.conflicts.length) {
    ctx.note(`Stopped with conflicts while ${state}. Fix them in Changes (2), then /continue, or /abort.`, 'error');
  }
}

export function fetch(ctx, args = []) {
  if (!needRepo(ctx)) return;
  return ctx.exec(['fetch', ...(args.length ? args : ['--all', '--prune'])], { label: 'Fetching' });
}

export function pull(ctx, args = []) {
  if (!needRepo(ctx)) return;
  const { branch } = ctx.data.status;
  if (!branch.head) return ctx.note('HEAD is detached, so there is no branch to pull into.', 'error');
  if (!branch.upstream && !args.length) return ctx.note(`${branch.head} has no upstream yet. Push it first (P).`, 'error');
  return ctx.exec(['pull', ...args], { label: 'Pulling' }).then(() => afterConflicts(ctx));
}

export async function push(ctx, args = []) {
  if (!needRepo(ctx)) return;
  const { branch } = ctx.data.status;
  if (!branch.head) return ctx.note('HEAD is detached. Check out a branch to push it.', 'error');
  // --force-with-lease refuses to overwrite commits you haven't seen, which plain --force would destroy.
  const flags = args.map((a) => (a === '--force' || a === '-f' ? '--force-with-lease' : a));
  if (!branch.upstream) {
    const { remotes } = ctx.data;
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!remote) return ctx.note('This repository has no remote. Add one with: !remote add origin <url>', 'error');
    return ctx.exec(['push', ...flags, '-u', remote, branch.head], { label: 'Pushing' });
  }
  if (flags.includes('--force-with-lease')) {
    const ok = await ctx.confirm({
      title: `Force-push ${branch.head} to ${branch.upstream}?`,
      detail: 'Replaces the remote branch with yours. Uses --force-with-lease, so it stops if someone else pushed.',
      options: YES_NO('Yes, force-push'),
      danger: true,
    });
    if (!ok) return;
  }
  return ctx.exec(['push', ...flags], { label: 'Pushing' });
}

export async function commit(ctx, message, { amend = false } = {}) {
  if (!needRepo(ctx)) return;
  if (!message && !amend) return ctx.prefill('/commit ');
  const { staged, unstaged, conflicts } = ctx.data.changes;
  if (conflicts.length && !amend) return ctx.note('Resolve the conflicts first (space marks a file resolved).', 'error');
  if (!staged.length && !amend) {
    if (!unstaged.length) return ctx.note('Nothing to commit: the working tree is clean.', 'error');
    const ok = await ctx.confirm({
      title: 'Nothing is staged. Stage all changes and commit them?',
      options: YES_NO('Yes, stage everything and commit'),
    });
    if (!ok) return;
    if (!(await ctx.exec(['add', '-A'], { refresh: false, quiet: true })).ok) return;
  }
  const args = ['commit', ...(amend ? ['--amend'] : []), ...(message ? ['-m', message] : ['--no-edit'])];
  return ctx.exec(args, { label: amend ? 'Amending' : 'Committing' });
}

/** Switches to a local branch, a remote branch (creating the tracking branch), or anything else detached. */
export function checkout(ctx, ref) {
  if (!needRepo(ctx)) return;
  if (!ref) return ctx.prefill('/checkout ');
  const { local, remote } = ctx.data.refs;
  const opts = { label: 'Switching' };
  if (local.some((b) => b.name === ref)) return ctx.exec(['switch', ref], opts);
  const rb = remote.find((b) => b.name === ref) ?? remote.find((b) => b.name === `${b.remote}/${ref}`);
  if (rb) {
    const name = rb.name.slice(rb.remote.length + 1);
    if (local.some((b) => b.name === name)) return ctx.exec(['switch', name], opts);
    return ctx.exec(['switch', '--track', rb.name], opts);
  }
  return ctx.exec(['switch', '--detach', ref], opts);
}

/** From the graph: prefer a branch that points at the commit over a detached HEAD. */
export function checkoutCommit(ctx, c) {
  const local = c.refs.find((r) => r.type === 'local' && !r.head);
  if (c.refs.some((r) => r.head)) return ctx.note('Already on this commit.');
  const remote = c.refs.find((r) => r.type === 'remote');
  return checkout(ctx, local?.name ?? remote?.name ?? c.hash);
}

export function createBranch(ctx, argText) {
  if (!needRepo(ctx)) return;
  const [name, start] = splitArgs(argText ?? '');
  if (!name) return ctx.prefill('/branch ');
  return ctx.exec(['switch', '-c', name, ...(start ? [start] : [])], { label: 'Creating branch' });
}

export async function deleteRef(ctx, name) {
  if (!needRepo(ctx)) return;
  if (!name) return ctx.prefill('/delete ');
  const { local, remote, tags } = ctx.data.refs;
  const lb = local.find((b) => b.name === name);
  if (lb) {
    if (lb.current) return ctx.note("You can't delete the branch you're on. Switch to another one first.", 'error');
    // -d refuses to lose commits, so it needs no confirmation; forcing does.
    const r = await ctx.exec(['branch', '-d', name], { label: 'Deleting', quietError: true });
    if (r.ok || !/not fully merged/.test(r.error?.message ?? '')) {
      if (!r.ok) ctx.note(r.error.message, 'error');
      return r;
    }
    const force = await ctx.confirm({
      title: `${name} has commits that aren't merged anywhere. Delete it anyway?`,
      detail: 'Those commits would then only be reachable through the reflog.',
      options: YES_NO('Yes, force-delete'),
      danger: true,
    });
    if (force) return ctx.exec(['branch', '-D', name], { label: 'Deleting' });
    return;
  }
  const rb = remote.find((b) => b.name === name);
  if (rb) {
    const branch = name.slice(rb.remote.length + 1);
    const ok = await ctx.confirm({
      title: `Delete ${branch} on ${rb.remote}?`,
      detail: 'This removes the branch from the server for everyone.',
      options: YES_NO('Yes, delete it on the remote'),
      danger: true,
    });
    if (ok) return ctx.exec(['push', rb.remote, '--delete', branch], { label: 'Deleting remote branch' });
    return;
  }
  if (tags.some((t) => t.name === name)) return ctx.exec(['tag', '-d', name], { label: 'Deleting tag' });
  ctx.note(`No branch or tag called ${name}.`, 'error');
}

function currentName(ctx) {
  return ctx.data.status.branch.head ?? 'HEAD';
}

export async function merge(ctx, ref, { ask = false } = {}) {
  if (!needRepo(ctx)) return;
  if (!ref) return ctx.prefill('/merge ');
  if (ask) {
    const ok = await ctx.confirm({ title: `Merge ${ref} into ${currentName(ctx)}?`, options: YES_NO('Yes, merge') });
    if (!ok) return;
  }
  await ctx.exec(['merge', '--no-edit', ref], { label: 'Merging' });
  afterConflicts(ctx);
}

export async function rebase(ctx, ref) {
  if (!needRepo(ctx)) return;
  if (!ref) return ctx.prefill('/rebase ');
  const ok = await ctx.confirm({
    title: `Rebase ${currentName(ctx)} onto ${ref}?`,
    detail: `Rewrites the commits on ${currentName(ctx)} that aren't on ${ref}. Avoid this on branches others use.`,
    options: YES_NO('Yes, rebase'),
  });
  if (!ok) return;
  await ctx.exec(['rebase', ref], { label: 'Rebasing' });
  afterConflicts(ctx);
}

const OP = { merging: 'merge', rebasing: 'rebase', 'cherry-picking': 'cherry-pick', reverting: 'revert' };

export async function continueOp(ctx) {
  if (!needRepo(ctx)) return;
  const { state } = ctx.data;
  if (!state) return ctx.note('There is no merge, rebase, cherry-pick or revert in progress.', 'error');
  if (ctx.data.changes.conflicts.length) return ctx.note('Some files still have conflicts. Resolve and stage them first.', 'error');
  // A merge is finished by committing it; the others have --continue.
  await ctx.exec(state === 'merging' ? ['commit', '--no-edit'] : [OP[state], '--continue'], { label: 'Continuing' });
  afterConflicts(ctx);
}

export async function abortOp(ctx) {
  if (!needRepo(ctx)) return;
  const { state } = ctx.data;
  if (!state) return ctx.note('There is no merge, rebase, cherry-pick or revert in progress.', 'error');
  const ok = await ctx.confirm({
    title: `Abort the ${OP[state]}?`,
    detail: 'Puts the branch back the way it was before it started.',
    options: YES_NO('Yes, abort'),
  });
  if (ok) return ctx.exec([OP[state], '--abort'], { label: 'Aborting' });
}

export function stash(ctx, message) {
  if (!needRepo(ctx)) return;
  if (!ctx.data.status.files.length) return ctx.note('No changes to stash.', 'error');
  return ctx.exec(['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])], { label: 'Stashing' });
}

export async function stashApply(ctx, ref, { pop = false } = {}) {
  if (!needRepo(ctx)) return;
  if (!ctx.data.stashes.length) return ctx.note('There are no stashes.', 'error');
  await ctx.exec(['stash', pop ? 'pop' : 'apply', ref || 'stash@{0}'], { label: pop ? 'Popping stash' : 'Applying stash' });
  afterConflicts(ctx);
}

export async function stashDrop(ctx, s) {
  const ok = await ctx.confirm({
    title: `Drop ${s.ref}?`,
    detail: s.message,
    options: YES_NO('Yes, drop it'),
    danger: true,
  });
  if (ok) return ctx.exec(['stash', 'drop', s.ref], { label: 'Dropping stash' });
}

export function tag(ctx, argText) {
  if (!needRepo(ctx)) return;
  const [name, ref] = splitArgs(argText ?? '');
  if (!name) return ctx.prefill('/tag ');
  return ctx.exec(['tag', name, ...(ref ? [ref] : [])], { label: 'Tagging' });
}

// Merge commits need to be told which parent is the mainline.
const mainline = (c) => (c.parents.length > 1 ? ['-m', '1'] : []);

export async function cherryPick(ctx, c) {
  const ok = await ctx.confirm({
    title: `Cherry-pick ${short(c.hash)} onto ${currentName(ctx)}?`,
    detail: c.subject,
    options: YES_NO('Yes, cherry-pick'),
  });
  if (!ok) return;
  await ctx.exec(['cherry-pick', ...mainline(c), c.hash], { label: 'Cherry-picking' });
  afterConflicts(ctx);
}

export async function revert(ctx, c) {
  const ok = await ctx.confirm({
    title: `Revert ${short(c.hash)}?`,
    detail: `Adds a new commit that undoes "${c.subject}".`,
    options: YES_NO('Yes, revert'),
  });
  if (!ok) return;
  await ctx.exec(['revert', '--no-edit', ...mainline(c), c.hash], { label: 'Reverting' });
  afterConflicts(ctx);
}

export async function reset(ctx, ref, label = ref) {
  if (!needRepo(ctx)) return;
  if (!ref) return ctx.prefill('/reset ');
  const mode = await ctx.confirm({
    title: `Reset ${currentName(ctx)} to ${label}?`,
    options: [
      { label: 'Soft: keep the changes staged', value: 'soft' },
      { label: 'Mixed: keep the changes, unstaged', value: 'mixed' },
      { label: 'Hard: throw the changes away', value: 'hard' },
      { label: 'Cancel', value: null },
    ],
  });
  if (mode) return ctx.exec(['reset', `--${mode}`, ref], { label: 'Resetting' });
}

const paths = (f) => ['--', ...(f.orig ? [f.orig] : []), f.path];

export function stage(ctx, f) {
  return ctx.exec(['add', ...paths(f)], { quiet: true });
}

export function unstage(ctx, f) {
  // Before the first commit there is no HEAD to restore the index from.
  const args = isInitial(ctx) ? ['rm', '--cached', '-q', '-r', ...paths(f)] : ['restore', '--staged', ...paths(f)];
  return ctx.exec(args, { quiet: true });
}

export function stageAll(ctx) {
  return ctx.exec(['add', '-A'], { quiet: true });
}

export function unstageAll(ctx) {
  return ctx.exec(isInitial(ctx) ? ['rm', '--cached', '-r', '-q', '.'] : ['reset', '-q'], { quiet: true });
}

export async function discard(ctx, f) {
  const untracked = f.kind === 'untracked';
  const ok = await ctx.confirm({
    title: `Discard ${f.area === 'staged' ? 'all changes' : 'unstaged changes'} to ${f.path}?`,
    detail: untracked ? 'The file is untracked, so it will be deleted.' : "This can't be undone.",
    options: YES_NO('Yes, discard'),
    danger: true,
  });
  if (!ok) return;
  if (untracked) {
    await rm(join(ctx.data.root, f.path), { force: true, recursive: true });
    ctx.note(`Deleted ${f.path}`);
    return ctx.reload();
  }
  if (f.area === 'staged') return ctx.exec(['restore', '--staged', '--worktree', ...paths(f)], { label: 'Discarding' });
  return ctx.exec(['restore', ...paths(f)], { label: 'Discarding' });
}

/** Takes one side of a conflicted file and marks it resolved. */
export async function resolveWith(ctx, f, side) {
  const r = await ctx.exec(['checkout', `--${side}`, '--', f.path], { refresh: false, quiet: true });
  if (r.ok) return ctx.exec(['add', '--', f.path], { quiet: true });
}

/** `!<args>`: any git command. Output longer than a few lines opens in the viewer. */
export async function raw(ctx, text) {
  const args = splitArgs(text);
  if (args[0] === 'git') args.shift();
  if (!args.length) return ctx.note('Type a git command after !, for example: !log --stat -3', 'error');
  const r = await ctx.exec(args, { label: `git ${args[0]}`, anywhere: true });
  if (r.ok && r.out.split('\n').length > 3) ctx.showText(`git ${text.replace(/^git\s+/, '')}`, r.out, { diff: /^(@@|diff --git)/m.test(r.out) });
}
