// Every git operation the UI offers, written once. Keys and slash commands both call these.
// `ctx` is the app's handle: data, exec, confirm, note, prefill, and so on (see App.jsx).
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { READ_ONLY, cleanSubject, clip, commitPrompt, lookPrompt, parsePrDraft, prPrompt } from './claude.js';
import { splitArgs } from './parse.js';
import { buildPatch, coversAll, parseDiff } from './patch.js';
import { cleanup, loadPlan, planProblem, planSummary, prepare } from './rebase.js';

const short = (hash) => hash.slice(0, 7);
const YES_NO = (yes) => [
  { label: yes, value: true },
  { label: 'No', value: false },
];

function needRepo(ctx) {
  if (ctx.data) return true;
  ctx.note('Open a repository first: press 7 for Repos, or /open <path>.', 'error');
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
  const interactive = ref.match(/^(?:-i|--interactive)(?:\s+(.*))?$/);
  if (interactive) return interactive[1] ? openRebase(ctx, interactive[1].trim(), interactive[1].trim()) : ctx.prefill('/rebase -i ');
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
  if (!ctx.data.state) await cleanup(ctx.data.gitDir);
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
  if (!ok) return;
  await ctx.exec([OP[state], '--abort'], { label: 'Aborting' });
  if (!ctx.data.state) await cleanup(ctx.data.gitDir);
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

// `git worktree add` with its own defaults: a relative path is taken from the repository's root,
// and without a ref git makes a new branch named after the folder.
export async function addWorktree(ctx, argText) {
  if (!needRepo(ctx)) return;
  const args = splitArgs(argText ?? '');
  if (!args.length) return ctx.prefill('/worktree ');
  const r = await ctx.exec(['worktree', 'add', ...args], { label: 'Adding worktree' });
  if (r.ok) ctx.setView('worktrees');
  return r;
}

export async function removeWorktree(ctx, wt) {
  if (!needRepo(ctx)) return;
  // Its folder is already gone; prune just clears git's record of it (and any others like it).
  if (wt.prunable) return ctx.exec(['worktree', 'prune'], { label: 'Pruning worktrees' });
  if (wt.main) return ctx.note("That's the main working tree. Only the worktrees added to it can be removed.", 'error');
  if (wt.current) return ctx.note('That worktree is the one open here. Open another one first (↵).', 'error');
  const ok = await ctx.confirm({
    title: `Remove the worktree at ${wt.path}?`,
    detail: wt.branch ? `Deletes the folder. The branch ${wt.branch} stays.` : 'Deletes the folder.',
    options: YES_NO('Yes, remove it'),
    danger: true,
  });
  if (!ok) return;
  // Plain remove refuses to lose changes, so forcing gets its own question.
  const r = await ctx.exec(['worktree', 'remove', wt.path], { label: 'Removing worktree', quietError: true });
  if (r.ok || !/modified or untracked files/.test(r.error?.message ?? '')) {
    if (!r.ok) ctx.note(r.error.message, 'error');
    return r;
  }
  const force = await ctx.confirm({
    title: `The worktree at ${wt.path} has uncommitted changes. Remove it anyway?`,
    detail: 'Those changes would be lost for good.',
    options: YES_NO('Yes, remove it and its changes'),
    danger: true,
  });
  if (force) return ctx.exec(['worktree', 'remove', '--force', wt.path], { label: 'Removing worktree' });
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

/** Puts every file back the way the last commit has it, staged or not. Ignored files stay. */
export async function discardAll(ctx) {
  if (!needRepo(ctx)) return;
  const { files } = ctx.data.status;
  if (!files.length) return ctx.note('No changes to discard.', 'error');
  const { state } = ctx.data;
  if (state) return ctx.note(`A ${OP[state]} is in progress: /abort puts things back instead.`, 'error');
  const untracked = files.filter((f) => f.kind === 'untracked').length;
  const tracked = files.length - untracked;
  const choice = await ctx.confirm({
    title: `Discard all changes to ${files.length} ${files.length === 1 ? 'file' : 'files'}?`,
    detail: `${untracked ? 'Untracked files are deleted. ' : ''}This can't be undone; /stash keeps the changes instead.`,
    options: [
      { label: 'Yes, discard everything', value: 'all' },
      ...(untracked && tracked ? [{ label: 'Discard, but keep the untracked files', value: 'tracked' }] : []),
      { label: 'No', value: null },
    ],
    danger: true,
  });
  if (!choice) return;
  const steps = [];
  // Before the first commit there is no HEAD to reset to: remove what's staged, files included.
  if (tracked) steps.push(isInitial(ctx) ? ['rm', '-r', '-f', '-q', '.'] : ['reset', '--hard', '-q']);
  if (untracked && choice === 'all') steps.push(['clean', '-f', '-d', '-q']);
  for (const [i, args] of steps.entries()) {
    const r = await ctx.exec(args, { label: 'Discarding', refresh: i === steps.length - 1 });
    if (!r.ok) return r;
  }
}

/** Takes one side of a conflicted file and marks it resolved. */
export async function resolveWith(ctx, f, side) {
  const r = await ctx.exec(['checkout', `--${side}`, '--', f.path], { refresh: false, quiet: true });
  if (r.ok) return ctx.exec(['add', '--', f.path], { quiet: true });
}

const apply = (ctx, patch, flags, label) =>
  ctx.exec(['apply', ...flags, '--recount', '--whitespace=nowarn', '-'], { input: patch, quiet: true, label });

/**
 * Stages (or, for a staged file, unstages) just the picked lines of `diffText`.
 * With `discard`, throws the picked lines away from the working tree instead.
 */
export async function applyLines(ctx, f, diffText, picks, { discard = false } = {}) {
  let diff = parseDiff(diffText);
  const all = coversAll(diff, picks);
  if (discard) {
    if (f.area !== 'unstaged') return ctx.note('Only unstaged lines can be discarded. Unstage them first.', 'error');
    if (f.kind === 'untracked') return ctx.note('This is a new file: discard the whole file from the list instead (d).', 'error');
    const ok = await ctx.confirm({
      title: `Discard the selected ${all ? 'changes' : 'lines'} in ${f.path}?`,
      detail: "This can't be undone.",
      options: [{ label: 'Yes, discard', value: true }, { label: 'No', value: false }],
      danger: true,
    });
    if (ok) return apply(ctx, buildPatch(diff, picks, { reverse: true }), ['--reverse'], 'Discarding');
    return;
  }
  // When every line is picked, the plain file commands also cover what a patch can't (modes, binaries).
  if (f.area === 'staged') return all ? unstage(ctx, f) : apply(ctx, buildPatch(diff, picks, { reverse: true }), ['--cached', '--reverse'], 'Unstaging');
  if (all) return stage(ctx, f);
  if (f.kind === 'untracked') {
    // Part of a new file: record the file as intended, then patch the index like any other change.
    if (!(await ctx.exec(['add', '--intent-to-add', '--', f.path], { quiet: true, refresh: false })).ok) return;
    diff = parseDiff(await ctx.git(['diff', '--', f.path]));
  }
  return apply(ctx, buildPatch(diff, picks), ['--cached'], 'Staging');
}

/**
 * Opens the interactive rebase editor for the commits after `base` up to HEAD.
 * `base` null means from the very first commit (git rebase -i --root).
 */
export async function openRebase(ctx, base, from) {
  if (!needRepo(ctx)) return;
  if (ctx.data.state) return ctx.note(`Finish the ${ctx.data.state.replace('ing', '')} in progress first (/continue or /abort).`, 'error');
  if (ctx.data.status.files.length) return ctx.note('Commit or stash your changes before rebasing.', 'error');
  let rows;
  try {
    if (base) await ctx.git(['merge-base', '--is-ancestor', base, 'HEAD']);
    rows = await loadPlan(ctx.data.root, base);
  } catch {
    return ctx.note(`${from} isn't part of the current branch's history, so there's nothing to rebase from it.`, 'error');
  }
  if (!rows.length) return ctx.note('There are no commits after that one to rebase.', 'error');
  if (rows.some((r) => r.merge)) return ctx.note('That range has merge commits, which an interactive rebase would flatten. Pick a commit after the last merge.', 'error');
  ctx.showRebase({ base, from, rows });
}

/** Runs the plan from the editor. `rows` are oldest first. */
export async function runRebase(ctx, base, rows) {
  const problem = planProblem(rows);
  if (problem) return ctx.note(problem, 'error');
  const { branch } = ctx.data.status;
  let pushed = false;
  if (branch.upstream) pushed = await ctx.git(['merge-base', '--is-ancestor', rows[0].hash, '@{upstream}']).then(() => true, () => false);
  const ok = await ctx.confirm({
    title: `Rewrite ${rows.length} commit${rows.length === 1 ? '' : 's'} on ${branch.head ?? 'HEAD'}? (${planSummary(rows)})`,
    detail: pushed
      ? `Some of them are already on ${branch.upstream}, so you'll need /push --force afterwards.`
      : 'If it stops on a conflict or an edit, /continue carries on and /abort puts everything back.',
    options: YES_NO('Yes, rebase'),
    danger: pushed,
  });
  if (!ok) return false;
  const { env } = await prepare(ctx.data.gitDir, rows);
  ctx.closeOverlay();
  await ctx.exec(['rebase', '-i', base ?? '--root'], { label: 'Rebasing', env });
  if (!ctx.data.state) await cleanup(ctx.data.gitDir);
  else if (ctx.data.changes.conflicts.length) afterConflicts(ctx);
  else ctx.note('Stopped for editing. Change what you need, amend (A in Changes), then /continue.');
  return true;
}

function needHost(ctx) {
  if (!needRepo(ctx)) return null;
  const host = ctx.host();
  if (!host) ctx.note("This repository's remote isn't on GitHub or Azure DevOps, so there are no pull requests to show.", 'error');
  return host;
}

// gh and az calls go through the same queue, spinner and activity lines as git.
const hostTask = (ctx, title, fn, opts) => ctx.task(title, async (signal) => ({ stdout: (await fn(signal)) ?? '', stderr: '' }), opts);
const cliName = (host) => (host.kind === 'github' ? 'gh pr' : 'az repos pr');

export async function prCheckout(ctx, pr) {
  const host = needHost(ctx);
  if (!host || !pr) return;
  if (host.checkout) return hostTask(ctx, `gh pr checkout ${pr.id}`, (signal) => host.checkout(pr, signal), { label: 'Checking out' });
  const r = await ctx.exec(['fetch', host.remoteName, `+refs/heads/${pr.source}:refs/remotes/${host.remoteName}/${pr.source}`], { label: 'Fetching' });
  if (r.ok) return checkout(ctx, `${host.remoteName}/${pr.source}`);
}

export async function prApprove(ctx, pr) {
  const host = needHost(ctx);
  if (!host) return;
  if (!pr) return ctx.note('Pick a pull request in PRs (6) first.', 'error');
  if (pr.mine) return ctx.note("That's your own pull request.", 'error');
  const ok = await ctx.confirm({ title: `Approve ${pr.label} "${pr.title}"?`, detail: `On ${host.name}, as you.`, options: YES_NO('Yes, approve') });
  if (!ok) return;
  const r = await hostTask(ctx, `${cliName(host)} approve ${pr.label}`, (signal) => host.approve(pr, signal), { label: 'Approving', refresh: false });
  if (r.ok) ctx.prsChanged();
  return r;
}

export async function prComment(ctx, text) {
  const host = needHost(ctx);
  if (!host) return;
  const pr = ctx.selectedPr;
  if (!pr) return ctx.note('Pick a pull request in PRs (6) first.', 'error');
  if (!text) return ctx.prefill('/comment ');
  const r = await hostTask(ctx, `${cliName(host)} comment ${pr.label}`, (signal) => host.comment(pr, text, signal), { label: 'Commenting', refresh: false });
  if (r.ok) ctx.prsChanged();
  return r;
}

/** `/pr <title> [--into <branch>] [--draft]`: opens a PR from the current branch, pushing it first if needed. */
export async function createPr(ctx, text) {
  const host = needHost(ctx);
  if (!host) return;
  const { branch } = ctx.data.status;
  if (!branch.head) return ctx.note('HEAD is detached. Check out the branch you want to open a pull request from.', 'error');
  let { target, draft, title } = prArgs(text);
  if (!title) {
    const last = ctx.data.graph.find((r) => r.commit?.refs.some((x) => x.head))?.commit.subject ?? '';
    return ctx.prefill(`/pr ${last}`);
  }
  try {
    target ??= await host.defaultBranch();
  } catch (e) {
    return ctx.note(`Couldn't read the default branch from ${host.name}: ${e.message.split('\n')[0]}`, 'error');
  }
  if (!target) return ctx.note('Say which branch it goes into: /pr <title> --into <branch>', 'error');
  if (target === branch.head) return ctx.note(`You're on ${target} itself. Switch to the branch with your changes first.`, 'error');
  // A description Claude drafted for this branch (W in PRs) goes with it, if you say so.
  const drafted = ctx.prDraft?.branch === branch.head && ctx.prDraft.body ? ctx.prDraft.body : '';
  const answer = await ctx.confirm({
    title: `Open a ${draft ? 'draft ' : ''}pull request from ${branch.head} into ${target}?`,
    detail: `"${title}" on ${host.name}${!branch.upstream || branch.ahead ? '. Pushes the branch first.' : ''}`,
    options: drafted
      ? [
          { label: "Yes, with Claude's description", value: 'body' },
          { label: 'Yes, without a description', value: 'bare' },
          { label: 'No', value: false },
        ]
      : YES_NO('Yes, open it'),
  });
  if (!answer) return;
  const body = answer === 'body' ? drafted : '';
  // The server can only see what has been pushed.
  if (!branch.upstream || branch.ahead) {
    const pushed = await push(ctx);
    if (!pushed?.ok) return;
  }
  const r = await hostTask(ctx, `${cliName(host)} create "${title}"`, (signal) => host.create({ title, body, source: branch.head, target, draft }, signal), {
    label: 'Opening pull request',
    refresh: false,
  });
  if (r.ok) {
    ctx.prDraft = null;
    ctx.prsChanged();
  }
  return r;
}

// Claude, through the Claude Code CLI: App passes `ctx.askClaude` (claude.js's `ask`; tests pass a stub).
// A call takes several seconds, so it runs as a task: the spinner, esc to cancel, one at a time.
function askClaude(ctx, what, prompt, input, tools = []) {
  return ctx.task(
    `claude: ${what}`,
    async (signal) => {
      const text = typeof input === 'function' ? await input(signal) : input;
      return { stdout: await ctx.askClaude(prompt, { input: clip(text), cwd: ctx.data.root, signal, tools }), stderr: '' };
    },
    { label: 'Asking Claude', refresh: false, quiet: true },
  );
}

function needClaude(ctx) {
  if (!needRepo(ctx)) return false;
  if (ctx.askClaude) return true;
  ctx.note('Claude is not available here.', 'error');
  return false;
}

/** Claude writes the commit message for the staged changes; it lands in the prompt to edit. */
export async function describeCommit(ctx) {
  if (!needClaude(ctx)) return;
  if (!ctx.data.changes.staged.length) {
    return ctx.note('Stage what you want to commit first (space, or a for everything), then ask Claude for the message (W).', 'error');
  }
  const recent = (await ctx.git(['log', '-n15', '--format=%s']).catch(() => '')).split('\n').filter(Boolean);
  const r = await askClaude(ctx, 'commit message', commitPrompt(recent), () => ctx.git(['diff', '--cached', '--stat', '--patch', '-M']));
  if (!r.ok) return r;
  const subject = cleanSubject(r.out);
  if (!subject) return ctx.note("Claude didn't suggest a message. Try again, or write one: /commit <message>", 'error');
  ctx.prefill(`/commit ${subject}`);
  return r;
}

/** Claude drafts a pull request for the current branch: the title goes in the prompt, the description with it. */
export async function draftPr(ctx, text) {
  if (!needClaude(ctx)) return;
  const host = needHost(ctx);
  if (!host) return;
  const { branch } = ctx.data.status;
  if (!branch.head) return ctx.note('HEAD is detached. Check out the branch you want to open a pull request from.', 'error');
  let { target } = prArgs(text);
  const asked = target;
  try {
    target ??= await host.defaultBranch();
  } catch (e) {
    return ctx.note(`Couldn't read the default branch from ${host.name}: ${e.message.split('\n')[0]}`, 'error');
  }
  if (!target) return ctx.note('Say which branch it goes into: /draft-pr --into <branch>', 'error');
  if (target === branch.head) return ctx.note(`You're on ${target} itself. Switch to the branch with your changes first.`, 'error');
  // Compare with the server's copy of the target when there is one: that's what the PR will be against.
  const { remotes } = ctx.data;
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  const base = ctx.data.refs.remote.some((b) => b.name === `${remote}/${target}`) ? `${remote}/${target}` : target;
  const log = await ctx.git(['log', '--reverse', '--format=%s%n%n%b', `${base}..HEAD`]).catch(() => '');
  if (!log.trim()) return ctx.note(`${branch.head} has no commits that aren't in ${base}, so there's nothing to open a pull request for.`, 'error');
  const r = await askClaude(ctx, 'pull request', prPrompt(branch.head, target), async () =>
    `${log.trim()}\n\n${await ctx.git(['diff', '--stat', '--patch', '-M', `${base}...HEAD`])}`,
  );
  if (!r.ok) return r;
  const { title, body } = parsePrDraft(r.out);
  if (!title) return ctx.note("Claude didn't draft a title. Try again, or open it yourself: /pr <title>", 'error');
  ctx.prDraft = { branch: branch.head, body };
  ctx.showText(`Pull request draft: ${branch.head} → ${target}`, `${title}\n\n${body}`, { wrap: true });
  ctx.prefill(`/pr ${title}${asked ? ` --into ${asked}` : ''}`);
  return r;
}

/**
 * Claude explains (`mode` "explain") or reviews ("review") something: a commit ({ kind: 'commit', hash, subject }),
 * a pull request ({ kind: 'pr', pr }), or your changes ({ kind: 'changes' }: the staged ones, or else the unstaged).
 * The answer opens in the viewer.
 */
export async function claudeLook(ctx, mode, target) {
  if (!needClaude(ctx)) return;
  let what;
  let input;
  if (target.kind === 'commit') {
    what = `${target.hash.slice(0, 7)} ${target.subject}`;
    input = () => ctx.git(['show', '--stat', '--patch', '-M', '--diff-merges=first-parent', '--format=fuller', target.hash]);
  } else if (target.kind === 'pr') {
    const { pr } = target;
    const host = needHost(ctx);
    if (!host) return;
    what = `${pr.label} ${pr.title}`;
    input = async () => `Pull request ${pr.label}: ${pr.title}\n\n${pr.description ?? ''}\n\n${await host.diff(pr)}`;
  } else {
    const { staged, unstaged } = ctx.data.changes;
    if (!staged.length && !unstaged.length) return ctx.note('There are no changes to look at: the working tree is clean.', 'error');
    what = staged.length ? 'your staged changes' : 'your unstaged changes';
    input = () => ctx.git(staged.length ? ['diff', '--cached', '--stat', '--patch', '-M'] : ['diff', '--stat', '--patch', '-M']);
  }
  const subject = target.kind === 'commit' ? 'this commit' : target.kind === 'pr' ? 'this pull request' : 'these changes';
  const r = await askClaude(ctx, `${mode} ${what}`, lookPrompt(mode, subject), input, READ_ONLY);
  if (r.ok) ctx.showText(`${mode === 'explain' ? 'Claude explains' : 'Claude reviews'} ${what}`, r.out, { wrap: true });
  return r;
}

/** /explain [ref] and /review [ref]: a commit by any name git knows. /review alone looks at your changes. */
export async function claudeRef(ctx, mode, ref) {
  if (!needClaude(ctx)) return;
  if (!ref && mode === 'review') return claudeLook(ctx, mode, { kind: 'changes' });
  let out;
  try {
    out = await ctx.git(['log', '-1', '--format=%H%x1f%s', ref || 'HEAD', '--']);
  } catch {
    return ctx.note(`No commit called ${ref || 'HEAD'}.`, 'error');
  }
  const [hash, subject] = out.trim().split('\x1f');
  return claudeLook(ctx, mode, { kind: 'commit', hash, subject });
}

/**
 * Splits "/pr" arguments into the flags (--into or --base <branch>, --draft) and the title. The title
 * is kept as typed rather than split into words, so an apostrophe ("Don't ...") isn't taken for a quote.
 */
export function prArgs(text) {
  let target = null;
  let draft = false;
  const title = (text ?? '')
    .replace(/(^|\s)--(?:into|base)\s+(\S+)/g, (_, space, branch) => {
      target = branch;
      return space;
    })
    .replace(/(^|\s)--draft(?=\s|$)/g, (_, space) => {
      draft = true;
      return space;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { target, draft, title };
}

/** `!<args>`: any git command. Output longer than a few lines opens in the viewer. */
export async function raw(ctx, text) {
  const args = splitArgs(text);
  if (args[0] === 'git') args.shift();
  if (!args.length) return ctx.note('Type a git command after !, for example: !log --stat -3', 'error');
  const r = await ctx.exec(args, { label: `git ${args[0]}`, anywhere: true });
  if (r.ok && r.out.split('\n').length > 3) ctx.showText(`git ${text.replace(/^git\s+/, '')}`, r.out, { diff: /^(@@|diff --git)/m.test(r.out) });
}
