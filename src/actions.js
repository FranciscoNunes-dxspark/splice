// Every git operation the UI offers, written once. Keys and slash commands both call these.
// `ctx` is the app's handle: data, exec, confirm, note, prefill, and so on (see App.jsx).
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { READ_ONLY, cleanSubject, clip, commitPrompt, lookPrompt, parsePrDraft, parseResolution, prPrompt, resolveInput, resolvePrompt } from './claude.js';
import { cleanupChoice, cleanupCount, cleanupOptions, cleanupText, planCleanup, readCleanup } from './cleanup.js';
import { configFile } from './config.js';
import { matchLineEndings, parseConflicts, takeSide, unifiedDiff } from './conflict.js';
import { blamePicker, historyPicker, repoPath } from './history.js';
import { defaultBranch, findArgs, parseGraph, parseStatus, relTime, searchArgs, splitArgs } from './parse.js';
import { buildPatch, coversAll, parseDiff } from './patch.js';
import {
  COMMIT_LIST_FORMAT,
  cleanup,
  fixupExclusions,
  fixupLogArgs,
  foldArgs,
  loadPlan,
  parseCommitList,
  planProblem,
  planSummary,
  prepare,
} from './rebase.js';
import { settingRows, settingSegments } from './settings.js';
import { fit } from './text.js';
import { DEFAULT_ACCENT, isColour, setAccent, theme } from './theme.js';
import {
  REFLOG_FORMAT,
  captureDiscard,
  describeUndo,
  dropDiscard,
  forgetCapture,
  parseReflog,
  planUndo,
  readDiscards,
  reflogActionFor,
  reflogLabel,
  restoreSteps,
  saveDiscard,
  untrackedInTheWay,
} from './undo.js';

const short = (hash) => hash.slice(0, 7);
const firstLine = (s) => String(s ?? '').split('\n')[0];
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

