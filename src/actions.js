// Every git operation the UI offers, written once. Keys and slash commands both call these.
// `ctx` is the app's handle: data, exec, confirm, note, prefill, and so on (see App.jsx).
import { existsSync, realpathSync, statSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { READ_ONLY, blameInput, blamePrompt, clip, commitPrompt, lookPrompt, parseCommitMessage, parsePrDraft, parseResolution, parseSplit, prPrompt, resolveInput, resolvePrompt, splitInput, splitPrompt } from './claude.js';
import { absorbFiles, absorbSummary, absorbText, blameMap, blameTargets, groupPatch, lineRanges, planAbsorb } from './absorb.js';
import { cleanupChoice, cleanupCount, cleanupOptions, cleanupText, planCleanup, readCleanup } from './cleanup.js';
import { configFile } from './config.js';
import { droppedPaths, insideRepo } from './drop.js';
import { matchLineEndings, parseConflicts, takeSide, unifiedDiff } from './conflict.js';
import { blamePicker, historyPicker, lineLogArgs, linesRange, repoPath } from './history.js';
import { commentChar, messageFileText, readMessage } from './message.js';
import { MERGE_LABELS, bodyArgs, mergePrArgs, releaseArgs } from './hosting.js';
import { defaultBranch, filterArgs, parseBlame, filterLabel, filterLogArgs, findArgs, firstBadCommit, parseLog, parseNameStatus, parseStatus, relTime, remoteArgs, searchArgs, splitArgs, stashArgs, upstreamArgs } from './parse.js';
import { buildPatch, coversAll, parseDiff, picksBySignature, splitUnits } from './patch.js';
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
import { eachLimited, fetchRepo } from './repos.js';
import { settingRows, settingSegments } from './settings.js';
import { SIGNING_KEYS, checkGpgKey, explainSigning, needsPinentryCheck, signingConfig } from './signing.js';
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

/**
 * F in Repos: fetches every listed repository, four at a time, then each row shows how far it is ahead
 * and behind its upstream. A repository that can't be fetched says why on its row, and the rest carry
 * on; esc stops the lot (what's fetched stays fetched).
 */
export function fetchRepos(ctx) {
  const list = ctx.repos;
  if (!list.length) return ctx.note('No repositories listed yet: /scan <folder> adds a folder of them.', 'error');
  const total = list.length;
  const plural = (n) => `${n} repositor${n === 1 ? 'y' : 'ies'}`;
  return ctx.task(
    `Fetch ${plural(total)}`,
    async (signal) => {
      ctx.setRepoFetch(null);
      let done = 0;
      const failed = [];
      ctx.setFetchProgress({ done, total });
      await eachLimited(
        list,
        4,
        async (r) => {
          if (signal.aborted) return null;
          ctx.setRepoFetch(r.path, { state: 'fetching' });
          return fetchRepo(r.path, signal).catch(() => null);
        },
        (r, res) => {
          // Not fetched (cancelled): the row goes back to how it was.
          if (!res) return ctx.setRepoFetch(r.path, undefined);
          done++;
          if (res.error) failed.push(`${r.name}: ${res.error}`);
          ctx.setRepoFetch(r.path, res.error ? { state: 'failed', error: res.error } : { state: 'done' }, res.summary);
          ctx.setFetchProgress({ done, total });
        },
      );
      ctx.setFetchProgress(null);
      if (signal.aborted) throw Object.assign(new Error(`Cancelled after fetching ${done} of ${total}`), { cancelled: true });
      const head = failed.length ? `Fetched ${done - failed.length} of ${plural(total)}; ${failed.length} couldn't be:` : `Fetched ${plural(total)}`;
      return { stdout: [head, ...failed].join('\n'), stderr: '' };
    },
    { label: 'Fetching repositories' },
  ).finally(() => ctx.setFetchProgress(null));
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
  const { remotes } = ctx.data;
  // A remote named among the arguments (/push upstream): the branch goes there, under its own name.
  const named = args.find((a) => remotes.includes(a));
  const flags = args.filter((a) => a !== named).map((a) => (a === '--force' || a === '-f' ? '--force-with-lease' : a));
  if (named && !(branch.upstream ?? '').startsWith(`${named}/`)) {
    if (flags.includes('--force-with-lease')) {
      const ok = await ctx.confirm({
        title: `Force-push ${branch.head} to ${named}?`,
        detail: `Replaces ${named}'s ${branch.head} with yours. Uses --force-with-lease, so it stops if someone else pushed.`,
        options: YES_NO('Yes, force-push'),
        danger: true,
      });
      if (!ok) return;
    }
    // Only a branch without an upstream starts tracking the remote it was pushed to.
    return ctx.exec(['push', ...flags, ...(branch.upstream ? [] : ['-u']), named, branch.head], { label: 'Pushing' });
  }
  if (!branch.upstream) {
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

/**
 * /remote: with nothing after it, the remotes in a picker (n add, R rename, x remove, p push the current branch
 * to one, f fetch it). /remote add <name> <url>, rename <old> <new>, remove <name>, set-url <name> <url>.
 */
export async function remote(ctx, text) {
  if (!needRepo(ctx)) return;
  const r = remoteArgs(text);
  if (r.error) return ctx.note(r.error, 'error');
  if (!r.args) return showRemotes(ctx);
  if (r.args[1] !== 'add' && !ctx.data.remotes.includes(r.name)) return ctx.note(`No remote called ${r.name}.`, 'error');
  if (r.remove) {
    const ok = await ctx.confirm({
      title: `Remove the remote ${r.name}?`,
      detail: `Forgets ${ctx.data.remoteUrls[r.name]} and its remote branches here; nothing changes on the server. Branches tracking it lose their upstream.`,
      options: YES_NO('Yes, remove it'),
      danger: true,
    });
    if (!ok) return;
  }
  const done = await ctx.exec(r.args, { label: 'Changing remotes' });
  if (done.ok) redrawRemotes(ctx);
  return done;
}

// Redraws the remotes picker after a change, if it's what's on screen.
function redrawRemotes(ctx) {
  if (ctx.overlay()?.remotes) showRemotes(ctx, { replace: true });
}

function showRemotes(ctx, { replace = false } = {}) {
  const { branch } = ctx.data.status;
  ctx.showPicker(
    {
      title: 'Remotes',
      hint: `n add · R rename · x remove · u set URL · f fetch${branch.head ? ` · p push ${branch.head} to it` : ''}`,
      empty: 'No remotes. n adds one.',
      remotes: true,
      items: () =>
        ctx.data.remotes.map((name) => ({
          name,
          segments: [{ text: name, color: theme.remote, bold: true, strong: true }, { text: `  ${ctx.data.remoteUrls[name] ?? ''}`, color: theme.dim }],
        })),
      keys: {
        R: (it) => ctx.prefill(`/remote rename ${it.name} `),
        x: (it) => remote(ctx, `remove ${it.name}`),
        u: (it) => ctx.prefill(`/remote set-url ${it.name} ${ctx.data.remoteUrls[it.name] ?? ''}`),
        f: (it) => fetch(ctx, [it.name, '--prune']),
        p: (it) => push(ctx, [it.name]),
        y: (it) => ctx.copy(ctx.data.remoteUrls[it.name] ?? '', `the URL of ${it.name}`),
      },
      actions: { n: () => ctx.prefill('/remote add ') },
    },
    { replace },
  );
}

/** U on a local branch in Branches, /upstream [branch] <remote/branch>, /upstream --unset [branch]. */
export function upstream(ctx, text) {
  if (!needRepo(ctx)) return;
  if (!(text ?? '').trim()) {
    const head = ctx.data.status.branch.head;
    const remote = ctx.data.remotes.includes('origin') ? 'origin' : ctx.data.remotes[0];
    return ctx.prefill(head && remote ? `/upstream ${head} ${remote}/${head}` : '/upstream ');
  }
  const u = upstreamArgs(text, ctx.data.status.branch.head);
  if (u.error) return ctx.note(u.error, 'error');
  if (!ctx.data.refs.local.some((b) => b.name === u.branch)) return ctx.note(`No local branch called ${u.branch}.`, 'error');
  if (u.upstream && !ctx.data.refs.remote.some((b) => b.name === u.upstream) && !ctx.data.refs.local.some((b) => b.name === u.upstream)) {
    return ctx.note(`There's no branch ${u.upstream} here. Fetch first (f), or push the branch there: /push <remote>`, 'error');
  }
  return ctx.exec(u.args, { label: 'Setting the upstream' });
}

/**
 * c in Changes, /commit and /amend. The message is typed (\n for a line break), or with --file <path>
 * read from a file (git leaves out its comment lines); --file alone writes one to edit first (editMessage).
 */
export async function commit(ctx, text, { amend = false } = {}) {
  if (!needRepo(ctx)) return;
  const typed = bodyArgs(text);
  if (typed.file === null) return editMessage(ctx, { amend });
  if (!typed.text && typed.file === undefined && !amend) return ctx.prefill('/commit ');
  const file = typed.file && resolve(ctx.data.root, typed.file);
  if (file) {
    let written;
    try {
      written = await readFile(file, 'utf8');
    } catch (e) {
      return ctx.note(`Couldn't read ${file}: ${firstLine(e.message)}`, 'error');
    }
    if (!readMessage(written, await commentFor(ctx))) {
      ctx.note(`The message is empty, so nothing was ${amend ? 'amended' : 'committed'}.\nWrite one in ${file}, save it, then press enter here.`, 'error');
      return ctx.prefill(`/${amend ? 'amend' : 'commit'} --file ${file}`);
    }
  }
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
  const signing = await readySigning(ctx);
  if (signing === false) return;
  const how = file ? ['--cleanup=strip', '-F', file] : typed.text ? ['-m', typed.text] : ['--no-edit'];
  const r = await ctx.exec(['commit', ...(amend ? ['--amend'] : []), ...how], {
    label: `${signing ? 'Signing and ' : ''}${amend ? 'amending' : 'committing'}`.replace(/^./, (c) => c.toUpperCase()),
  });
  // A message file Splice wrote has done its job.
  if (r.ok && file && [false, true].some((a) => messagePath(ctx, a) === file)) await rm(file, { force: true });
  return r;
}

// The files the message for a commit, or an amend, is written to for editing (one each, so neither overwrites the other).
const messagePath = (ctx, amend) => join(ctx.data.gitDir, amend ? 'splice-amend-message.txt' : 'splice-commit-message.txt');
const commentFor = async (ctx) => commentChar(await ctx.git(['config', '--get', 'core.commentChar']).catch(() => ''));

/** What an amended commit will hold: HEAD's changes with the staged ones, from its parent (all files for a first commit). */
async function amendFiles(ctx) {
  try {
    return parseNameStatus(await ctx.git(['diff', '--cached', '--name-status', '-M', 'HEAD^', '--']));
  } catch {
    return (await ctx.git(['ls-files', '-z']).catch(() => '')).split('\0').filter(Boolean).map((path) => ({ code: 'A', path }));
  }
}

/**
 * M in Changes, /commit --file and /amend --file alone: writes the message to a file in .git, for you to
 * edit in your own editor (Splice never opens one), and puts /commit --file <it> in the prompt to commit
 * once saved. It starts from `message`, else (for an amend) the commit's own message, else what an earlier
 * one left in the file; commented lines below list what will be committed.
 */
export async function editMessage(ctx, { amend = false, message = '' } = {}) {
  if (!needRepo(ctx)) return;
  if (amend && isInitial(ctx)) return ctx.note('There is no commit to amend yet.', 'error');
  const file = messagePath(ctx, amend);
  const comment = await commentFor(ctx);
  let start = message.trim();
  // An amend starts from the commit as it is now, which an old file may no longer match.
  if (!start && amend) start = (await ctx.git(['log', '-1', '--format=%B']).catch(() => '')).trim();
  if (!start) start = readMessage(await readFile(file, 'utf8').catch(() => ''), comment);
  const files = amend ? await amendFiles(ctx) : ctx.data.changes.staged;
  try {
    await writeFile(file, messageFileText({ message: start, files, amend, comment }));
  } catch (e) {
    return ctx.note(`Couldn't write ${file}: ${firstLine(e.message)}`, 'error');
  }
  ctx.note(`Wrote the ${amend ? "amended commit's" : 'commit'} message to ${file}\nEdit it in your editor and save, then press enter here to ${amend ? 'amend' : 'commit'}.`);
  return ctx.prefill(`/${amend ? 'amend' : 'commit'} --file ${file}`);
}

/**
 * Before a commit: the signing settings when commit.gpgsign is on (null when it's off), or false when the key
 * can't be used without typing its passphrase into a terminal, which git doesn't have here (said in a note).
 */
async function readySigning(ctx) {
  const cfg = signingConfig(await ctx.git(['config', '--get-regexp', SIGNING_KEYS]).catch(() => ''));
  if (!cfg.commits) return null;
  if (!needsPinentryCheck(cfg)) return cfg;
  try {
    await checkGpgKey(cfg, { cwd: ctx.data.root });
    return cfg;
  } catch (e) {
    ctx.note(`${explainSigning('gpg failed to sign the data')}\n${firstLine(e.message)}`, 'error');
    return false;
  }
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
  if (tags.some((t) => t.name === name)) return deleteTag(ctx, name);
  ctx.note(`No branch or tag called ${name}.`, 'error');
}

/** The remote tags are pushed to: origin, else the first one. */
function mainRemote(ctx) {
  const { remotes } = ctx.data;
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
}

/** Deletes a tag here, on the main remote, or both, as asked. */
async function deleteTag(ctx, name) {
  const remote = mainRemote(ctx);
  const where = await ctx.confirm({
    title: `Delete the tag ${name}?`,
    detail: remote ? `Deleting it on ${remote} removes it for everyone; their copies stay until they prune.` : 'The commit it points at stays.',
    options: [
      { label: 'Delete it here', value: 'local' },
      ...(remote
        ? [
            { label: `Delete it here and on ${remote}`, value: 'both' },
            { label: `Delete it only on ${remote}`, value: 'remote' },
          ]
        : []),
      { label: 'No', value: null },
    ],
    danger: true,
  });
  if (!where) return;
  let r;
  if (where !== 'local') {
    r = await ctx.exec(['push', remote, '--delete', `refs/tags/${name}`], { label: 'Deleting the tag on the remote', refresh: where === 'remote' });
    if (!r.ok) return r;
  }
  if (where !== 'remote') r = await ctx.exec(['tag', '-d', name], { label: 'Deleting tag' });
  return r;
}

/** u on a tag in Branches, /tag-push <tag> [remote]: sends the tag to the remote (origin unless named). */
export function pushTag(ctx, text) {
  if (!needRepo(ctx)) return;
  const [name, given] = splitArgs(text ?? '');
  if (!name) return ctx.prefill('/tag-push ');
  if (!ctx.data.refs.tags.some((t) => t.name === name)) return ctx.note(`No tag called ${name}.`, 'error');
  const remote = given ?? mainRemote(ctx);
  if (!remote) return ctx.note('This repository has no remote. Add one with: /remote add origin <url>', 'error');
  return ctx.exec(['push', remote, `refs/tags/${name}`], { label: 'Pushing tag' });
}

/**
 * R on a tag in Branches, /release <tag> [--draft] [title]: a GitHub release for the tag, with notes GitHub
 * writes from what was merged since the last one. Pushes the tag first, since the release needs the server to have it.
 */
export async function createRelease(ctx, text) {
  if (!needRepo(ctx)) return;
  const { tag, title, draft } = releaseArgs(text);
  if (!tag) return ctx.prefill('/release ');
  const host = needHost(ctx);
  if (!host) return;
  if (!host.createRelease) return ctx.note(`${host.name} has no releases made from tags: Splice only creates them on GitHub. u pushes the tag.`, 'error');
  if (!ctx.data.refs.tags.some((t) => t.name === tag)) return ctx.note(`No tag called ${tag}. t on a commit in the graph makes one.`, 'error');
  const asDraft =
    draft ||
    (await ctx.confirm({
      title: `Create a GitHub release for ${tag}${title ? ` called "${title}"` : ''}?`,
      detail: `Pushes ${tag} to ${host.remoteName} first. GitHub writes the notes from what was merged since the last release.`,
      options: [
        { label: 'Yes, publish it', value: 'publish' },
        { label: 'Save it as a draft', value: true },
        { label: 'No', value: null },
      ],
    }));
  if (!asDraft) return;
  const pushed = await ctx.exec(['push', host.remoteName, `refs/tags/${tag}`], { label: 'Pushing tag', refresh: false });
  if (!pushed.ok) return pushed;
  return hostTask(ctx, `gh release create ${tag}${asDraft === true ? ' --draft' : ''}`, (signal) => host.createRelease({ tag, title, draft: asDraft === true }, signal), {
    label: 'Creating the release',
    refresh: false,
  });
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

const OP = { merging: 'merge', rebasing: 'rebase', 'cherry-picking': 'cherry-pick', reverting: 'revert', bisecting: 'bisect' };

export async function continueOp(ctx) {
  if (!needRepo(ctx)) return;
  const { state } = ctx.data;
  if (!state) return ctx.note('There is no merge, rebase, cherry-pick or revert in progress.', 'error');
  if (state === 'bisecting') return ctx.note('A bisect goes on as you mark commits: B on one in the graph, or /bisect good, bad or skip.', 'error');
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
  if (state === 'bisecting') return bisect(ctx, 'reset');
  const ok = await ctx.confirm({
    title: `Abort the ${OP[state]}?`,
    detail: 'Puts the branch back the way it was before it started.',
    options: YES_NO('Yes, abort'),
  });
  if (!ok) return;
  await ctx.exec([OP[state], '--abort'], { label: 'Aborting' });
  if (!ctx.data.state) await cleanup(ctx.data.gitDir);
}

/**
 * B on a commit in the graph: marks it bad (has the problem), good (from before it) or skipped, starting
 * a bisect if there isn't one. Once there's a good and a bad commit, git checks out one halfway between
 * to test, and the graph moves to it.
 */
export async function bisectMark(ctx, c) {
  if (!needRepo(ctx)) return;
  const { state } = ctx.data;
  if (state && state !== 'bisecting') return ctx.note(`A ${OP[state]} is in progress. Finish it first (/continue or /abort).`, 'error');
  const on = state === 'bisecting';
  const how = await ctx.confirm({
    title: on ? `Mark ${short(c.hash)} as` : `Find the commit that brought in a problem: is ${short(c.hash)} bad or good?`,
    detail: on ? c.subject : 'Then mark one of the other kind, and git checks out commits in between for you to try, halving the range each time.',
    options: [
      { label: 'Bad: it has the problem', value: 'bad' },
      { label: 'Good: from before the problem', value: 'good' },
      ...(on ? [{ label: "Skip: can't tell (it doesn't build, say)", value: 'skip' }] : []),
      { label: 'Cancel', value: null },
    ],
  });
  if (how) await bisect(ctx, how, c.hash);
}

/** /bisect good|bad|skip [ref] (HEAD if none), and /bisect reset: what B does, from the prompt. */
export async function bisect(ctx, how, ref) {
  if (!needRepo(ctx)) return;
  const on = ctx.data.state === 'bisecting';
  if (how === 'reset') {
    if (!on) return ctx.note('There is no bisect in progress.', 'error');
    const ok = await ctx.confirm({ title: 'Stop bisecting?', detail: 'Goes back to the branch or commit you were on when it started.', options: YES_NO('Yes, stop') });
    if (ok) await ctx.exec(['bisect', 'reset'], { label: 'Ending the bisect' });
    return;
  }
  if (!['good', 'bad', 'skip'].includes(how)) return ctx.note('Use /bisect good, bad or skip [ref], or /bisect reset.', 'error');
  if (!on) {
    if (how === 'skip') return ctx.note('Start a bisect by marking a commit good or bad (B in the graph).', 'error');
    if (!(await ctx.exec(['bisect', 'start'], { label: 'Starting a bisect', refresh: false })).ok) return;
  }
  const r = await ctx.exec(['bisect', how, ...(ref ? [ref] : [])], { label: 'Bisecting' });
  const found = r.ok && firstBadCommit(r.out);
  if (found) ctx.note(`Found it: ${short(found)} is the first bad commit (↵ on it shows its diff). /abort ends the bisect and goes back to where you were.`);
}

/**
 * s in Stash, /stash [-u | --no-untracked] [message]: stashes every change. Untracked files go too while the
 * "Stash untracked files" setting is on (it is unless turned off); -u and --no-untracked override it.
 */
export function stash(ctx, text) {
  if (!needRepo(ctx)) return;
  const { files } = ctx.data.status;
  if (!files.length) return ctx.note('No changes to stash.', 'error');
  const { args, untracked } = stashArgs(text, { untracked: ctx.config.stashUntracked !== false });
  if (!untracked && files.every((f) => f.kind === 'untracked')) return ctx.note('Only untracked files have changed. /stash -u takes them too.', 'error');
  return ctx.exec(args, { label: 'Stashing' });
}

/** Why a file from Changes can't be stashed on its own, or null when it can. */
function cantStash(f) {
  if (f.area === 'conflict') return `${f.path} has conflicts, which can't be stashed. Resolve it first (space marks it resolved).`;
  // With a path, git stash can't find a file that only the last commit has: the old side of a rename, a staged deletion.
  if (f.kind === 'renamed' || (f.area === 'staged' && f.x === 'D')) {
    return `git can't stash a staged ${f.kind === 'renamed' ? 'rename' : 'deletion'} (${f.path}) on its own. Unstage it first (space), then stash it.`;
  }
  return null;
}

/** Stashes one file from Changes, staged and unstaged changes alike, with its path as the message. */
export function stashFile(ctx, f) {
  return stashFiles(ctx, [f]);
}

/**
 * s in Changes, on a file or on files selected with v: stashes just those, staged and unstaged changes alike.
 * The message is the path (or the first path and how many more).
 */
export function stashFiles(ctx, list) {
  if (!needRepo(ctx)) return;
  const problem = list.map(cantStash).find(Boolean);
  if (problem) return ctx.note(problem, 'error');
  const paths = [...new Set(list.map((f) => f.path))];
  if (!paths.length) return ctx.note('Nothing selected to stash.', 'error');
  const untracked = list.some((f) => f.kind === 'untracked') ? ['--include-untracked'] : [];
  const message = paths.length === 1 ? paths[0] : `${paths[0]} and ${paths.length - 1} more`;
  return ctx.exec(['stash', 'push', ...untracked, '-m', message, '--', ...paths], { label: 'Stashing' });
}

/**
 * s in a file's diff in Changes: stashes the hunk under the cursor, or the lines selected with v, and takes them
 * out of the working tree; the rest of the file stays. git stash can't do part of a file without a terminal
 * (stash -p asks), so the stash is made by hand: its base and index are the index as it is, its working tree
 * the index plus the picked lines. Applying or popping it later brings back just those lines.
 */
export async function stashLines(ctx, f, diffText, picks) {
  if (!needRepo(ctx)) return;
  if (f.area !== 'unstaged' || f.kind === 'untracked') {
    return ctx.note(f.kind === 'untracked' ? 'This is a new file: stash the whole file from the list instead (s).' : 'Only unstaged lines can be stashed on their own. Unstage them first.', 'error');
  }
  if (isInitial(ctx)) return ctx.note('There are no commits yet to stash against.', 'error');
  const patch = buildPatch(parseDiff(diffText), picks);
  if (!patch) return;
  const { gitDir } = ctx.data;
  const branch = ctx.data.status.branch.head ?? '(no branch)';
  const message = `On ${branch}: ${f.path} (some lines)`;
  const index = join(gitDir, 'splice-stash-index');
  let made;
  const r = await ctx.task(
    `Stash the picked lines of ${f.path}`,
    async (signal) => {
      const g = (args, opts = {}) => ctx.git(args, { signal, ...opts }).then((s) => s.trim());
      const env = { GIT_INDEX_FILE: index };
      try {
        const head = await g(['rev-parse', 'HEAD']);
        const indexTree = await g(['write-tree']);
        await g(['read-tree', indexTree], { env });
        await g(['apply', '--cached', '--recount', '--whitespace=nowarn', '-'], { env, input: patch });
        const worktreeTree = await g(['write-tree'], { env });
        // Never signed: these are a stash's own commits, and signing could ask for a passphrase.
        const commit = (tree, parents, msg) => g(['commit-tree', '--no-gpg-sign', tree, ...parents.flatMap((p) => ['-p', p]), '-m', msg]);
        const base = await commit(indexTree, [head], `base of ${message}`);
        const idx = await commit(indexTree, [base], `index on ${branch}`);
        made = await commit(worktreeTree, [base, idx], message);
        await g(['stash', 'store', '-m', message, made]);
      } finally {
        await rm(index, { force: true });
      }
      return { stdout: `Saved ${message}`, stderr: '' };
    },
    { label: 'Stashing', refresh: false },
  );
  if (!r.ok) return ctx.reload();
  // Kept in the stash now: take the lines out of the working tree. Should that fail, the stash goes again.
  const out = await apply(ctx, patch, ['--reverse'], 'Stashing', { refresh: false });
  if (!out.ok) await ctx.exec(['stash', 'drop', '-q', 'stash@{0}'], { quiet: true, refresh: false });
  await ctx.reload();
  return out;
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
  const stash = ref || 'stash@{0}';
  const label = pop ? 'Popping stash' : 'Applying stash';
  const r = await ctx.exec(['stash', pop ? 'pop' : 'apply', stash], { label, quietError: true });
  // git won't apply a stash to files with uncommitted changes, even elsewhere in the file (the rest of a file
  // some lines were stashed from, say). Its changes to tracked files can still go on top, as a patch.
  if (!r.ok && /would be overwritten by merge/.test(r.error?.message ?? '')) {
    const untracked = await ctx.git(['rev-parse', '-q', '--verify', `${stash}^3`]).then(() => true, () => false);
    const patch = untracked ? null : await ctx.git(['diff', '--binary', `${stash}^1`, stash]).catch(() => null);
    if (patch) {
      const applied = await ctx.exec(['apply', '--whitespace=nowarn', '-'], { input: patch, label, quietError: true, refresh: !pop });
      if (applied.ok) {
        if (pop) await ctx.exec(['stash', 'drop', '-q', stash], { quiet: true });
        ctx.note(`${pop ? 'Popped' : 'Applied'} ${stash} on top of your uncommitted changes`, 'ok');
        return applied;
      }
    }
  }
  if (!r.ok && !r.error?.cancelled) ctx.note(r.error.message, 'error');
  afterConflicts(ctx);
  return r;
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
 * then deletes the local branches with no commits that exist only here: all on a remote, merged into
 * the default branch, or in a pull request that was merged. With a PR host, also the branches on its
 * remote whose pull request was merged and that haven't moved since. Lists them first and asks.
 */
export async function cleanUp(ctx) {
  if (!needRepo(ctx)) return;
  const { root, refs, remotes } = ctx.data;
  const host = ctx.host();
  let plan;
  let unasked = '';
  const read = await ctx.task(
    'Looking for branches and worktrees to clean up',
    async (signal) => {
      // The host's merged PRs catch squash merges, which git alone can't see. It's asked while git
      // reads the rest; when it can't answer, the cleanup goes ahead without it.
      const look = host?.merged
        ? Promise.all([host.merged(signal), host.list()]).then(
            ([merged, open]) => ({ remoteName: host.remoteName, merged, open }),
            (e) => {
              if (e.cancelled) throw e;
              unasked = `${host.name} couldn't be asked about merged pull requests: ${firstLine(e.message)}`;
              return null;
            },
          )
        : null;
      const [{ name, remote }, server] = await Promise.all([findDefaultBranch(ctx), look]);
      const mergedRefs = name ? [name, remote && `${remote}/${name}`].filter((r) => refs.local.some((b) => b.name === r) || refs.remote.some((b) => b.name === r)) : [];
      plan = planCleanup(await readCleanup(root, { defaultBranch: name, mergedRefs, hasRemotes: remotes.length > 0, server }));
      return { stdout: '', stderr: '' };
    },
    { label: 'Looking for things to clean up', refresh: false, quiet: true },
  );
  if (!read.ok) return read;
  if (!plan.worktrees.length && !plan.branches.length && !plan.remote.length) {
    return ctx.note(['Nothing to clean up: every other branch and worktree has something of yours on it.', unasked].filter(Boolean).join('\n'));
  }
  // The full list goes in the viewer, so the question stays short however much there is.
  ctx.showText('Clean up: what goes and what stays', [cleanupText(plan, root), unasked].filter(Boolean).join('\n\n'));
  const choice = await ctx.confirm({
    title: `Delete ${cleanupCount(plan)} with nothing of yours on them?`,
    detail: `Listed above, with why. Branches that have commits only here, and worktrees with changes, stay.${
      plan.remote.length ? ` On ${plan.remote[0].remote}, only branches whose pull request was merged and that haven't moved since go.` : ''
    }`,
    options: cleanupOptions(plan),
    danger: true,
  });
  ctx.closeOverlay();
  if (!choice) return;
  const { worktrees, branches, remote } = cleanupChoice(plan, choice);
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
  let pushed = '';
  if (remote.length && !stopped) {
    const where = remote[0].remote;
    const push = async (list) => {
      const r = await step(['push', where, '--delete', ...list.map((b) => b.branch)], `Deleting branches on ${where}`, { quietError: true });
      pushed = r.ok ? '' : r.error.message;
    };
    await push(remote);
    // A branch already gone from the server (deleted when its PR was merged, say, and not fetched
    // since) makes git push nothing at all. Its remote-tracking branch is all that's left of it;
    // without those, the rest go.
    const gone = remote.filter((b) => pushed.includes(`unable to delete '${b.branch}': remote ref does not exist`));
    if (gone.length && !stopped) {
      await step(['branch', '-d', '-r', ...gone.map((b) => b.name)], 'Removing branches already gone from the remote');
      const rest = remote.filter((b) => !gone.includes(b));
      if (rest.length && !stopped) await push(rest);
    }
  }
  await ctx.reload();
  const left = new Set(ctx.data.refs.local.map((b) => b.name));
  const deleted = names.filter((n) => !left.has(n));
  const remoteLeft = new Set(ctx.data.refs.remote.map((b) => b.name));
  const deletedRemote = remote.filter((b) => !remoteLeft.has(b.name));
  for (const b of branches) {
    if (!left.has(b.name)) continue;
    if (!names.includes(b.name)) problems.push(`${b.name}: kept, as its worktree is still there`);
    else if (!stopped) {
      const line = message.split('\n').find((l) => l.includes(`'${b.name}'`) && !/not fully merged|^hint:/.test(l));
      problems.push(`${b.name}: ${line ? line.replace(/^error:\s*/, '') : 'not deleted'}`);
    }
  }
  if (!stopped) {
    for (const b of remote.filter((x) => remoteLeft.has(x.name))) {
      // "error: unable to delete 'x': ..." or " ! [remote rejected] x (protected branch)"
      const line = pushed.split('\n').find((l) => l.includes(`'${b.branch}'`) || (/^\s*!/.test(l) && l.split(/\s+/).includes(b.branch)));
      problems.push(`${b.name}: ${line ? line.replace(/^error:\s*/, '') : firstLine(pushed) || 'not deleted'}`);
    }
  }
  const done = cleanupCount({ worktrees: [...removed], branches: deleted, remote: deletedRemote });
  const head = stopped ? `Stopped${done ? ` after ${done}` : ''}` : done ? `Cleaned up ${done}` : 'Nothing was cleaned up';
  const lines = [
    ...(deleted.length ? [`Deleted ${deleted.join(', ')}`] : []),
    ...(deletedRemote.length ? [`Deleted on ${deletedRemote[0].remote}: ${deletedRemote.map((b) => b.branch).join(', ')}`] : []),
    ...problems,
  ];
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

/**
 * I on a submodule in Changes, /submodule-update [path]: clones what isn't yet and checks out the commit this
 * repository records, in one submodule or all of them (and theirs, recursively). Asks first when that moves
 * one off another commit it has checked out.
 */
export async function updateSubmodules(ctx, text) {
  if (!needRepo(ctx)) return;
  const subs = ctx.data.submodules ?? [];
  if (!subs.length) return ctx.note('This repository has no submodules.', 'error');
  const path = (text ?? '').trim().replace(/[\\/]+$/, '');
  const target = path ? subs.find((s) => s.path === path) : null;
  if (path && !target) return ctx.note(`No submodule at ${path}.`, 'error');
  const moving = (target ? [target] : subs).filter((s) => s.state === 'out of date');
  if (moving.length) {
    const ok = await ctx.confirm({
      title: `Check out the recorded commit in ${moving.map((s) => s.path).join(', ')}?`,
      detail: 'It has another commit checked out now. That commit stays in its history, but its HEAD moves (detached).',
      options: YES_NO('Yes, update'),
    });
    if (!ok) return;
  }
  return ctx.exec(['submodule', 'update', '--init', '--recursive', ...(target ? ['--', target.path] : [])], { label: 'Updating submodules' });
}

/** o or ↵ on a submodule in Changes: opens it in Splice as the repository it is. */
export function openSubmodule(ctx, sub) {
  if (sub.state === 'uninitialised') return ctx.note(`${sub.path} isn't initialised yet: I clones and checks it out.`, 'error');
  return ctx.openRepo(join(ctx.data.root, sub.path));
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

/**
 * The branch's commits that aren't on its upstream or the default branch yet, newest first; failing that,
 * the latest 30 (`own` false).
 */
async function branchCommits(ctx, signal) {
  const { status, refs, remotes } = ctx.data;
  const { branch } = status;
  const exclude = fixupExclusions({
    head: branch.head,
    upstream: branch.upstream,
    def: defaultBranch(refs, remotes),
    local: refs.local.map((b) => b.name),
  });
  const list = exclude.length ? parseCommitList(await ctx.git(fixupLogArgs(exclude), { signal })) : [];
  if (list.length) return { list, own: true };
  return { list: parseCommitList(await ctx.git(fixupLogArgs([]), { signal })), own: false };
}

async function fixupCandidates(ctx) {
  return (await branchCommits(ctx)).list.map((c) => ({
    ...c,
    segments: [
      { text: c.hash.slice(0, 7), color: theme.warn },
      { text: ` ${fit(relTime(c.time), 4, 'right')}  `, color: theme.dim },
      { text: c.subject, strong: true },
    ],
  }));
}

async function fixupInto(ctx, target, { stageAll }) {
  if ((await readySigning(ctx)) === false) return;
  if (stageAll && !(await ctx.exec(['add', '-A'], { refresh: false, quiet: true })).ok) return;
  const made = await ctx.exec(['commit', `--fixup=${target.hash}`], { label: 'Committing the fixup' });
  if (!made.ok) return made;
  return offerFold(ctx, target, {
    title: `Fold it into "${target.subject}" now?`,
    kept: `Kept "fixup! ${target.subject}" as its own commit for now.`,
    later: `To fold it in later: i on ${short(target.hash)} in the graph, J to move the fixup! commit just above it, f to fix up, ↵.`,
  });
}

/**
 * After fixup! commits are made: asks whether to fold them in with an autosquash rebase from `oldest` (the
 * oldest commit given one), warning when that commit is already pushed. Merge commits after it would be
 * flattened, so then it only says how to fold them in later.
 */
async function offerFold(ctx, oldest, { title, kept, later, many = false }) {
  const keep = `${kept}\n${later}`;
  // Without --rebase-merges a rebase flattens merges, and with it a merge can conflict all over again.
  const merges = Number((await ctx.git(['rev-list', '--count', '--min-parents=2', `${oldest.hash}..HEAD`]).catch(() => '0')).trim());
  if (merges) return ctx.note(`There are merge commits after "${oldest.subject}", which folding ${many ? 'them' : 'the fixup'} in would flatten.\n${keep}`);
  // Already on a remote branch means folding rewrites history others may have.
  const onRemotes = (await ctx.git(['for-each-ref', '--contains', oldest.hash, '--format=%(refname:short)', 'refs/remotes']).catch(() => ''))
    .split('\n')
    .filter((r) => r && !r.endsWith('/HEAD'));
  const { upstream } = ctx.data.status.branch;
  const pushedTo = onRemotes.includes(upstream) ? upstream : onRemotes[0];
  // Other changes to tracked files would stop the rebase; set aside, they come back when it's done.
  const autostash = ctx.data.status.files.some((f) => f.kind !== 'untracked');
  const fold = await ctx.confirm({
    title,
    detail: pushedTo
      ? `${short(oldest.hash)} is already on ${pushedTo}: folding rewrites pushed history, so you'd need /push --force afterwards.`
      : `Rewrites the commits since ${short(oldest.hash)} (an autosquash rebase)${autostash ? '; other changes are stashed meanwhile' : ''}.`,
    options: [
      { label: `Yes, fold ${many ? 'them' : 'it'} in`, value: true },
      { label: `No, keep the fixup! commit${many ? 's' : ''} for later`, value: false },
    ],
    danger: Boolean(pushedTo),
  });
  if (!fold) return ctx.note(keep);
  // GIT_EDITOR is already `true`; this also beats a sequence.editor in the user's config. The todo is taken as autosquash ordered it.
  const r = await ctx.exec(foldArgs(oldest, { autostash }), { label: `Folding the fixup${many ? 's' : ''} in`, env: { GIT_SEQUENCE_EDITOR: 'true' } });
  if (ctx.data.state) {
    if (ctx.data.changes.conflicts.length) afterConflicts(ctx);
    else ctx.note('The rebase stopped. /continue carries on, /abort puts everything back.', 'error');
  }
  return r;
}

/**
 * Z in Changes, /absorb: each staged hunk becomes a fixup! commit for the branch's commit that last changed
 * its lines (by blaming them at HEAD), as git-absorb does; hunks with no one such commit stay staged. Shows the
 * plan and asks, commits each group in a separate index (so what stays is never touched), then offers to fold
 * them in as F does.
 */
export async function absorb(ctx) {
  if (!needRepo(ctx)) return;
  const { state } = ctx.data;
  if (state) return ctx.note(`A ${OP[state]} is in progress. Finish it first (/continue or /abort), then absorb.`, 'error');
  if (isInitial(ctx)) return ctx.note('There are no commits yet to absorb changes into.', 'error');
  const { branch } = ctx.data.status;
  if (!branch.head) return ctx.note('HEAD is detached. Folding fixups in rewrites a branch, so check one out first.', 'error');
  const { staged, conflicts } = ctx.data.changes;
  if (conflicts.length) return ctx.note('Resolve the conflicts first (space marks a file resolved).', 'error');
  if (!staged.length) return ctx.note('Nothing is staged. Stage the changes to absorb first (space, or a for all).', 'error');
  let files;
  let plan;
  let own = true;
  const read = await ctx.task(
    'Finding the commits the staged changes belong to',
    async (signal) => {
      const [diffText, commits] = await Promise.all([ctx.git(['diff', '--cached', '--no-ext-diff', '-U3'], { signal }), branchCommits(ctx, signal)]);
      own = commits.own;
      files = absorbFiles(diffText);
      const blames = new Map();
      // One blame per file, of just the lines its hunks need, as of HEAD.
      await eachLimited(
        files.filter((f) => !f.problem),
        4,
        async (f) => {
          const ranges = lineRanges(f.diff.hunks.flatMap(blameTargets));
          if (!ranges.length) return null;
          const raw = await ctx.git(['blame', '--porcelain', ...ranges.flatMap(([a, b]) => ['-L', `${a},${b}`]), 'HEAD', '--', f.path], { signal }).catch((e) => {
            if (e.cancelled) throw e;
            return null;
          });
          return raw == null ? null : blameMap(parseBlame(raw));
        },
        (f, map) => map && blames.set(f.path, map),
      );
      plan = planAbsorb(files, blames, commits.list);
      return { stdout: '', stderr: '' };
    },
    { label: 'Looking at the staged changes', refresh: false, quiet: true },
  );
  if (!read.ok) return read;
  const text = absorbText(plan, { own });
  if (!plan.groups.length) {
    ctx.showText('Absorb: nothing goes into an earlier commit', text);
    return ctx.note("Nothing to absorb: no staged hunk's lines come from just one of the branch's commits. They stay staged.", 'error');
  }
  ctx.showText(`Absorb: ${absorbSummary(plan)}`, text);
  const n = plan.groups.length;
  const ok = await ctx.confirm({
    title: `Make ${n === 1 ? 'a fixup! commit' : `${n} fixup! commits`} of ${absorbSummary(plan).split(' into ')[0]}?`,
    detail: `Listed above: each goes to the commit that last changed its lines.${plan.stays.length ? ' The rest stay staged.' : ''}`,
    options: YES_NO(`Yes, make the fixup! commit${n === 1 ? '' : 's'}`),
  });
  ctx.closeOverlay();
  if (!ok) return;
  if ((await readySigning(ctx)) === false) return;
  // The commits are made from an index of their own, started from HEAD: the real one keeps everything staged,
  // and once they're made, what's left staged against the new HEAD is just what stayed.
  const index = join(ctx.data.gitDir, 'splice-absorb-index');
  const env = { GIT_INDEX_FILE: index };
  let made = 0;
  let problem = null;
  try {
    const start = await ctx.exec(['read-tree', 'HEAD'], { env, quiet: true, refresh: false, label: 'Absorbing' });
    if (!start.ok) return start;
    for (const g of plan.groups) {
      const staging = await apply(ctx, groupPatch(files, g), ['--cached'], 'Absorbing', { env, refresh: false, quietError: true });
      if (!staging.ok) {
        problem = staging.error.cancelled ? null : `The hunks for "${g.commit.subject}" didn't apply: ${firstLine(staging.error.message)}`;
        break;
      }
      const r = await ctx.exec(['commit', '--quiet', `--fixup=${g.commit.hash}`], { env, label: 'Committing the fixups', refresh: false });
      if (!r.ok) break;
      made++;
    }
  } finally {
    await rm(index, { force: true }).catch(() => {});
    await ctx.reload();
  }
  if (made < n) {
    const head = made ? `Made ${made} of the ${n} fixup! commits` : 'No fixup! commits were made';
    return ctx.note([head, problem, 'What wasn\'t absorbed is still staged.'].filter(Boolean).join('\n'), 'error');
  }
  const oldest = plan.oldest;
  return offerFold(ctx, oldest, {
    title: n === 1 ? `Fold it into "${oldest.subject}" now?` : `Fold them into their ${n} commits now?`,
    kept: n === 1 ? `Kept "fixup! ${oldest.subject}" as its own commit for now.` : `Kept the ${n} fixup! commits as they are for now.`,
    later: `To fold ${n === 1 ? 'it' : 'them'} in later: i on ${short(oldest.hash)} in the graph, J/K to move each fixup! commit just above its commit, f to fix up, ↵.`,
    many: n > 1,
  });
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
      rows = parseLog(await ctx.git(searchArgs(mode, query), { signal }));
      return { stdout: rows.length ? `${rows.length} commit${rows.length === 1 ? '' : 's'}` : 'No commits', stderr: '' };
    },
    { label: 'Searching the history', refresh: false },
  );
  if (r.ok) ctx.find({ mode, query, rows });
  return r;
}

/**
 * /filter --author <name> --path <path> --since <date> --until <date>: the graph shows only the commits, on
 * any branch, by that author, touching that path, in those dates. /filter alone (or esc in the graph) clears it.
 */
export async function filter(ctx, text) {
  if (!needRepo(ctx)) return;
  const f = filterArgs(text);
  if (f.error) return ctx.note(f.error, 'error');
  if (!Object.keys(f).length) return ctx.find('');
  const label = filterLabel(f);
  let rows = [];
  const r = await ctx.task(
    `git log ${label}`,
    async (signal) => {
      rows = parseLog(await ctx.git(filterLogArgs(f), { signal }));
      return { stdout: rows.length ? `${rows.length} commit${rows.length === 1 ? '' : 's'}` : 'No commits', stderr: '' };
    },
    { label: 'Filtering the history', refresh: false },
  );
  if (r.ok) ctx.find({ mode: 'F', query: label, rows });
  return r;
}

function needHost(ctx) {
  if (!needRepo(ctx)) return null;
  const host = ctx.host();
  if (!host) ctx.note("This repository's remote isn't on GitHub or Azure DevOps, so there are no pull requests to show.", 'error');
  return host;
}

// gh and az calls go through the same queue, spinner and activity lines as git.
const hostTask = (ctx, title, fn, opts) =>
  ctx.task(
    title,
    async (signal) => {
      const out = await fn(signal);
      return { stdout: typeof out === 'string' ? out : '', stderr: '' };
    },
    opts,
  );
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

/**
 * m in PRs, /merge-pr [squash|merge|rebase] [--delete-branch] [--auto]: merges the pull request on the server,
 * asking how (what isn't given), and whether now or once its checks and reviews pass (auto-merge).
 */
export async function prMerge(ctx, pr, text = '') {
  const host = needHost(ctx);
  if (!host) return;
  if (!pr) return ctx.note('Pick a pull request in PRs (6) first.', 'error');
  const given = mergePrArgs(text);
  if (given.error) return ctx.note(given.error, 'error');
  const methods = host.mergeMethods ?? ['merge'];
  if (given.method && !methods.includes(given.method)) {
    return ctx.note(`${host.name} can't ${given.method}-merge from here. Use ${methods.join(' or ')}.`, 'error');
  }
  const method =
    given.method ??
    (await ctx.confirm({
      title: `Merge ${pr.label} "${pr.title}" into ${pr.target} how?`,
      options: [...methods.map((m) => ({ label: MERGE_LABELS[m], value: m })), { label: 'Cancel', value: null }],
    }));
  if (!method) return;
  const warn = [pr.draft ? "It's still a draft." : '', pr.conflicts ? 'It has merge conflicts.' : ''].filter(Boolean).join(' ');
  const how = MERGE_LABELS[method].replace(/ and merge$/, '').toLowerCase();
  let when;
  if (given.auto != null || given.deleteBranch != null) {
    const ok = await ctx.confirm({
      title: `${given.auto ? 'Auto-merge' : 'Merge'} ${pr.label} into ${pr.target} (${how})?`,
      detail: `${given.deleteBranch ? `Deletes ${pr.source} on the server afterwards. ` : ''}${warn || `On ${host.name}, for everyone.`}`,
      options: YES_NO(given.auto ? 'Yes, merge it once it can' : 'Yes, merge it'),
      danger: true,
    });
    if (!ok) return;
    when = { auto: Boolean(given.auto), deleteBranch: Boolean(given.deleteBranch) };
  } else {
    when = await ctx.confirm({
      title: `Merge ${pr.label} into ${pr.target} (${how})?`,
      detail: warn || `On ${host.name}, for everyone. Auto-merge waits for the required checks and reviews.`,
      options: [
        { label: `Merge now, and delete ${pr.source}`, value: { auto: false, deleteBranch: true } },
        { label: `Merge now, keep ${pr.source}`, value: { auto: false, deleteBranch: false } },
        { label: `Auto-merge once it can, and delete ${pr.source}`, value: { auto: true, deleteBranch: true } },
        { label: `Auto-merge once it can, keep ${pr.source}`, value: { auto: true, deleteBranch: false } },
        { label: 'No', value: null },
      ],
      danger: true,
    });
    if (!when) return;
  }
  const opts = { method, ...when };
  const title = host.kind === 'github' ? `gh pr merge ${pr.id} --${method}${opts.deleteBranch ? ' --delete-branch' : ''}${opts.auto ? ' --auto' : ''}` : `az repos pr update --id ${pr.id} ${opts.auto ? '--auto-complete' : '--status completed'}`;
  const r = await hostTask(ctx, title, (signal) => host.merge(pr, opts, signal), { label: opts.auto ? 'Setting auto-merge' : 'Merging', refresh: false });
  if (r.ok) {
    ctx.prsChanged();
    if (!opts.auto) ctx.note(`Merged ${pr.label} into ${pr.target}. f fetches it.`, 'ok');
  }
  return r;
}

const CHECK_ICON = { pass: ['✓', 'add'], fail: ['✗', 'del'], pending: ['…', 'warn'] };

/**
 * s in PRs, /checks: the pull request's CI checks in a picker, failed first. ↵ shows a check's log (a failed
 * job's failed steps), o opens it in the browser, R re-runs the failed ones where the host can.
 */
export function prChecks(ctx, pr, { replace = false } = {}) {
  const host = needHost(ctx);
  if (!host) return;
  if (!pr) return ctx.note('Pick a pull request in PRs (6) first.', 'error');
  if (!host.checks) return ctx.note(`Splice can't list checks on ${host.name}.`, 'error');
  const order = { fail: 0, pending: 1, pass: 2 };
  let all = [];
  ctx.showPicker(
    {
      title: `Checks of ${pr.label} ${pr.title}`,
      hint: `↵ log · o open in browser${host.canRerun ? ' · R re-run failed' : ''}`,
      empty: 'No checks have run on it.',
      load: async () => {
        all = (await host.checks(pr)).sort((a, b) => order[a.state] - order[b.state]);
        return all.map((c) => {
          const [icon, tone] = CHECK_ICON[c.state] ?? CHECK_ICON.pending;
          return {
            check: c,
            segments: [{ text: `${icon} `, color: theme[tone], bold: true }, { text: c.name, strong: true }, { text: c.workflow ? `  ${c.workflow}` : '', color: theme.dim }],
          };
        });
      },
      onPick: ({ check }) => ctx.showAsync(`${check.name} (${check.state === 'fail' ? 'failed steps' : 'log'})`, () => host.checkLog(check)),
      keys: {
        o: ({ check }) => (check.url ? ctx.openUrl(check.url) : ctx.note(`${check.name} has no page to open.`, 'error')),
        y: ({ check }) => (check.url ? ctx.copy(check.url, `the link to ${check.name}`) : undefined),
      },
      actions: {
        R: async () => {
          if (!host.canRerun) return ctx.note(`Splice can't re-run checks on ${host.name}.`, 'error');
          const failed = all.filter((c) => c.state === 'fail');
          if (!failed.length) return ctx.note('No check has failed, so there is nothing to re-run.', 'error');
          const ok = await ctx.confirm({ title: `Re-run the ${failed.length} failed check${failed.length === 1 ? '' : 's'} of ${pr.label}?`, options: YES_NO('Yes, re-run them') });
          if (!ok) return;
          const r = await hostTask(ctx, `Re-run failed checks of ${pr.label}`, (signal) => host.rerun(pr, failed, signal), { label: 'Re-running checks', refresh: false });
          if (r.ok) {
            ctx.prsChanged();
            prChecks(ctx, pr, { replace: true });
          }
        },
      },
    },
    { replace },
  );
}

function pickedPr(ctx) {
  const host = needHost(ctx);
  if (!host) return {};
  const pr = ctx.selectedPr;
  if (!pr) ctx.note('Pick a pull request in PRs (6) first.', 'error');
  return { host, pr };
}

async function prEdit(ctx, host, pr, title, label, fn) {
  const r = await hostTask(ctx, title, fn, { label, refresh: false });
  if (r.ok) ctx.prsChanged();
  return r;
}

/** A in PRs, /reviewer <name> [name ...]: asks them to review the picked pull request. */
export function prReviewers(ctx, text) {
  const { host, pr } = pickedPr(ctx);
  if (!pr) return;
  const names = splitArgs((text ?? '').replace(/,/g, ' '));
  if (!names.length) return ctx.prefill('/reviewer ');
  return prEdit(ctx, host, pr, `Ask ${names.join(', ')} to review ${pr.label}`, 'Adding reviewers', (signal) => host.addReviewers(pr, names, signal));
}

/** D in PRs, /draft and /ready: makes the picked pull request a draft, or ready for review. `draft` null switches it. */
export function prSetDraft(ctx, draft = null) {
  const { host, pr } = pickedPr(ctx);
  if (!pr) return;
  const want = draft ?? !pr.draft;
  if (want === pr.draft) return ctx.note(`${pr.label} is ${want ? 'already a draft' : 'already ready for review'}.`, 'error');
  return prEdit(ctx, host, pr, `${pr.label}: ${want ? 'back to draft' : 'ready for review'}`, want ? 'Making it a draft' : 'Marking it ready', (signal) => host.setDraft(pr, want, signal));
}

/** E in PRs, /title <text>: renames the picked pull request (E starts from its title as it is). */
export function prTitle(ctx, text) {
  const { host, pr } = pickedPr(ctx);
  if (!pr) return;
  const title = (text ?? '').trim();
  if (!title) return ctx.prefill(`/title ${pr.title}`);
  if (title === pr.title) return ctx.note('That is its title already.');
  return prEdit(ctx, host, pr, `${pr.label}: retitle "${title}"`, 'Retitling', (signal) => host.edit(pr, { title }, signal));
}

/**
 * B in PRs, /body: the picked pull request's description. With nothing after it, writes the description as it
 * is to a file in .git for you to edit in your own editor, and puts /body --file <it> in the prompt to send it
 * once saved. /body --file <path> sends a file; /body <text> sends the text (\n for a line break).
 */
export async function prBody(ctx, text) {
  const { host, pr } = pickedPr(ctx);
  if (!pr) return;
  const args = bodyArgs(text);
  if (args.file === undefined && args.text === undefined) {
    const file = join(ctx.data.gitDir, `splice-pr-${String(pr.id).replace(/[^\w-]/g, '')}.md`);
    await writeFile(file, pr.description ?? '');
    ctx.note(`Wrote ${pr.label}'s description to ${file}\nEdit it in your editor and save, then press enter here to send it.`);
    return ctx.prefill(`/body --file ${file}`);
  }
  let body = args.text;
  if (args.file !== undefined) {
    if (!args.file) return ctx.prefill('/body --file ');
    try {
      body = (await readFile(args.file, 'utf8')).replace(/\r\n/g, '\n').trimEnd();
    } catch (e) {
      return ctx.note(`Couldn't read ${args.file}: ${firstLine(e.message)}`, 'error');
    }
  }
  const r = await prEdit(ctx, host, pr, `${pr.label}: new description`, 'Updating the description', (signal) => host.edit(pr, { body }, signal));
  if (r.ok && args.file?.startsWith(ctx.data.gitDir)) await rm(args.file, { force: true });
  return r;
}

/** /reply <text> (r on a review comment in a pull request's diff): posts a reply to that thread, then shows it. */
export async function replyToThread(ctx, text) {
  const target = ctx.reviewThread;
  if (!target) return ctx.note("Open a pull request's diff (↵ in PRs), then r on a review comment.", 'error');
  if (!text.trim()) return ctx.prefill('/reply ');
  const host = needHost(ctx);
  if (!host) return;
  const { pr, thread } = target;
  const r = await hostTask(ctx, `Reply to ${thread.comments[0].author} on ${thread.path}`, (signal) => host.reply(pr, thread, text.trim(), signal).then(() => 'Replied'), {
    label: 'Replying',
    refresh: false,
  });
  if (r.ok) await ctx.refreshThreads(pr);
}

const lineLabel = (at) => `${at.path}:${at.line}${at.side === 'old' ? ' (a removed line)' : ''}`;

/**
 * /review-comment <text> (c on a line of a pull request's diff): a new review thread on that line,
 * shown in the diff once it's posted.
 */
export async function commentOnLine(ctx, text) {
  const target = ctx.reviewLine;
  if (!target) return ctx.note("Open a pull request's diff (↵ in PRs), then c on the line to comment on.", 'error');
  if (!text.trim()) return ctx.prefill('/review-comment ');
  const host = needHost(ctx);
  if (!host) return;
  if (!host.addThread) return ctx.note(`Splice can't comment on lines of a pull request on ${host.name}.`, 'error');
  const { pr, at } = target;
  const r = await hostTask(ctx, `Comment on ${lineLabel(at)}`, (signal) => host.addThread(pr, at, text.trim(), signal).then(() => 'Commented'), {
    label: 'Commenting',
    refresh: false,
  });
  if (r.ok) await ctx.refreshThreads(pr);
  return r;
}

/**
 * x on a review comment in a pull request's diff, /resolve and /unresolve: marks its thread resolved, or
 * opens it again. `target` is { pr, thread }, the thread picked in the diff unless given.
 */
export async function resolveThread(ctx, resolved, target = ctx.reviewThread) {
  if (!target) return ctx.note("Open a pull request's diff (↵ in PRs), then pick a review comment with t.", 'error');
  const host = needHost(ctx);
  if (!host) return;
  if (!host.resolveThread) return ctx.note(`Splice can't resolve review comments on ${host.name}.`, 'error');
  const { pr, thread } = target;
  if (thread.resolved === resolved) return ctx.note(`That thread is ${resolved ? 'already resolved' : "open, not resolved"}.`);
  const where = `${thread.path}${thread.line ? `:${thread.line}` : ''}`;
  const r = await hostTask(
    ctx,
    `${resolved ? 'Resolve' : 'Reopen'} the comments on ${where}`,
    (signal) => host.resolveThread(pr, thread, resolved, signal).then(() => (resolved ? 'Resolved' : 'Reopened')),
    { label: resolved ? 'Resolving' : 'Reopening', refresh: false },
  );
  if (r.ok) await ctx.refreshThreads(pr);
  return r;
}

/**
 * X in PRs, /request-changes [text]: a review asking for changes, after asking. GitHub needs the text (the
 * review's body); Azure DevOps votes "waiting for the author" and posts the text, if any, as a comment.
 */
export async function prRequestChanges(ctx, pr, text = '') {
  const host = needHost(ctx);
  if (!host) return;
  if (!pr) return ctx.note('Pick a pull request in PRs (6) first.', 'error');
  if (pr.mine) return ctx.note("That's your own pull request.", 'error');
  if (!host.requestChanges) return ctx.note(`Splice can't request changes on ${host.name}.`, 'error');
  const body = (text ?? '').trim();
  if (!body && host.requestChangesNeedsText) {
    ctx.note(`${host.name} needs to be told what to change: type it after /request-changes.`);
    return ctx.prefill('/request-changes ');
  }
  const quoted = body ? `"${body.length > 60 ? `${body.slice(0, 59)}…` : body}"` : '';
  const ok = await ctx.confirm({
    title: `Request changes to ${pr.label} "${pr.title}"?`,
    detail: `On ${host.name}, as you${body ? `, saying ${quoted}` : ''}.`,
    options: YES_NO('Yes, request changes'),
  });
  if (!ok) return;
  const r = await hostTask(ctx, `${cliName(host)} request changes ${pr.label}`, (signal) => host.requestChanges(pr, body, signal), { label: 'Requesting changes', refresh: false });
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

/**
 * W in Changes, /describe: Claude writes the commit message for the staged changes. A subject alone lands
 * in the prompt as /commit <it>; with a body, the message goes in the message file (editMessage) and
 * /commit --file <it> in the prompt, the message showing in the viewer meanwhile.
 */
export async function describeCommit(ctx) {
  if (!needClaude(ctx)) return;
  if (!ctx.data.changes.staged.length) {
    return ctx.note('Stage what you want to commit first (space, or a for everything), then ask Claude for the message (W).', 'error');
  }
  const log = await ctx.git(['log', '-n12', '--format=%B%x1e']).catch(() => '');
  const recent = log.split('\x1e').map((m) => m.trim()).filter(Boolean);
  const r = await askClaude(ctx, 'commit message', commitPrompt(recent), () => ctx.git(['diff', '--cached', '--stat', '--patch', '-M']));
  if (!r.ok) return r;
  const { subject, body } = parseCommitMessage(r.out);
  if (!subject) return ctx.note("Claude didn't suggest a message. Try again, or write one: /commit <message>", 'error');
  if (!body) {
    ctx.prefill(`/commit ${subject}`);
    return r;
  }
  const message = `${subject}\n\n${body}`;
  ctx.showText('Commit message from Claude', message);
  await editMessage(ctx, { message });
  return r;
}

/**
 * S in Changes, /split: Claude splits all the uncommitted changes into a few logical commits, grouping their
 * hunks. Each proposed commit is shown as a diff to review, then committed (just its hunks staged), skipped,
 * or the whole thing stopped; what isn't committed stays as it was, uncommitted.
 */
export async function claudeSplit(ctx) {
  if (!needClaude(ctx)) return;
  const { state } = ctx.data;
  if (state) return ctx.note(`A ${OP[state]} is in progress. Finish it first (/continue or /abort).`, 'error');
  if (isInitial(ctx)) return ctx.note('Make the first commit yourself; Claude can split the changes after that.', 'error');
  const { staged, unstaged, conflicts } = ctx.data.changes;
  if (conflicts.length) return ctx.note('Resolve the conflicts first (space marks a file resolved).', 'error');
  if (!staged.length && !unstaged.length) return ctx.note('There are no changes to split: the working tree is clean.', 'error');
  if (staged.length) {
    const ok = await ctx.confirm({
      title: 'Unstage everything first, so Claude can split all your changes?',
      detail: 'Nothing is lost: the changes stay in the working tree, and each commit stages its own part.',
      options: YES_NO('Yes, unstage and split'),
    });
    if (!ok) return;
    if (!(await ctx.exec(['reset', '-q'], { quiet: true, refresh: false })).ok) return;
  }
  // New files take part as intended additions, so their hunks show in the diff; the ones not committed go back.
  const added = unstaged.filter((f) => f.kind === 'untracked').map((f) => f.path);
  if (added.length && !(await ctx.exec(['add', '--intent-to-add', '--', ...added], { quiet: true, refresh: false })).ok) return;
  const putBack = async () => {
    const left = added.filter((p) => ctx.data.status.files.some((f) => f.path === p));
    if (left.length) await ctx.exec(['reset', '-q', '--', ...left], { quiet: true });
    else await ctx.reload();
  };
  const units = splitUnits(await ctx.git(['diff', '--no-ext-diff']));
  if (units.length < 2) {
    await putBack();
    return ctx.note('There is only one change, so there is nothing to split: commit it (c), or W for a message.', 'error');
  }
  const recent = (await ctx.git(['log', '-n15', '--format=%s']).catch(() => '')).split('\n').filter(Boolean);
  const r = await askClaude(ctx, 'split into commits', splitPrompt(recent), splitInput(units));
  if (!r.ok) return putBack();
  const plan = parseSplit(r.out, units.map((u) => u.id));
  if (plan.error) {
    ctx.note(plan.error, 'error');
    return putBack();
  }
  if ((await readySigning(ctx)) === false) return putBack();
  const byId = new Map(units.map((u) => [u.id, u]));
  const made = [];
  let stopped = false;
  for (const [i, g] of plan.groups.entries()) {
    const parts = g.ids.map((id) => byId.get(id));
    const files = [...new Set(parts.map((u) => u.path))];
    const choice = await reviewWith(ctx, `Commit ${i + 1} of ${plan.groups.length}: ${g.message}`, parts.map((u) => u.text).join('\n'), {
      title: `Commit ${i + 1} of ${plan.groups.length}: "${g.message}"?`,
      detail: `${parts.length} hunk${parts.length === 1 ? '' : 's'} in ${files.length === 1 ? files[0] : `${files.length} files`}, shown above.`,
      options: [
        { label: 'Yes, commit it', value: 'commit' },
        { label: 'Skip it: leave these changes uncommitted', value: 'skip' },
        { label: 'Stop here', value: null },
      ],
    });
    if (!choice) {
      stopped = true;
      break;
    }
    if (choice === 'skip') continue;
    const problem = await stageUnits(ctx, parts);
    if (problem) {
      ctx.note(`Couldn't stage "${g.message}": ${problem}`, 'error');
      await ctx.exec(['reset', '-q'], { quiet: true, refresh: false });
      stopped = true;
      break;
    }
    const c = await ctx.exec(['commit', '-q', '-m', g.message], { label: 'Committing' });
    if (!c.ok) {
      stopped = true;
      break;
    }
    made.push(g.message);
  }
  ctx.closeOverlay();
  await putBack();
  const left = ctx.data.status.files.length;
  const said = [
    `${made.length ? `Made ${made.length} commit${made.length === 1 ? '' : 's'}` : 'No commits made'}${stopped ? ', then stopped' : ''}`,
    ...made.map((m) => `  ${m}`),
    ...(left ? [`${left} file${left === 1 ? '' : 's'} still with uncommitted changes.`] : []),
    ...(plan.leftover.length ? [`Claude left ${plan.leftover.length} hunk${plan.leftover.length === 1 ? '' : 's'} out of every commit.`] : []),
  ];
  ctx.note(said.join('\n'), made.length ? 'ok' : 'info');
  return r;
}

/** Stages just these units (split hunks) of the working tree, found again by their changed lines. Returns a problem, or null. */
async function stageUnits(ctx, units) {
  const byPath = new Map();
  for (const u of units) byPath.set(u.path, [...(byPath.get(u.path) ?? []), u]);
  for (const [path, list] of byPath) {
    if (list.some((u) => u.whole)) {
      const r = await ctx.exec(['add', '--', path], { quiet: true, refresh: false });
      if (!r.ok) return firstLine(r.error.message);
      continue;
    }
    const fresh = parseDiff(await ctx.git(['diff', '--no-ext-diff', '--', path]));
    const { picks, missing } = picksBySignature(fresh, list.map((u) => u.signature));
    if (missing) return `${path} changed since Claude looked at it.`;
    const patch = buildPatch(fresh, picks);
    if (!patch) continue;
    const r = await apply(ctx, patch, ['--cached'], 'Staging', { refresh: false });
    if (!r.ok) return firstLine(r.error.message);
  }
  return null;
}

/**
 * Shows `text` (a diff) in the viewer and asks `req` under it. Its options get one more, to scroll through the
 * diff first; esc in the viewer comes back to the question.
 */
async function reviewWith(ctx, title, text, req) {
  for (;;) {
    let closed;
    const done = new Promise((resolve) => (closed = resolve));
    ctx.showText(title, text, { diff: true, onClosed: closed });
    const choice = await ctx.confirm({ ...req, options: [...req.options.slice(0, -1), { label: 'Scroll through the diff first (esc comes back here)', value: 'read' }, req.options.at(-1)] });
    if (choice !== 'read') return choice;
    await done;
  }
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

// How much of the file goes with lines to explain (either side), and how many of their commits.
const AROUND = 40;
const LINE_COMMITS = 30;

/**
 * e in blame: Claude explains why some lines are the way they are, from the lines (`picked`, blame rows),
 * the file around them (`all`, the whole blame) and the commits that changed them (git log -L, capped).
 * The answer opens in the viewer.
 */
export async function claudeBlame(ctx, path, picked, all, rev = null) {
  if (!needClaude(ctx)) return;
  const from = picked[0].line;
  const to = picked.at(-1).line;
  const what = from === to ? `line ${from} of ${path}` : `lines ${from}–${to} of ${path}`;
  if (picked.every((l) => l.commit.uncommitted)) {
    return ctx.note(`${from === to ? `Line ${from} isn't` : `Lines ${from}–${to} aren't`} committed yet, so there's no history to explain.`);
  }
  const around = all.filter((l) => l.line >= from - AROUND && l.line <= to + AROUND);
  const shown = rev && rev.replace(/^[0-9a-f]{40,64}/, short);
  const input = async () => {
    const { range, rev: at } = await linesRange(ctx, path, from, to, rev);
    const history = range ? await ctx.git(lineLogArgs(path, range, at, LINE_COMMITS)).catch((e) => `(git log -L failed: ${firstLine(e.message)})`) : '';
    return blameInput({ path, rev: shown, lines: picked, around, history });
  };
  const r = await askClaude(ctx, `explain ${what}`, blamePrompt(path, from, to), input, READ_ONLY);
  if (r.ok) ctx.showText(`Claude explains ${what}${shown ? ` at ${shown}` : ''}`, r.out, { markdown: true });
  return r;
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

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

/**
 * A folder or file dropped on the terminal, which types its path. A folder opens as /open would, or,
 * when it isn't in a repository, the Repos view lists the repositories inside it (as `splice <folder>`
 * does); a file in the open repository shows its history. False when `text` isn't the path of something
 * that's there, so it's taken as typing.
 */
export function openDropped(ctx, text) {
  const paths = droppedPaths(text);
  const kinds = paths?.map((p) => {
    try {
      return statSync(p).isDirectory() ? 'folder' : 'file';
    } catch {
      return null;
    }
  });
  if (!kinds || kinds.some((k) => !k)) return false;
  if (paths.length > 1) {
    ctx.note(`Drop one folder or file at a time (that was ${paths.length}).`, 'error');
    return true;
  }
  const [path] = paths;
  if (kinds[0] === 'folder') {
    ctx.openRepo(path, { silent: true }).then((opened) => opened || ctx.showReposIn(path));
    return true;
  }
  const root = ctx.data?.root;
  const rel = root && insideRepo(real(root), real(path));
  if (rel) fileHistory(ctx, rel);
  else ctx.note(`${basename(path)} isn't in ${root ? basename(root) : 'an open repository'}. Drop a file of the open repository to see its history, or a folder to open it.`, 'error');
  return true;
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
      y: (e) => ctx.copy(e.hash, `the hash of ${short(e.hash)}`),
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