/** `D` in Branches and `/compare <ref> [base]`: the full diff of what `ref` adds to `base` (the default branch if none given). */
export function compare(ctx, text) {
  if (!needRepo(ctx)) return;
  const [ref, given] = splitArgs(text ?? '');
  if (!ref) return ctx.prefill('/compare ');
  const def = defaultBranch(ctx.data.refs, ctx.data.remotes);
  const base = given ?? def?.ref;
  if (!base) return ctx.note(`Couldn't tell which branch is the default one. Say what to compare with: /compare ${ref} <base>`, 'error');
  if (base === ref || (!given && ref === def.name)) {
    return ctx.note(`${ref} is the default branch itself. To compare it with another branch: /compare ${ref} <base>`, 'error');
  }
  ctx.showCompare(ref, base);
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

/** Stashes one file from Changes, staged and unstaged changes alike, with its path as the message. */
export function stashFile(ctx, f) {
  if (!needRepo(ctx)) return;
  if (f.area === 'conflict') return ctx.note(`${f.path} has conflicts, which can't be stashed. Resolve it first (space marks it resolved).`, 'error');
  // With a path, git stash can't find a file that only the last commit has: the old side of a rename, a staged deletion.
  if (f.kind === 'renamed' || (f.area === 'staged' && f.x === 'D')) {
    return ctx.note(`git can't stash a staged ${f.kind === 'renamed' ? 'rename' : 'deletion'} on its own. Unstage it first (space), then stash it.`, 'error');
  }
  const untracked = f.kind === 'untracked' ? ['--include-untracked'] : [];
  return ctx.exec(['stash', 'push', ...untracked, '-m', f.path, '--', f.path], { label: 'Stashing' });
}

/**
 * Puts one file from a stash (`file` from stashFiles) into the working tree, as `git stash apply` would leave
 * it: a change unstaged, a file the stash added staged, an untracked file untracked. Asks before overwriting
 * uncommitted changes, and before deleting a file the stash deleted.
 */
export async function restoreStashFile(ctx, s, file) {
  if (!needRepo(ctx)) return;
  const { path } = file;
  const here = parseStatus(await ctx.git(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', path])).files;
  const dirty = here.length > 0;
  if (file.code === 'D') {
    if (!existsSync(join(ctx.data.root, path))) return ctx.note(`${path} is already gone here.`);
    const ok = await ctx.confirm({
      title: `${path} was deleted in ${s.ref}. Delete it here too?`,
      detail: dirty ? 'It has uncommitted changes, which would be lost.' : 'The last commit still has it.',
      options: YES_NO('Yes, delete it'),
      danger: dirty,
    });
    if (!ok) return;
    await rm(join(ctx.data.root, path), { force: true });
    ctx.note(`Deleted ${path}`);
    return ctx.reload();
  }
  if (dirty) {
    const ok = await ctx.confirm({
      title: `Overwrite ${path} with the copy in ${s.ref}?`,
      detail: `${path} has uncommitted changes, which would be lost.`,
      options: YES_NO('Yes, overwrite it'),
      danger: true,
    });
    if (!ok) return;
  }
  const args = file.untracked
    ? ['restore', `--source=${s.ref}^3`, '--worktree', '--', path]
    : file.code === 'A'
      ? ['checkout', s.ref, '--', path]
      : ['restore', `--source=${s.ref}`, '--worktree', '--', path];
  return ctx.exec(args, { label: 'Restoring' });
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

/**
 * The repository's default branch and the remote it's on: what the refs say (parse.js's defaultBranch),
 * else what the PR host says, as /pr asks it. `name` is null if neither knows.
 */
async function findDefaultBranch(ctx) {
  const { remotes, refs } = ctx.data;
  const def = defaultBranch(refs, remotes);
  if (def) return { name: def.name, remote: def.ref === def.name ? null : def.ref.slice(0, -def.name.length - 1) };
  const host = ctx.host();
  return { name: host ? await host.defaultBranch().catch(() => null) : null, remote: host?.remoteName ?? null };
}

/**
 * /cleanup: removes the linked worktrees with no uncommitted changes (pruning those whose folder is gone),
 * then deletes the local branches with no commits that exist only here: all on a remote, or merged into
 * the default branch. Lists them first and asks.
 */
export async function cleanUp(ctx) {
  if (!needRepo(ctx)) return;
  const { root, refs, remotes } = ctx.data;
  let plan;
  const read = await ctx.task(
    'Looking for branches and worktrees to clean up',
    async () => {
      const { name, remote } = await findDefaultBranch(ctx);
      const mergedRefs = name ? [name, remote && `${remote}/${name}`].filter((r) => refs.local.some((b) => b.name === r) || refs.remote.some((b) => b.name === r)) : [];
      plan = planCleanup(await readCleanup(root, { defaultBranch: name, mergedRefs, hasRemotes: remotes.length > 0 }));
      return { stdout: '', stderr: '' };
    },
    { label: 'Looking for things to clean up', refresh: false, quiet: true },
  );
  if (!read.ok) return read;
  if (!plan.worktrees.length && !plan.branches.length) {
    return ctx.note('Nothing to clean up: every other branch and worktree has something of yours on it.');
  }
  // The full list goes in the viewer, so the question stays short however much there is.
  ctx.showText('Clean up: what goes and what stays', cleanupText(plan, root));
  const choice = await ctx.confirm({
    title: `Delete ${cleanupCount(plan)} with nothing of yours on them?`,
    detail: 'Listed above, with why. Branches that have commits only here, and worktrees with changes, stay.',
    options: cleanupOptions(plan),
    danger: true,
  });
  ctx.closeOverlay();
  if (!choice) return;
  const { worktrees, branches } = cleanupChoice(plan, choice);
  const problems = [];
  const removed = new Set();
  let stopped = false;
  const step = async (args, label, opts) => {
    const r = await ctx.exec(args, { label, refresh: false, ...opts });
    if (r.error?.cancelled) stopped = true;
    return r;
  };
  if (worktrees.some((w) => w.prune)) {
    const r = await step(['worktree', 'prune'], 'Pruning worktrees');
    for (const w of worktrees.filter((x) => x.prune)) {
      if (r.ok) removed.add(w.path);
      else problems.push(`${w.path}: ${firstLine(r.error.message)}`);
    }
  }
  // Plain remove: it refuses to lose changes, should any have appeared since the list was made.
  for (const w of worktrees.filter((x) => !x.prune)) {
    if (stopped) break;
    const r = await step(['worktree', 'remove', w.path], 'Removing worktree');
    if (r.ok) removed.add(w.path);
    else problems.push(`${w.path}: ${firstLine(r.error.message)}`);
  }
  // A branch whose worktree couldn't go is still checked out there, so it stays too.
  const names = branches.filter((b) => !b.worktree || removed.has(b.worktree)).map((b) => b.name);
  let message = '';
  if (names.length && !stopped) {
    const r = await step(['branch', '-d', ...names], 'Deleting branches', { quietError: true });
    // -d also wants each branch merged into HEAD (or its upstream). These were checked against the
    // remotes and the default branch instead, so the ones it refuses for that alone are forced.
    message = r.ok ? '' : r.error.message;
    const refused = names.filter((n) => message.includes(`'${n}' is not fully merged`));
    if (refused.length && !stopped) await step(['branch', '-D', ...refused], 'Deleting branches');
  }
  await ctx.reload();
  const left = new Set(ctx.data.refs.local.map((b) => b.name));
  const deleted = names.filter((n) => !left.has(n));
  for (const b of branches) {
    if (!left.has(b.name)) continue;
    if (!names.includes(b.name)) problems.push(`${b.name}: kept, as its worktree is still there`);
    else if (!stopped) {
      const line = message.split('\n').find((l) => l.includes(`'${b.name}'`) && !/not fully merged|^hint:/.test(l));
      problems.push(`${b.name}: ${line ? line.replace(/^error:\s*/, '') : 'not deleted'}`);
    }
  }
  const done = cleanupCount({ worktrees: [...removed], branches: deleted });
  const head = stopped ? `Stopped${done ? ` after ${done}` : ''}` : done ? `Cleaned up ${done}` : 'Nothing was cleaned up';
  const lines = [...(deleted.length ? [`Deleted ${deleted.join(', ')}`] : []), ...problems];
  ctx.note([head, ...lines].join('\n'), problems.length || stopped ? 'error' : 'ok');
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

/**
 * Keeps a copy of what a discard is about to throw away, for z (see undo.js). Resolves with the copy,
 * null to discard without one (asked first, when keeping it failed), or false to stop.
 */
async function keepForUndo(ctx, opts) {
  try {
    return await captureDiscard(ctx.data.root, ctx.data.gitDir, opts);
  } catch (e) {
    const ok = await ctx.confirm({
      title: "Couldn't keep a copy to undo with. Discard anyway?",
      detail: `Without one this can't be undone. (${e.message.split('\n')[0]})`,
      options: YES_NO('Yes, discard for good'),
      danger: true,
    });
    return ok ? null : false;
  }
}

/**
 * Records the copy once the discard went through (`r` ok or absent), or throws it away if it didn't.
 * The discard's own commands run with `refresh: false`: this reloads after recording, so z can't come too soon.
 */
async function settleCopy(ctx, copy, r) {
  if (copy && r && !r.ok) await forgetCapture(ctx.data.gitDir, copy);
  else if (copy) await saveDiscard(ctx.data.gitDir, copy);
  await ctx.reload();
  return r;
}

export async function discard(ctx, f) {
  const untracked = f.kind === 'untracked';
  // A folder listed as one untracked entry is a repository of its own, which Splice doesn't copy.
  const folder = untracked && f.path.endsWith('/');
  const ok = await ctx.confirm({
    title: `Discard ${f.area === 'staged' ? 'all changes' : 'unstaged changes'} to ${f.path}?`,
    detail: folder ? "It's untracked, so it will be deleted. This can't be undone." : untracked ? 'The file is untracked, so it will be deleted. z brings it back.' : 'z brings them back.',
    options: YES_NO('Yes, discard'),
    danger: true,
  });
  if (!ok) return;
  const copy = folder
    ? null
    : await keepForUndo(ctx, untracked
      ? { what: `the deleted file ${f.path}`, untracked: [f.path] }
      : { what: `the ${f.area === 'staged' ? '' : 'unstaged '}changes to ${f.path}`, paths: paths(f).slice(1), staged: f.area === 'staged' });
  if (copy === false) return;
  if (untracked) {
    await rm(join(ctx.data.root, f.path), { force: true, recursive: true });
    ctx.note(`Deleted ${f.path}`);
    return settleCopy(ctx, copy);
  }
  const args = f.area === 'staged' ? ['restore', '--staged', '--worktree', ...paths(f)] : ['restore', ...paths(f)];
  return settleCopy(ctx, copy, await ctx.exec(args, { label: 'Discarding', refresh: false }));
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
    detail: `${untracked ? 'Untracked files are deleted. ' : ''}z brings it all back, untracked files included.`,
    options: [
      { label: 'Yes, discard everything', value: 'all' },
      ...(untracked && tracked ? [{ label: 'Discard, but keep the untracked files', value: 'tracked' }] : []),
      { label: 'No', value: null },
    ],
    danger: true,
  });
  if (!choice) return;
  const gone = choice === 'all' ? files.length : tracked;
  const copy = await keepForUndo(ctx, {
    what: `the changes to ${gone} ${gone === 1 ? 'file' : 'files'}`,
    staged: true,
    untracked: choice === 'all' ? files.filter((f) => f.kind === 'untracked').map((f) => f.path) : [],
  });
  if (copy === false) return;
  const steps = [];
  // Before the first commit there is no HEAD to reset to: remove what's staged, files included.
  if (tracked) steps.push(isInitial(ctx) ? ['rm', '-r', '-f', '-q', '.'] : ['reset', '--hard', '-q']);
  if (untracked && choice === 'all') steps.push(['clean', '-f', '-d', '-q']);
  let r;
  for (const [i, args] of steps.entries()) {
    r = await ctx.exec(args, { label: 'Discarding', refresh: false });
    // A failed first step discarded nothing; after that, what's gone is worth keeping.
    if (!r.ok) {
      await settleCopy(ctx, copy, i === 0 ? r : undefined);
      return r;
    }
  }
  return settleCopy(ctx, copy, r);
}

/** Takes one side of a conflicted file and marks it resolved. */
export async function resolveWith(ctx, f, side) {
  const r = await ctx.exec(['checkout', `--${side}`, '--', f.path], { refresh: false, quiet: true });
  if (r.ok) return ctx.exec(['add', '--', f.path], { quiet: true });
}

const SIDE_NAMES = { ours: 'ours', theirs: 'theirs', both: 'both sides' };

/**
 * Takes one side ("ours", "theirs" or "both") of conflict block `index` in a conflicted file, rewriting
 * the working file and leaving it unstaged. `seen` is the file's content as shown (a Buffer): if the
 * file has changed since, it's left alone. Resolves with { buf, left } (the new content, the blocks
 * still in it), or null.
 */
export async function resolveBlock(ctx, f, seen, index, side) {
  const full = join(ctx.data.root, f.path);
  try {
    const buf = await readFile(full);
    if (!buf.equals(seen)) {
      ctx.note(`${f.path} changed on disk, so nothing was taken. Here it is again.`, 'error');
      ctx.reload();
      return null;
    }
    // Bytes one to one, so a file in any encoding comes back as it was outside the block.
    const next = takeSide(buf.toString('latin1'), index, side);
    if (next == null) return null;
    const out = Buffer.from(next, 'latin1');
    await writeFile(full, out);
    const left = parseConflicts(next).blocks.length;
    if (!left) ctx.note(`No conflicts left in ${f.path}: space marks it resolved`);
    ctx.reload();
    return { buf: out, left };
  } catch (e) {
    ctx.note(`Couldn't take ${SIDE_NAMES[side]} in ${f.path}: ${e.message.split('\n')[0]}`, 'error');
    return null;
  }
}

const apply = (ctx, patch, flags, label, opts) =>
  ctx.exec(['apply', ...flags, '--recount', '--whitespace=nowarn', '-'], { input: patch, quiet: true, label, ...opts });

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
      detail: 'z brings them back.',
      options: [{ label: 'Yes, discard', value: true }, { label: 'No', value: false }],
      danger: true,
    });
    if (!ok) return;
    const patch = buildPatch(diff, picks, { reverse: true });
    // Applied forwards, the same patch puts back what applying it in reverse takes out.
    const copy = await keepForUndo(ctx, { what: `the discarded ${all ? 'changes' : 'lines'} in ${f.path}`, patch });
    if (copy === false) return;
    return settleCopy(ctx, copy, await apply(ctx, patch, ['--reverse'], 'Discarding', { refresh: false }));
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

/**
 * F in Changes, /fixup [ref]: the staged changes become a fixup! commit for an earlier commit,
 * then (if you say so) an autosquash rebase folds it in. Without a ref, a picker offers the branch's commits.
 */
export async function fixup(ctx, ref) {
  if (!needRepo(ctx)) return;
  const { state } = ctx.data;
  if (state) return ctx.note(`A ${OP[state]} is in progress. Finish it first (/continue or /abort), then make the fixup.`, 'error');
  const { branch } = ctx.data.status;
  if (isInitial(ctx)) return ctx.note('There are no commits yet to fix up.', 'error');
  if (!branch.head) return ctx.note('HEAD is detached. Folding a fixup in rewrites a branch, so check one out first.', 'error');
  const { staged, unstaged, conflicts } = ctx.data.changes;
  if (conflicts.length) return ctx.note('Resolve the conflicts first (space marks a file resolved).', 'error');
  let stageAll = false;
  if (!staged.length) {
    if (!unstaged.length) return ctx.note('Nothing to fix up with: the working tree is clean.', 'error');
    const ok = await ctx.confirm({
      title: 'Nothing is staged. Stage all changes for the fixup?',
      options: YES_NO('Yes, stage everything'),
    });
    if (!ok) return;
    stageAll = true;
  }
  if (ref) {
    let target;
    try {
      [target] = parseCommitList(await ctx.git(['log', '-1', `--format=${COMMIT_LIST_FORMAT}`, ref, '--']));
    } catch {
      // Not a commit; said below.
    }
    if (!target) return ctx.note(`No commit called ${ref}.`, 'error');
    const ours = await ctx.git(['merge-base', '--is-ancestor', target.hash, 'HEAD']).then(() => true, () => false);
    if (!ours) return ctx.note(`${ref} isn't part of ${branch.head}'s history, so a fixup couldn't be folded into it.`, 'error');
    return fixupInto(ctx, target, { stageAll });
  }
  ctx.showPicker({
    title: `Fix up which commit on ${branch.head}?`,
    hint: '↵ fix it up with the staged changes',
    empty: 'No commits to fix up.',
    load: () => fixupCandidates(ctx),
    onPick: (c) => {
      ctx.closeOverlay();
      return fixupInto(ctx, c, { stageAll });
    },
  });
}

/** The branch's commits that aren't on its upstream or the default branch yet; failing that, the latest 30. */
async function fixupCandidates(ctx) {
  const { status, refs, remotes } = ctx.data;
  const { branch } = status;
  const exclude = fixupExclusions({
    head: branch.head,
    upstream: branch.upstream,
    def: defaultBranch(refs, remotes),
    local: refs.local.map((b) => b.name),
  });
  let list = exclude.length ? parseCommitList(await ctx.git(fixupLogArgs(exclude))) : [];
  if (!list.length) list = parseCommitList(await ctx.git(fixupLogArgs([])));
  return list.map((c) => ({
    ...c,
    segments: [
      { text: c.hash.slice(0, 7), color: theme.warn },
      { text: ` ${fit(relTime(c.time), 4, 'right')}  `, color: theme.dim },
      { text: c.subject, strong: true },
    ],
  }));
}

async function fixupInto(ctx, target, { stageAll }) {
  if (stageAll && !(await ctx.exec(['add', '-A'], { refresh: false, quiet: true })).ok) return;
  const made = await ctx.exec(['commit', `--fixup=${target.hash}`], { label: 'Committing the fixup' });
  if (!made.ok) return made;
  const later = `Kept "fixup! ${target.subject}" as its own commit for now.\nTo fold it in later: i on ${short(target.hash)} in the graph, J to move the fixup! commit just above it, f to fix up, ↵.`;
  // Without --rebase-merges a rebase flattens merges, and with it a merge can conflict all over again.
  const merges = Number((await ctx.git(['rev-list', '--count', '--min-parents=2', `${target.hash}..HEAD`]).catch(() => '0')).trim());
  if (merges) return ctx.note(`There are merge commits after "${target.subject}", which folding the fixup in would flatten.\n${later}`);
  // Already on a remote branch means folding rewrites history others may have.
  const onRemotes = (await ctx.git(['for-each-ref', '--contains', target.hash, '--format=%(refname:short)', 'refs/remotes']).catch(() => ''))
    .split('\n')
    .filter((r) => r && !r.endsWith('/HEAD'));
  const { upstream } = ctx.data.status.branch;
  const pushedTo = onRemotes.includes(upstream) ? upstream : onRemotes[0];
  // Other changes to tracked files would stop the rebase; set aside, they come back when it's done.
  const autostash = ctx.data.status.files.some((f) => f.kind !== 'untracked');
  const fold = await ctx.confirm({
    title: `Fold it into "${target.subject}" now?`,
    detail: pushedTo
      ? `${short(target.hash)} is already on ${pushedTo}: folding rewrites pushed history, so you'd need /push --force afterwards.`
      : `Rewrites the commits since ${short(target.hash)} (an autosquash rebase)${autostash ? '; other changes are stashed meanwhile' : ''}.`,
    options: [
      { label: 'Yes, fold it in', value: true },
      { label: 'No, keep the fixup! commit for later', value: false },
    ],
    danger: Boolean(pushedTo),
  });
  if (!fold) return ctx.note(later);
  // GIT_EDITOR is already `true`; this also beats a sequence.editor in the user's config. The todo is taken as autosquash ordered it.
  const r = await ctx.exec(foldArgs(target, { autostash }), { label: 'Folding the fixup in', env: { GIT_SEQUENCE_EDITOR: 'true' } });
  if (ctx.data.state) {
    if (ctx.data.changes.conflicts.length) afterConflicts(ctx);
    else ctx.note('The rebase stopped. /continue carries on, /abort puts everything back.', 'error');
  }
  return r;
}

/**
 * /find: plain text filters the loaded commits; -S <text> and -G <regex> search the whole history
 * for commits whose changes add or remove the text, or have lines matching the regex.
 */
export async function find(ctx, text) {
  const { mode, query } = findArgs(text);
  if (mode === 'text') return ctx.find(query);
  if (!needRepo(ctx)) return;
  if (!query) return ctx.prefill(`/find -${mode} `);
  let rows = [];
  const r = await ctx.task(
    `git log -${mode} ${JSON.stringify(query)} --all`,
    async (signal) => {
      rows = parseGraph(await ctx.git(searchArgs(mode, query), { signal })).filter((row) => row.commit);
      return { stdout: rows.length ? `${rows.length} commit${rows.length === 1 ? '' : 's'}` : 'No commits', stderr: '' };
    },
    { label: 'Searching the history', refresh: false },
  );
  if (r.ok) ctx.find({ mode, query, rows });
  return r;
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
  ctx.showText(`Pull request draft: ${branch.head} → ${target}`, `${title}\n\n${body}`, { markdown: true });
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
  if (r.ok) ctx.showText(`${mode === 'explain' ? 'Claude explains' : 'Claude reviews'} ${what}`, r.out, { markdown: true });
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

// The commit on the other side of a conflict, by operation; a stash leaves none of these.
const THEIRS = { merging: 'MERGE_HEAD', rebasing: 'REBASE_HEAD', 'cherry-picking': 'CHERRY_PICK_HEAD', reverting: 'REVERT_HEAD' };

/** Both sides of the conflicts in progress, as { ref, message } (null when there's no such commit). */
async function conflictSides(ctx) {
  const message = (ref) => ctx.git(['log', '-1', '--format=%h %s%n%n%b', ref, '--']).then((s) => s.trim() || null, () => null);
  const ours = await message('HEAD');
  let theirs = null;
  for (const ref of new Set([THEIRS[ctx.data.state], ...Object.values(THEIRS)].filter(Boolean))) {
    const m = await message(ref);
    if (m) {
      theirs = { ref, message: m };
      break;
    }
  }
  return { ours: ours && { ref: 'HEAD', message: ours }, theirs };
}

/**
 * Claude proposes the whole resolved file for a conflicted file. The proposal opens as a diff against
 * the file as it is, then asks before writing it (with the file's line endings, unstaged).
 */
export async function claudeResolve(ctx, f) {
  if (!needClaude(ctx)) return;
  const full = join(ctx.data.root, f.path);
  let current;
  try {
    current = await readFile(full, 'utf8');
  } catch {
    return ctx.note(`${f.path} isn't in the working tree (one side deleted it), so there's nothing to merge. O or T takes a side.`, 'error');
  }
  if (!parseConflicts(current).blocks.length) return ctx.note(`No conflict markers in ${f.path}: space marks it resolved, or O/T takes a side.`, 'error');
  const { ours, theirs } = await conflictSides(ctx);
  const input = resolveInput({ path: f.path, state: ctx.data.state, ours, theirs, text: current });
  // A cut-off file can't come back whole.
  if (clip(input) !== input) return ctx.note(`${f.path} is too big to send to Claude whole.`, 'error');
  const r = await askClaude(ctx, `resolve ${f.path}`, resolvePrompt(f.path), input, READ_ONLY);
  if (!r.ok) return r;
  const answer = parseResolution(r.out);
  if (answer.error) {
    ctx.note(answer.error, 'error');
    return r;
  }
  const proposed = matchLineEndings(answer.text, current);
  const title = `Claude's resolution of ${f.path}`;
  const diff = unifiedDiff(current, proposed, f.path);
  let choice;
  for (;;) {
    let closed;
    const done = new Promise((resolve) => (closed = resolve));
    ctx.showText(title, diff, { diff: true, onClosed: closed });
    choice = await ctx.confirm({
      title: `Use Claude's resolution for ${f.path}?`,
      detail: "Writes it to the file, not staged: look it over, then space marks it resolved.",
      options: [
        { label: 'Yes, write it', value: true },
        { label: 'No', value: false },
        { label: 'Scroll through the diff first (esc comes back here)', value: 'read' },
      ],
    });
    if (choice !== 'read') break;
    await done;
  }
  ctx.closeOverlay();
  if (!choice) return r;
  try {
    // Claude took a while: don't overwrite edits made meanwhile.
    if ((await readFile(full, 'utf8')) !== current) {
      ctx.note(`${f.path} changed while Claude was working on it, so it was left alone. C asks again.`, 'error');
      return r;
    }
    await writeFile(full, proposed);
  } catch (e) {
    ctx.note(`Couldn't write ${f.path}: ${e.message.split('\n')[0]}`, 'error');
    return r;
  }
  ctx.note(`Wrote Claude's resolution to ${f.path}: look it over, then space marks it resolved`);
  ctx.reload();
  return r;
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

/** H on a file, or /history <path>: the commits that touched it, following renames. Works for deleted files too. */
export function fileHistory(ctx, typed) {
  if (!needRepo(ctx)) return;
  const path = repoPath(ctx.data.root, typed);
  if (!path) return ctx.prefill('/history ');
  ctx.showPicker(historyPicker(ctx, path));
}

/** B on a file, or /blame <path>: who last changed each line of the working-tree version. */
export function blame(ctx, typed) {
  if (!needRepo(ctx)) return;
  const path = repoPath(ctx.data.root, typed);
  if (!path) return ctx.prefill('/blame ');
  ctx.showPicker(blamePicker(ctx, path));
}

/** `!<args>`: any git command. Output longer than a few lines opens in the viewer. */
export async function raw(ctx, text) {
  const args = splitArgs(text);
  if (args[0] === 'git') args.shift();
  if (!args.length) return ctx.note('Type a git command after !, for example: !log --stat -3', 'error');
  const r = await ctx.exec(args, { label: `git ${args[0]}`, anywhere: true });
  if (r.ok && r.out.split('\n').length > 3) ctx.showText(`git ${text.replace(/^git\s+/, '')}`, r.out, { diff: /^(@@|diff --git)/m.test(r.out) });
}

const readReflog = async (ctx, ref, n) =>
  parseReflog(await ctx.git(['log', '-g', `-n${n}`, '--date=unix', `--format=${REFLOG_FORMAT}`, ref, '--']).catch(() => ''));

const isAncestor = (ctx, a, b) => ctx.git(['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);

/**
 * z and /undo: takes back the last thing that moved HEAD or the current branch (from the reflog),
 * or the last discard, whichever came later. Always asks first, saying what will happen.
 */
export async function undo(ctx) {
  if (!needRepo(ctx)) return;
  const { state, gitDir, root } = ctx.data;
  const { branch } = ctx.data.status;
  if (state) return ctx.note(`A ${OP[state]} is in progress: /abort puts things back the way they were before it.`, 'error');
  const [head, own, discards] = await Promise.all([
    readReflog(ctx, 'HEAD', 100),
    branch.head ? readReflog(ctx, `refs/heads/${branch.head}`, 2) : null,
    readDiscards(gitDir),
  ]);
  const plan = planUndo({ head, branch: own, branchName: branch.head, oid: branch.oid, discard: discards.at(-1) });
  if (plan.kind === 'none') return ctx.note(`Nothing to undo: ${plan.why}`, 'error');
  // Something that leaves the branch is already pushed when the branch and its upstream meet past the target.
  let pushed = null;
  if (plan.kind === 'reset' && plan.branch && branch.upstream) {
    const base = (await ctx.git(['merge-base', 'HEAD', '@{upstream}']).catch(() => '')).trim();
    if (base && !(await isAncestor(ctx, base, plan.target))) pushed = branch.upstream;
  }
  const { title, detail, yes } = describeUndo(plan, { pushed });
  if (!(await ctx.confirm({ title, detail, options: YES_NO(yes), danger: !!pushed }))) return;
  if (plan.kind === 'switch') return checkout(ctx, plan.from);
  // Deleting the branch's ref leaves the index alone, so the first commit's files stay staged.
  if (plan.kind === 'unborn') return ctx.exec(['update-ref', '-d', `refs/heads/${plan.branch}`, plan.entry.hash], { label: 'Undoing' });
  if (plan.kind === 'reset') {
    // --keep refuses rather than overwrite uncommitted changes; the reflog notes it as an undo, so z can redo it.
    return ctx.exec(['reset', `--${plan.mode}`, plan.target], { label: 'Undoing', env: { GIT_REFLOG_ACTION: reflogActionFor(plan) } });
  }
  return restoreDiscard(ctx, root, gitDir, plan.discard);
}

async function restoreDiscard(ctx, root, gitDir, d) {
  const back = await untrackedInTheWay(root, d).catch(() => []);
  if (back.length) {
    const names = `${back.slice(0, 3).join(', ')}${back.length > 3 ? ` and ${back.length - 3} more` : ''}`;
    return ctx.note(`Can't bring the files back: ${names} exist${back.length === 1 ? 's' : ''} again. Move them aside first.`, 'error');
  }
  const steps = restoreSteps(gitDir, d);
  let r;
  for (const s of steps) {
    r = await ctx.exec(s.args, { label: 'Bringing back', env: s.env, refresh: false });
    if (!r.ok) break;
  }
  for (const s of steps) if (s.env) await rm(s.env.GIT_INDEX_FILE, { force: true });
  // On failure the copy stays, so z can try again once whatever was in the way is gone.
  if (r.ok) await dropDiscard(gitDir, d.id);
  await ctx.reload();
  return r;
}

/** /reflog: everywhere HEAD has been, in a picker. ↵ shows the commit, X resets the branch to it, c checks it out. */
export function showReflog(ctx) {
  if (!needRepo(ctx)) return;
  const done = (r) => r?.ok && ctx.closeOverlay();
  ctx.showPicker({
    title: 'Reflog: where HEAD has been',
    hint: '↵ diff · X reset to it · c check out',
    empty: "HEAD's reflog is empty.",
    load: async () => {
      const now = Date.now() / 1000;
      return (await readReflog(ctx, 'HEAD', 500)).map((e, i) => ({
        ...e,
        selector: `HEAD@{${i}}`,
        segments: [
          { text: e.hash.slice(0, 7), color: theme.warn },
          { text: ` ${fit(relTime(e.time, now), 4, 'right')}`, color: theme.dim },
          { text: `  ${fit(reflogLabel(e), 14)}`, color: theme.hunk },
          { text: e.ref ? `${e.ref}: ${e.message}` : e.message, strong: true },
        ],
      }));
    },
    onPick: (e) => ctx.showPatch({ hash: e.hash, subject: e.subject }),
    keys: {
      X: async (e) => done(await reset(ctx, e.hash, `${e.selector} (${short(e.hash)})`)),
      c: async (e) => {
        // Like c in the graph: a branch pointing at it rather than a detached HEAD, when there is one.
        const row = ctx.data.graph.find((g) => g.commit?.hash === e.hash);
        done(await (row ? checkoutCommit(ctx, row.commit) : checkout(ctx, e.hash)));
      },
    },
  });
}

/** `/settings` and `,`: every setting in a list, changed in place and saved as it changes. */
export function settings(ctx, { replace = false, index } = {}) {
  ctx.showPicker(
    {
      title: 'Settings',
      hint: '↵ change',
      index,
      items: () => settingRows(ctx.config, { file: configFile(), mouse: ctx.mouseAvailable }).map((row) => ({ ...row, segments: settingSegments(row) })),
      redraw: (at) => settings(ctx, { replace: true, index: at }),
      onPick: (row) => changeSetting(ctx, row),
    },
    { replace },
  );
}

/** Redraws the settings list (or its folders) after a change, if it's on screen. */
export function redrawSettings(ctx) {
  const o = ctx.overlay();
  if (o?.redraw) o.redraw(o.index);
}

async function changeSetting(ctx, row) {
  if (row.action === 'toggle') {
    ctx.setConfig((c) => ({ ...c, [row.id]: c[row.id] === false }));
    return redrawSettings(ctx);
  }
  if (row.action === 'accent') return ctx.prefill(`/accent ${ctx.config.accent ?? DEFAULT_ACCENT}`);
  if (row.action === 'roots') return scanFolders(ctx);
  if (row.action === 'clear') {
    const ok = await ctx.confirm({
      title: row.id === 'recent' ? `Forget the ${row.value}?` : `Clear the prompt history (${row.value})?`,
      detail: row.id === 'recent' ? 'Only the list is cleared; the repositories stay where they are.' : undefined,
      options: YES_NO(row.id === 'recent' ? 'Yes, forget them' : 'Yes, clear it'),
    });
    if (!ok) return;
    ctx.setConfig((c) => ({ ...c, [row.id]: [] }));
    redrawSettings(ctx);
  }
}

/** The folders scanned for repositories, from /settings: x stops scanning one, s adds one. */
function scanFolders(ctx, { replace = false, index } = {}) {
  ctx.showPicker(
    {
      title: 'Folders to scan for repositories',
      hint: 'x remove · s add a folder',
      empty: 'No folders yet. s adds one (or /scan <folder>).',
      index,
      items: () => (ctx.config.roots ?? []).map((path) => ({ path, segments: [{ text: path }] })),
      redraw: (at) => scanFolders(ctx, { replace: true, index: at }),
      keys: {
        x: (it) => {
          ctx.setConfig((c) => ({ ...c, roots: c.roots.filter((r) => r !== it.path) }));
          redrawSettings(ctx);
        },
      },
      actions: { s: () => ctx.prefill('/scan ') },
    },
    { replace },
  );
}

/** `/accent <#rrggbb | default>`: the accent colour, saved and repainted straight away. */
export function accent(ctx, text) {
  const value = (text ?? '').trim();
  if (!value) return ctx.prefill(`/accent ${ctx.config.accent ?? DEFAULT_ACCENT}`);
  if (value !== 'default' && !isColour(value)) return ctx.note(`${value} isn't a colour. Give one as #rrggbb (like ${DEFAULT_ACCENT}), or default.`, 'error');
  const colour = value === 'default' ? null : value.toLowerCase();
  setAccent(colour);
  ctx.setConfig(({ accent: _, ...rest }) => (colour ? { ...rest, accent: colour } : rest));
  redrawSettings(ctx);
}
