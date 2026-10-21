// Every git operation the UI offers, written once. Keys and slash commands both call these.
// `ctx` is the app's handle: data, exec, confirm, note, prefill, and so on (see App.jsx).
import { existsSync, realpathSync, statSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { READ_ONLY, blameInput, blamePrompt, changelogPrompt, clip, commitPrompt, lookPrompt, parseCommitMessage, parsePrDraft, parseResolution, parseSplit, prPrompt, resolveInput, resolvePrompt, splitInput, splitPrompt } from './claude.js';
import { absorbFiles, absorbSummary, absorbText, blameMap, blameTargets, groupPatch, lineRanges, planAbsorb } from './absorb.js';
import { cleanupChoice, cleanupCount, cleanupOptions, cleanupText, planCleanup, readCleanup } from './cleanup.js';
import { configFile, samePath } from './config.js';
import { doctorFindings, doctorText, ignoreLines, readDoctor } from './doctor.js';
import { MIN_GIT, atLeast, forecast, forecastLine, forecastText, gitVersion, unsupported } from './forecast.js';
import { droppedPaths, insideRepo } from './drop.js';
import { ignoreChoices, withIgnoreLine } from './ignore.js';
import { matchLineEndings, parseConflicts, takeSide, unifiedDiff } from './conflict.js';
import { blamePicker, historyPicker, lineLogArgs, linesRange, repoPath } from './history.js';
import { commentChar, messageFileText, readMessage } from './message.js';
import { MERGE_LABELS, bodyArgs, mergePrArgs, prIdFromUrl, prSource, releaseArgs } from './hosting.js';
import {
  backportArgs,
  backportBody,
  backportBranch,
  backportPicks,
  backportSteps,
  backportTitle,
  changelogArgs,
  changelogCount,
  changelogInput,
  commitsDraft,
  parseCommitLines,
  prNumber,
  reviewBranch,
  reviewPath,
  shipArgs,
  shipSteps,
  shippedEntry,
  shippedIn,
  withShipped,
  withoutShipped,
} from './prflow.js';
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
import { blobIds, checkCommits, foundCount, foundSummary, parseBatchCheck, parsePushLog, pushCheckText, pushLogArgs, pushRange } from './pushcheck.js';
import { eachLimited, fetchRepo } from './repos.js';
import { nextTheme, settingRows, settingSegments } from './settings.js';
import { forcePushes, forwardInput, planSync, rebasingElsewhere, syncSummary, syncText, updateBranchArgs } from './sync.js';
import { SIGNING_KEYS, checkGpgKey, explainSigning, needsPinentryCheck, signingConfig } from './signing.js';
import { fit } from './text.js';
import { DEFAULT_ACCENT, applyTheme, isColour, setAccent, theme } from './theme.js';
import {
  REFLOG_FORMAT,
  captureDiscard,
  describeUndo,
  dropDiscard,
  forgetCapture,
  lastRewrite,
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
    if (!(await checkBeforePush(ctx, pushRange({ upstream: branch.upstream, remote: named })))) return { ok: false };
    // Only a branch without an upstream starts tracking the remote it was pushed to.
    return ctx.exec(['push', ...flags, ...(branch.upstream ? [] : ['-u']), named, branch.head], { label: 'Pushing' });
  }
  if (!branch.upstream) {
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!remote) return ctx.note('This repository has no remote. Add one with: !remote add origin <url>', 'error');
    if (!(await checkBeforePush(ctx, pushRange()))) return { ok: false };
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
  if (!(await checkBeforePush(ctx, pushRange({ upstream: branch.upstream })))) return { ok: false };
  return ctx.exec(['push', ...flags], { label: 'Pushing' });
}

/**
 * Before a push: the commits in `range` (pushcheck.js's pushRange) are scanned for files over 50 MB and for
 * what look like secrets in their added lines. Anything found is listed in the viewer, and the push goes
 * ahead only if you say so. True to push. Off in /settings ("Check before pushing"); a check that can't
 * run doesn't hold the push up.
 */
async function checkBeforePush(ctx, range) {
  if (ctx.config.checkBeforePush === false) return true;
  let found = null;
  const r = await ctx.task(
    'Checking the commits to push',
    async (signal) => {
      const commits = parsePushLog(await ctx.git(pushLogArgs(range), { signal }));
      const ids = blobIds(commits);
      const sizes = ids.length ? parseBatchCheck(await ctx.git(['cat-file', '--batch-check'], { signal, input: `${ids.join('\n')}\n` })) : new Map();
      found = checkCommits(commits, sizes);
      return { stdout: '', stderr: '' };
    },
    { label: 'Checking the commits to push', refresh: false, quiet: true, quietError: true },
  );
  if (!r.ok) return !r.error?.cancelled && r.error?.message !== 'busy';
  if (!foundCount(found)) return true;
  ctx.showText(`Before pushing: ${foundSummary(found)}`, pushCheckText(found));
  const ok = await ctx.confirm({
    title: `Push anyway, with ${foundSummary(found)}?`,
    detail: 'Listed above, with where they are. No leaves everything as it is, to take them out first.',
    options: YES_NO('Yes, push anyway'),
    danger: true,
  });
  ctx.closeOverlay();
  return Boolean(ok);
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
 * R on a tag in Branches, /release <tag> [--draft] [title]: a GitHub or GitLab release for the tag, with notes
 * GitHub writes from what was merged since the last one (on GitLab, the commits since the tag before). Pushes
 * the tag first, since the release needs the server to have it. GitLab has no drafts.
 */
export async function createRelease(ctx, text) {
  if (!needRepo(ctx)) return;
  const { tag, title, draft, notesFile } = releaseArgs(text);
  if (!tag) return ctx.prefill('/release ');
  let notes;
  if (notesFile) {
    try {
      notes = (await readFile(resolve(ctx.data.root, notesFile), 'utf8')).replace(/\r\n/g, '\n').trim();
    } catch (e) {
      return ctx.note(`Couldn't read ${notesFile}: ${firstLine(e.message)}`, 'error');
    }
  }
  const host = needHost(ctx);
  if (!host) return;
  if (!host.createRelease) return ctx.note(`${host.name} has no releases made from tags: Splice only creates them on GitHub and GitLab. u pushes the tag.`, 'error');
  if (!ctx.data.refs.tags.some((t) => t.name === tag)) return ctx.note(`No tag called ${tag}. t on a commit in the graph makes one.`, 'error');
  const drafts = host.releaseDrafts !== false;
  if (draft && !drafts) return ctx.note(`${host.name} has no draft releases. Leave out --draft to publish it.`, 'error');
  const asDraft =
    draft ||
    (await ctx.confirm({
      title: `Create a ${host.name} release for ${tag}${title ? ` called "${title}"` : ''}?`,
      detail: `Pushes ${tag} to ${host.remoteName} first. ${notesFile ? `The notes are ${notesFile}.` : (host.releaseNotesBy ?? '')}`.trim(),
      options: [{ label: 'Yes, publish it', value: 'publish' }, ...(drafts ? [{ label: 'Save it as a draft', value: true }] : []), { label: 'No', value: null }],
    }));
  if (!asDraft) return;
  const pushed = await ctx.exec(['push', host.remoteName, `refs/tags/${tag}`], { label: 'Pushing tag', refresh: false });
  if (!pushed.ok) return pushed;
  return hostTask(ctx, `${host.kind === 'gitlab' ? 'glab' : 'gh'} release create ${tag}${asDraft === true ? ' --draft' : ''}`, (signal) => host.createRelease({ tag, title, draft: asDraft === true, ...(notes != null ? { notes } : {}) }, signal), {
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
    const detail = forecastLine(await forecastFor(ctx, 'HEAD', ref), 'merge');
    const ok = await ctx.confirm({ title: `Merge ${ref} into ${currentName(ctx)}?`, ...(detail ? { detail } : {}), options: YES_NO('Yes, merge') });
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
  const expect = forecastLine(await forecastFor(ctx, 'HEAD', ref), 'rebase');
  const ok = await ctx.confirm({
    title: `Rebase ${currentName(ctx)} onto ${ref}?`,
    detail: `${expect ? `${expect} ` : ''}Rewrites the commits on ${currentName(ctx)} that aren't on ${ref}. Avoid this on branches others use.`,
    options: YES_NO('Yes, rebase'),
  });
  if (!ok) return;
  const was = ctx.data.status.branch.oid;
  const r = await ctx.exec(['rebase', ref], { label: 'Rebasing' });
  if (r.ok && !ctx.data.state) afterRewrite(ctx, was);
  afterConflicts(ctx);
}

// Once a rebase has rewritten the branch (moved it from `was`), say how to see what it did to each commit.
function afterRewrite(ctx, was = null) {
  if (was && ctx.data.status.branch.oid === was) return;
  ctx.note(`${currentName(ctx)} is rewritten. /range-diff shows what changed in each commit.`);
}

/** A ref's commit: from the refs already loaded when it's a branch, else from git. Null when there's no such commit. */
async function commitOf(ctx, ref) {
  if (ref === 'HEAD') return ctx.data.status.branch.oid;
  const known = [...ctx.data.refs.local, ...ctx.data.refs.remote].find((b) => b.name === ref)?.oid;
  if (known) return known;
  return (await ctx.git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]).catch(() => '')).trim() || null;
}

/** Whether merging (or rebasing) `a` and `b` would conflict (forecast.js), or null when there's no telling. */
async function forecastFor(ctx, a, b) {
  try {
    const [x, y] = await Promise.all([commitOf(ctx, a), commitOf(ctx, b)]);
    return x && y ? await forecast(ctx.data.root, x, y, { oids: [x, y] }) : null;
  } catch {
    return null;
  }
}

/** /forecast <ref> [base]: whether merging ref and base (the default branch if not given) would conflict, and in which files. */
export async function forecastConflicts(ctx, text) {
  if (!needRepo(ctx)) return;
  const [ref, given] = splitArgs(text ?? '');
  if (!ref) return ctx.prefill('/forecast ');
  const base = given ?? defaultBranch(ctx.data.refs, ctx.data.remotes)?.ref;
  if (!base) return ctx.note(`Couldn't tell which branch is the default one. Say what to forecast against: /forecast ${ref} <base>`, 'error');
  const why = await unsupported(ctx.data.root);
  if (why) return ctx.note(why, 'error');
  return ctx.task(
    `Conflict forecast: ${ref} and ${base}`,
    async (signal) => {
      const [x, y] = await Promise.all([commitOf(ctx, ref), commitOf(ctx, base)]);
      if (!x || !y) throw new Error(`No branch, tag or commit called ${x ? base : ref}.`);
      if (x === y) return { stdout: `${ref} and ${base} are the same commit, so there's nothing to merge.`, stderr: '' };
      return { stdout: forecastText(await forecast(ctx.data.root, x, y, { signal, oids: [x, y] }), ref, base), stderr: '' };
    },
    { label: 'Forecasting conflicts', refresh: false },
  );
}

/**
 * /sync (S in Branches): fetches every remote, then brings each local branch with an upstream up to date
 * where it can do so without rewriting anything: a branch that's only behind is fast-forwarded (the one
 * checked out here with merge --ff-only, when there's nothing uncommitted; the others with update-ref,
 * never one checked out in another worktree). Branches that are ahead or have diverged stay as they are;
 * the report in the viewer says so, and for the current one, offers to rebase it onto its upstream.
 * Both moves are in the branch's reflog as "sync", so z undoes the current one's.
 */
export async function sync(ctx) {
  if (!needRepo(ctx)) return;
  if (ctx.data.state) return ctx.note(`A ${OP[ctx.data.state]} is in progress. Finish it first (/continue or /abort), then sync.`, 'error');
  if (!ctx.data.remotes.length) return ctx.note('This repository has no remote to sync with. /remote add <name> <url> adds one.', 'error');
  const fetched = await ctx.exec(['fetch', '--all', '--prune'], { label: 'Fetching' });
  if (!fetched.ok) return fetched;
  const { refs, status, worktrees, commonDir, gitDir, root } = ctx.data;
  const show = (p) => relative(root, p) || p;
  const elsewhere = new Map(worktrees.filter((w) => !w.current && w.branch).map((w) => [w.branch, show(w.path)]));
  for (const [b, path] of await rebasingElsewhere(commonDir, gitDir)) elsewhere.set(b, show(path));
  const dirty = status.files.some((f) => f.kind !== 'untracked');
  const plan = planSync({ refs, current: status.branch.head, elsewhere, dirty });
  const moved = [];
  const failed = [];
  if (plan.forward.length) {
    // One transaction, each branch moved only from where it was read: one that moved meanwhile stops it.
    const r = await ctx.exec(['update-ref', '--stdin', '-m', 'sync: fast-forward'], {
      input: forwardInput(plan.forward),
      label: 'Fast-forwarding branches',
      refresh: false,
      quiet: true,
      quietError: true,
    });
    if (r.ok) moved.push(...plan.forward.map((b) => b.name));
    else failed.push(...plan.forward.map((b) => ({ ...b, why: firstLine(r.error.message) })));
  }
  if (plan.current) {
    const b = plan.current;
    const r = await ctx.exec(['merge', '--ff-only', b.upstream], { label: 'Fast-forwarding', refresh: false, quietError: true, env: { GIT_REFLOG_ACTION: 'sync' } });
    if (r.ok) moved.push(b.name);
    else failed.push({ ...b, why: firstLine(r.error.message) });
  }
  await ctx.reload();
  const result = { moved, failed };
  ctx.showText('Sync', syncText(plan, result));
  ctx.note(syncSummary(plan, result), failed.length ? 'error' : 'ok');
  const mine = plan.diverged.find((b) => b.current);
  if (!mine) return;
  const expect = forecastLine(await forecastFor(ctx, 'HEAD', mine.upstream), 'rebase');
  const autostash = ctx.data.status.files.some((f) => f.kind !== 'untracked');
  const ok = await ctx.confirm({
    title: `${mine.name} and ${mine.upstream} have diverged. Rebase ${mine.name} onto ${mine.upstream}?`,
    detail: `${expect ? `${expect} ` : ''}Replays its ${mine.ahead} commit${mine.ahead === 1 ? '' : 's'} on the ${mine.behind} new one${mine.behind === 1 ? '' : 's'} there${
      autostash ? ', with your changes set aside (--autostash)' : ''
    }; then P pushes it.`,
    options: [
      { label: 'Yes, rebase it', value: true },
      { label: 'No, leave it', value: false },
    ],
  });
  if (!ok) return;
  ctx.closeOverlay();
  await ctx.exec(['rebase', '--autostash', mine.upstream], { label: 'Rebasing' });
  afterConflicts(ctx);
}

const count = async (ctx, range) => Number((await ctx.git(['rev-list', '--count', ...range, '--']).catch(() => '0')).trim()) || 0;
const lines = (s) => s.split('\n').filter(Boolean);
const names = (list) => (list.length > 4 ? `${list.slice(0, 4).join(', ')} and ${list.length - 4} more` : list.join(', '));

/**
 * /update-branch [base] [--stack] (B in Branches): rebases the current branch onto the latest default
 * branch (fetched first; or onto `base`), setting uncommitted changes aside meanwhile. When other local
 * branches are stacked on top of it, or with --stack, the whole stack is rebased with --update-refs
 * (git 2.38): from its top branch, so every branch in it moves, then back to this one. A branch already
 * pushed is offered a --force-with-lease push afterwards. Conflicts stop it as any rebase: /continue, /abort.
 */
export async function updateBranch(ctx, text) {
  if (!needRepo(ctx)) return;
  const { state } = ctx.data;
  if (state) return ctx.note(`A ${OP[state]} is in progress. Finish it first (/continue or /abort).`, 'error');
  const head = ctx.data.status.branch.head;
  if (!head) return ctx.note('HEAD is detached. Check out the branch to bring up to date first.', 'error');
  const args = updateBranchArgs(splitArgs(text ?? ''));
  if (args.error) return ctx.note(args.error, 'error');
  const def = defaultBranch(ctx.data.refs, ctx.data.remotes);
  const base = args.base ?? def?.ref;
  if (!base) return ctx.note("Couldn't tell which branch is the default one. Say what to rebase onto: /update-branch <base>", 'error');
  if (!args.base && (head === def.name || head === def.ref)) {
    return ctx.note(`${head} is the default branch itself. /sync (S in Branches) brings it up to date with ${def.ref}.`, 'error');
  }
  // The base's latest commits first, when it's a remote branch.
  const rb = ctx.data.refs.remote.find((b) => b.name === base);
  if (rb) {
    const r = await ctx.exec(['fetch', rb.remote, base.slice(rb.remote.length + 1)], { label: `Fetching ${base}` });
    if (!r.ok) return r;
  }
  if (!(await commitOf(ctx, base))) return ctx.note(`No branch, tag or commit called ${base}.`, 'error');
  if (await isAncestor(ctx, base, 'HEAD')) return ctx.note(`${head} already has everything on ${base}.`, 'ok');

  const { local, remote: remoteRefs } = ctx.data.refs;
  const oid = ctx.data.status.branch.oid;
  const elsewhere = new Set(ctx.data.worktrees.filter((w) => !w.current && w.branch).map((w) => w.branch));
  const [above, version, configured] = await Promise.all([
    // Branches with this one's commits and more: stacked on top of it.
    ctx.git(['for-each-ref', '--contains', 'HEAD', '--format=%(refname:short)', 'refs/heads']).then(lines, () => []),
    gitVersion(ctx.data.root),
    ctx.git(['config', '--bool', 'rebase.updateRefs']).then((s) => s.trim() === 'true', () => false),
  ]);
  const onTop = above.filter((n) => n !== head && local.find((b) => b.name === n)?.oid !== oid);
  // The stack's top: the one branch on top that none of the others contain. Branches that fork can't move in one rebase.
  const tops = onTop.length ? lines(await ctx.git(['merge-base', '--independent', ...onTop]).catch(() => '')).map((h) => onTop.filter((n) => local.find((b) => b.name === n)?.oid === h)).flat() : [];
  const canUpdateRefs = atLeast(version, MIN_GIT);
  if (args.stack && !canUpdateRefs) return ctx.note(`Moving a stack of branches needs git ${MIN_GIT.join('.')} or later (rebase --update-refs).`, 'error');
  const top = canUpdateRefs && tops.length === 1 && !elsewhere.has(tops[0]) ? tops[0] : null;
  const stack = canUpdateRefs && (args.stack || Boolean(top));
  const target = top ?? head;
  const updateRefs = stack || configured;
  // The branches whose tips are among the commits being replayed: --update-refs moves them (not ones checked out elsewhere).
  const inside = (await ctx.git(['for-each-ref', '--merged', target, '--no-merged', base, '--format=%(refname:short)', 'refs/heads']).then(lines, () => []))
    .filter((n) => n !== target);
  const moving = updateRefs ? inside.filter((n) => !elsewhere.has(n)) : [];
  const branchOf = (n) => local.find((b) => b.name === n);
  // A branch is pushed when its upstream has commits the base doesn't: rebasing rewrites them.
  const rewritten = [target, ...moving];
  const pushed = (
    await Promise.all(
      rewritten.map(async (n) => {
        const b = branchOf(n);
        const live = b?.upstream && !b.gone && remoteRefs.some((r) => r.name === b.upstream);
        return live && (await count(ctx, [b.upstream, `^${base}`])) > 0 ? { name: n, upstream: b.upstream } : null;
      }),
    )
  ).filter(Boolean);
  const [n, f] = await Promise.all([count(ctx, [target, `^${base}`]), forecastFor(ctx, target === head ? 'HEAD' : target, base)]);
  const autostash = ctx.data.status.files.some((x) => x.kind !== 'untracked');

  // The whole story goes in the viewer, so the question's one line can say what matters most.
  const story = [
    `Replays ${n} commit${n === 1 ? '' : 's'}${top ? ` of ${top}, the top of the stack,` : ` of ${head}`} on top of ${base}${autostash ? ', setting your uncommitted changes aside meanwhile and putting them back after (--autostash)' : ''}.`,
    moving.length ? `Moves with it (--update-refs):\n${moving.map((m) => `  ${m}`).join('\n')}${top ? `\nThen switches back to ${head}.` : ''}` : '',
    !updateRefs && inside.length ? `${names(inside)} ${inside.length === 1 ? 'sits' : 'sit'} under ${head} and stay${inside.length === 1 ? 's' : ''} where ${inside.length === 1 ? 'it is' : 'they are'}: /update-branch --stack moves ${inside.length === 1 ? 'it' : 'them'} too.` : '',
    tops.length > 1 ? `${names(onTop)} are on top of ${head} but fork into separate stacks, so they stay where they are.` : '',
    tops.length === 1 && !top ? (canUpdateRefs ? `${tops[0]} is on top of ${head} but checked out in another worktree, so it stays where it is.` : `${names(onTop)} on top of ${head} stay${onTop.length === 1 ? 's' : ''} where they are: moving them needs git ${MIN_GIT.join('.')} or later.`) : '',
    pushed.length ? `Already pushed: ${pushed.map((p) => `${p.name} (${p.upstream})`).join(', ')}. Rebasing rewrites ${pushed.length === 1 ? 'it' : 'them'}, so you'll be asked about a force push (--force-with-lease) once it's done.` : '',
    forecastLine(f, 'rebase'),
  ].filter(Boolean);
  ctx.showText(top ? `Update the stack under ${top}` : `Update ${head}`, story.join('\n\n'));
  const ok = await ctx.confirm({
    title: top ? `Rebase the stack under ${top} onto ${base}?` : `Rebase ${head} onto ${base}?`,
    detail: [pushed.length ? `${names(pushed.map((p) => p.name))} ${pushed.length === 1 ? 'is' : 'are'} already pushed.` : '', forecastLine(f, 'rebase'), 'More above.'].filter(Boolean).join(' '),
    options: YES_NO('Yes, rebase'),
    danger: pushed.length > 0,
  });
  ctx.closeOverlay();
  if (!ok) return;
  // --update-refs leaves alone a branch checked out anywhere, this one included, so HEAD lets go of it
  // first (on the same commit, so nothing else changes); the rebase then checks out the top.
  if (top && !(await ctx.exec(['switch', '--detach'], { label: 'Letting go of the branch', refresh: false, quiet: true })).ok) return;
  const r = await ctx.exec(['rebase', '--autostash', ...(stack ? ['--update-refs'] : []), base, ...(top ? [top] : [])], { label: 'Rebasing' });
  if (ctx.data.state) {
    afterConflicts(ctx);
    if (top) ctx.note(`Once it's done you'll be on ${top}, the top of the stack: ↵ on ${head} in Branches switches back.`);
    return r;
  }
  // Back on the branch you were on, also when the rebase couldn't start.
  if (top) {
    const back = await ctx.exec(['switch', head], { label: 'Switching back' });
    if (!back.ok) return back;
  }
  if (!r.ok || !pushed.length) return r;
  const push = await ctx.confirm({
    title: `Force-push ${names(pushed.map((p) => p.name))}?`,
    detail: `Replaces ${names(pushed.map((p) => p.upstream))} with the rebased commits. Uses --force-with-lease, so it stops if someone else pushed.`,
    options: YES_NO('Yes, force-push'),
    danger: true,
  });
  if (!push) return ctx.note(`Not pushed. /push --force sends ${head} when you're ready.`);
  for (const p of forcePushes(pushed, ctx.data.remotes)) {
    const done = await ctx.exec(p, { label: 'Pushing' });
    if (!done.ok) return done;
  }
}

const OP = { merging: 'merge', rebasing: 'rebase', 'cherry-picking': 'cherry-pick', reverting: 'revert', bisecting: 'bisect' };

export async function continueOp(ctx) {
  if (!needRepo(ctx)) return;
  const { state } = ctx.data;
  if (!state) return ctx.note('There is no merge, rebase, cherry-pick or revert in progress.', 'error');
  if (state === 'bisecting') return ctx.note('A bisect goes on as you mark commits: B on one in the graph, or /bisect good, bad or skip.', 'error');
  if (ctx.data.changes.conflicts.length) return ctx.note('Some files still have conflicts. Resolve and stage them first.', 'error');
  // A merge is finished by committing it; the others have --continue.
  const r = await ctx.exec(state === 'merging' ? ['commit', '--no-edit'] : [OP[state], '--continue'], { label: 'Continuing' });
  if (!ctx.data.state) {
    await cleanup(ctx.data.gitDir);
    if (r.ok && state === 'rebasing') afterRewrite(ctx);
    // A /backport that stopped on a conflict goes on: push, then the pull request.
    if (r.ok && state === 'cherry-picking') {
      const waiting = await readBackport(ctx);
      if (waiting && waiting.name === ctx.data.status.branch.head) return finishBackport(ctx, waiting);
    }
  }
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
  if (!ctx.data.state) {
    await cleanup(ctx.data.gitDir);
    const waiting = state === 'cherry-picking' && (await readBackport(ctx));
    if (waiting) {
      await rm(backportFile(ctx), { force: true });
      ctx.note(`The backport of ${waiting.label} to ${waiting.branch} stopped. ${waiting.name} stays, with what was picked before: d in Branches deletes it.`);
    }
  }
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
  // With a good and a bad commit marked, git can test the rest itself.
  const marks = on ? await bisectMarks(ctx) : {};
  const how = await ctx.confirm({
    title: on ? `Mark ${short(c.hash)} as` : `Find the commit that brought in a problem: is ${short(c.hash)} bad or good?`,
    detail: on ? c.subject : 'Then mark one of the other kind, and git checks out commits in between for you to try, halving the range each time.',
    options: [
      { label: 'Bad: it has the problem', value: 'bad' },
      { label: 'Good: from before the problem', value: 'good' },
      ...(on ? [{ label: "Skip: can't tell (it doesn't build, say)", value: 'skip' }] : []),
      ...(marks.good && marks.bad ? [{ label: 'Run a command on each commit to test it for me (/bisect run)', value: 'run' }] : []),
      { label: 'Cancel', value: null },
    ],
  });
  if (how === 'run') return ctx.prefill('/bisect run ');
  if (how) await bisect(ctx, how, c.hash);
}

/** Whether the bisect in progress has a bad commit and a good one marked. */
async function bisectMarks(ctx) {
  const refs = (await ctx.git(['for-each-ref', '--format=%(refname)', 'refs/bisect/']).catch(() => '')).split('\n');
  return { bad: refs.includes('refs/bisect/bad'), good: refs.some((r) => r.startsWith('refs/bisect/good')) };
}

// The end of a bisect: the cursor goes to the commit, and the activity line names it.
async function foundIt(ctx, hash) {
  const subject = (await ctx.git(['log', '-1', '--format=%s', hash]).catch(() => '')).trim();
  ctx.showInGraph(hash);
  ctx.note(`Found it: ${short(hash)} is the first bad commit${subject ? `, "${subject}"` : ''}.\nThe cursor is on it in the graph (↵ shows its diff). /abort ends the bisect and goes back to where you were.`);
}

/**
 * /bisect run <command…>: once a bad and a good commit are marked, git tests the rest itself, running the
 * command on each commit it checks out. Its exit code says how that went: 0 good, 125 skip (can't be
 * tested), any other up to 127 bad; 128 or more stops the run. The words go to git as they are, and git
 * runs them in its own shell (sh, Git Bash's on Windows) at the top of the repository. esc stops it,
 * leaving the bisect where it got to.
 */
export async function bisectRun(ctx, words) {
  if (!needRepo(ctx)) return;
  if (ctx.data.state !== 'bisecting') {
    return ctx.note('Start a bisect first: B on a commit in the graph marks it bad or good. With one of each, /bisect run <command> tests the rest.', 'error');
  }
  if (!words.length) return ctx.prefill('/bisect run ');
  const marks = await bisectMarks(ctx);
  if (!marks.bad || !marks.good) return ctx.note(`Mark a ${marks.bad ? 'good' : 'bad'} commit too (B in the graph), so git knows which commits to test.`, 'error');
  const shown = words.map((w) => (/[\s"]/.test(w) || w === '' ? JSON.stringify(w) : w)).join(' ');
  // stdin closed, so a command that reads it doesn't wait for ever.
  const r = await ctx.exec(['bisect', 'run', ...words], { label: 'Testing each commit', input: '', tree: true });
  if (r.error?.cancelled) {
    return ctx.note('Stopped the bisect run. The bisect stays where it got to, with what was tested so far marked:\n/bisect run again, B on the commit checked out to go on by hand, or /abort to stop.');
  }
  ctx.showText(`git bisect run ${shown}`, r.ok ? r.out : r.error.message);
  const found = r.ok && firstBadCommit(r.out);
  if (found) await foundIt(ctx, found);
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
  if (found) await foundIt(ctx, found);
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
/**
 * i on an untracked file in Changes: asks what to ignore (the file, its folder, every file with its
 * extension, or the file in its own folder's .gitignore) and adds that line. A tracked file can't be
 * ignored that way; it says how to stop tracking it.
 */
export async function ignoreFile(ctx, f) {
  if (!needRepo(ctx)) return;
  if (f.kind !== 'untracked') {
    const path = /[\s"']/.test(f.path) ? JSON.stringify(f.path) : f.path;
    return ctx.note(
      `${f.path} is tracked, and .gitignore only keeps untracked files out.\nTo stop tracking it but keep the file: !rm --cached ${path}, then i on it here, and commit both.`,
      'error',
    );
  }
  const choice = await ctx.confirm({
    title: `Ignore ${f.path}?`,
    detail: 'Adds a line to the .gitignore, which shows here as a change to commit.',
    options: [...ignoreChoices(f.path).map((c) => ({ label: c.label, value: c })), { label: 'Cancel', value: null }],
  });
  if (choice) return addIgnore(ctx, choice.file, choice.pattern);
}

/** /ignore <pattern>: adds it to the repository's .gitignore as typed. */
export function ignore(ctx, text) {
  if (!needRepo(ctx)) return;
  const pattern = (text ?? '').trim();
  if (!pattern) return ctx.prefill('/ignore ');
  return addIgnore(ctx, '.gitignore', pattern);
}

// Adds `pattern` to `file` (a .gitignore, relative to the root, made if missing) in its own line endings.
async function addIgnore(ctx, file, pattern) {
  const path = join(ctx.data.root, ...file.split('/'));
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') return ctx.note(`Couldn't read ${file}: ${firstLine(e.message)}`, 'error');
  }
  const next = withIgnoreLine(text, pattern);
  if (!next.added) return ctx.note(`${file} has ${pattern} already.`, 'error');
  try {
    await writeFile(path, next.text);
  } catch (e) {
    return ctx.note(`Couldn't write ${file}: ${firstLine(e.message)}`, 'error');
  }
  await ctx.reload();
  ctx.note(`Added ${pattern} to ${file}${text ? '' : ', a new file'}.\nCommit ${file} as well (it's in Changes), so the repository keeps ignoring it.`);
}

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
  forgetGoneShipped(ctx);
  // On a branch you shipped (/ship) whose pull request has been merged since: finishing it switches to the
  // default branch first, which the cleanup alone never does (it leaves the current branch), then the rest.
  const shipping = ctx.host()?.pr && shippedEntry(ctx.config, repoKey(ctx), ctx.data.status.branch.head);
  if (shipping) {
    const got = await hostRead(ctx, `Is ${shipping.label} merged?`, (signal) => ctx.host().pr(shipping.id, signal), 'Asking about the pull request');
    if (got.ok && got.value.state === 'merged') await finishShipped(ctx, shipping, got.value);
  }
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
  await removeCleanup(ctx, cleanupChoice(plan, choice));
  forgetGoneShipped(ctx);
}

/**
 * Removes what a cleanup plan (or the part of one picked) lists: worktrees first, with a plain `git worktree
 * remove`; then the branches, with -d (and -D for those it refuses only because they aren't merged into
 * HEAD, already checked against the remotes, the default branch and the pull requests); then the branches
 * on the remote. Says what went, and what couldn't and why. /cleanup and /ship's finishing both use it.
 */
async function removeCleanup(ctx, { worktrees, branches, remote }) {
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
  return { deleted, removed: [...removed], problems, stopped };
}

/**
 * /doctor: a health report of the repository in the viewer, each finding with what to do (doctor.js). What
 * Splice can do itself (set upstreams, drop stashes already in HEAD, renormalise line endings, ignore big
 * untracked files, git gc) it offers after the report.
 */
export async function doctor(ctx) {
  if (!needRepo(ctx)) return;
  const { root, gitDir, commonDir } = ctx.data;
  let findings;
  const read = await ctx.task(
    'Checking the repository',
    async (signal) => {
      findings = doctorFindings(await readDoctor({ root, gitDir, commonDir, data: ctx.data, signal }));
      return { stdout: '', stderr: '' };
    },
    { label: 'Checking the repository', refresh: false, quiet: true },
  );
  if (!read.ok) return read;
  if (!findings.length) return ctx.note('The repository looks healthy: nothing for /doctor to report.', 'ok');
  ctx.showText(`Doctor: ${findings.length === 1 ? '1 thing' : `${findings.length} things`} to look at`, doctorText(findings));
  const fixes = findings.filter((f) => f.action);
  if (!fixes.length) return;
  const choice = await ctx.confirm({
    title: fixes.length === 1 ? `${fixes[0].action.label}?` : `Do ${fixes.length} of these now?`,
    detail: 'Listed above, with what each one does.',
    options: [
      ...(fixes.length > 1 ? [{ label: 'All of them', value: 'all' }] : []),
      ...fixes.map((f) => ({ label: fixes.length === 1 ? `Yes, ${f.action.label[0].toLowerCase()}${f.action.label.slice(1)}` : f.action.label, value: f.id })),
      { label: 'No, leave them', value: false },
    ],
    danger: fixes.some((f) => f.action.danger),
  });
  ctx.closeOverlay();
  if (!choice) return;
  const done = [];
  const problems = [];
  for (const f of fixes.filter((x) => choice === 'all' || x.id === choice)) {
    const step = async (args, label) => {
      const r = await ctx.exec(args, { label, refresh: false });
      if (!r.ok && !r.error?.cancelled) problems.push(firstLine(r.error.message));
      return r.ok;
    };
    const { action } = f;
    let ok = true;
    if (action.kind === 'upstream') {
      for (const it of action.items) ok = (await step(['branch', `--set-upstream-to=${it.upstream}`, it.branch], 'Setting the upstream')) && ok;
    } else if (action.kind === 'drop') {
      // Highest first, so dropping one doesn't renumber the others still to go.
      const n = (ref) => Number(/\{(\d+)\}/.exec(ref)?.[1] ?? 0);
      for (const ref of [...action.refs].sort((a, b) => n(b) - n(a))) ok = (await step(['stash', 'drop', ref], 'Dropping the stash')) && ok;
    } else if (action.kind === 'renormalize') {
      ok = await step(['add', '--renormalize', '.'], 'Renormalising the line endings');
    } else if (action.kind === 'gc') {
      ok = await step(['gc'], 'Packing objects');
    } else if (action.kind === 'ignore') {
      try {
        const file = join(root, '.gitignore');
        const before = existsSync(file) ? await readFile(file, 'utf8') : '';
        await writeFile(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${ignoreLines(action.paths).join('\n')}\n`);
      } catch (e) {
        ok = false;
        problems.push(`.gitignore: ${e.message}`);
      }
    }
    if (ok) done.push(action.label);
  }
  await ctx.reload();
  ctx.note([done.length ? `Done: ${done.join('; ')}` : 'Nothing was done', ...problems].join('\n'), problems.length ? 'error' : 'ok');
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

/**
 * C on commits selected in the graph (V), and /cherry-pick <a>..<b>: copies them onto the current branch,
 * `list` oldest first, in one git cherry-pick, so /continue after a conflict goes on with the rest. Merge
 * commits are refused: git would need telling which side of each to keep, so C takes those one at a time.
 */
export async function cherryPickMany(ctx, list) {
  if (!needRepo(ctx)) return;
  if (!list.length) return ctx.note('No commits to cherry-pick.', 'error');
  if (list.length === 1) return cherryPick(ctx, list[0]);
  const { state } = ctx.data;
  if (state) return ctx.note(`A ${OP[state]} is in progress. Finish it first (/continue or /abort).`, 'error');
  const merges = list.filter((c) => c.parents.length > 1);
  if (merges.length) {
    const one = merges.length === 1;
    return ctx.note(
      `${merges.map((c) => short(c.hash)).join(', ')} ${one ? 'is a merge commit' : 'are merge commits'}, which can't be picked along with others: git would need telling which side of each to keep.\nLeave ${one ? 'it' : 'them'} out of the selection, or cherry-pick ${one ? 'it' : 'each'} on its own with C (which keeps the side it was merged into).`,
      'error',
    );
  }
  // Commits the branch has already would come out empty, and stop the pick.
  const onto = currentName(ctx);
  const out = await ctx.git(['rev-list', ...list.map((c) => c.hash), '--not', 'HEAD']).catch(() => null);
  const outside = out == null ? null : new Set(out.split('\n').filter(Boolean));
  const picks = outside ? list.filter((c) => outside.has(c.hash)) : list;
  const had = list.filter((c) => !picks.includes(c));
  if (!picks.length) return ctx.note(`${onto} has ${list.length === 2 ? 'both' : 'all'} of them already.`, 'error');
  const line = (c) => `${short(c.hash)}  ${c.subject}`;
  const text = [...picks.map(line), ...(had.length ? ['', `Left out, as ${onto} has them already:`, ...had.map(line)] : [])].join('\n');
  // The list goes in the viewer, so the question stays short however many there are.
  ctx.showText(`Cherry-pick onto ${onto}, oldest first`, text);
  const ok = await ctx.confirm({
    title: `Cherry-pick ${picks.length === 1 ? 'this commit' : `these ${picks.length} commits`} onto ${onto}, oldest first?`,
    detail: 'Listed above. If one stops on a conflict, fix it in Changes, then /continue goes on with the rest (or /abort).',
    options: YES_NO('Yes, cherry-pick'),
  });
  ctx.closeOverlay();
  if (!ok) return;
  await ctx.exec(['cherry-pick', ...picks.map((c) => c.hash)], { label: 'Cherry-picking' });
  afterConflicts(ctx);
}

/** /cherry-pick <ref>: one commit, as C does it; /cherry-pick <a>..<b>: the commits in a..b, oldest first. */
export async function cherryPickRefs(ctx, text) {
  if (!needRepo(ctx)) return;
  const spec = (text ?? '').trim();
  if (!spec) return ctx.prefill('/cherry-pick ');
  if (spec.includes('...')) return ctx.note('Give a range as a..b: the commits b has that a doesn\'t.', 'error');
  if (!spec.includes('..')) {
    let c;
    try {
      [c] = parseCommitList(await ctx.git(['log', '-1', '--no-walk', `--format=${COMMIT_LIST_FORMAT}`, spec, '--']));
    } catch {
      // Not a commit; said below.
    }
    return c ? cherryPick(ctx, c) : ctx.note(`No commit called ${spec}.`, 'error');
  }
  let list;
  try {
    list = parseCommitList(await ctx.git(['log', '--reverse', '--topo-order', `--format=${COMMIT_LIST_FORMAT}`, spec, '--']));
  } catch (e) {
    return ctx.note(`Couldn't list ${spec}: ${firstLine(e.message)}`, 'error');
  }
  if (!list.length) return ctx.note(`There are no commits in ${spec}.`, 'error');
  return cherryPickMany(ctx, list);
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
  const was = branch.oid;
  const r = await ctx.exec(['rebase', '-i', base ?? '--root'], { label: 'Rebasing', env });
  if (!ctx.data.state) {
    await cleanup(ctx.data.gitDir);
    if (r.ok) afterRewrite(ctx, was);
  } else if (ctx.data.changes.conflicts.length) afterConflicts(ctx);
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
  if (r.ok && !ctx.data.state) afterRewrite(ctx);
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
  if (!host) ctx.note("This repository's remote isn't on GitHub, Azure DevOps or GitLab, so there are no pull requests to show.", 'error');
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
const cliName = (host) => ({ github: 'gh pr', gitlab: 'glab mr' })[host.kind] ?? 'az repos pr';

// What the activity line says a merge ran, in the host's CLI's own words.
function mergeTitle(host, pr, { method, deleteBranch, auto }) {
  if (host.kind === 'github') return `gh pr merge ${pr.id} --${method}${deleteBranch ? ' --delete-branch' : ''}${auto ? ' --auto' : ''}`;
  if (host.kind === 'gitlab') return `glab mr merge ${pr.id}${method === 'merge' ? '' : ` --${method}`}${deleteBranch ? ' --remove-source-branch' : ''}${auto ? ' --auto-merge' : ''}`;
  return `az repos pr update --id ${pr.id} ${auto ? '--auto-complete' : '--status completed'}`;
}

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
  const r = await hostTask(ctx, mergeTitle(host, pr, opts), (signal) => host.merge(pr, opts, signal), { label: opts.auto ? 'Setting auto-merge' : 'Merging', refresh: false });
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
 * review's body); Azure DevOps votes "waiting for the author" and posts the text, if any, as a comment;
 * GitLab, with no such vote on every plan, posts the text (which it needs) and takes back your approval.
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

// What a pull request into `target` is compared with: the server's copy of it when there is one, as the PR will be.
function prBase(ctx, target) {
  const { remotes } = ctx.data;
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  return ctx.data.refs.remote.some((b) => b.name === `${remote}/${target}`) ? `${remote}/${target}` : target;
}

// Claude drafts a pull request of `branch` into `target` from its commits (`log`, oldest first) and its diff against `base`.
async function claudeDraft(ctx, branch, target, base, log) {
  const r = await askClaude(ctx, 'pull request', prPrompt(branch, target), async () =>
    `${log.trim()}\n\n${await ctx.git(['diff', '--stat', '--patch', '-M', `${base}...HEAD`])}`,
  );
  return r.ok ? { r, ...parsePrDraft(r.out) } : { r };
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
  const base = prBase(ctx, target);
  const log = await ctx.git(['log', '--reverse', '--format=%s%n%n%b', `${base}..HEAD`]).catch(() => '');
  if (!log.trim()) return ctx.note(`${branch.head} has no commits that aren't in ${base}, so there's nothing to open a pull request for.`, 'error');
  const { r, title, body } = await claudeDraft(ctx, branch.head, target, base, log);
  if (!r.ok) return r;
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

// Pull request flows: /ship, /review-pr, /backport and /changelog. Their pure parts (arguments, plans, the
// state kept) are in prflow.js; they reach the server only through the host's own methods.

// A read from the PR host with the spinner (esc cancels it): { ok: true, value }, or the task's failure.
async function hostRead(ctx, title, fn, label = 'Asking the server') {
  let value;
  const r = await ctx.task(
    title,
    async (signal) => {
      value = await fn(signal);
      return { stdout: '', stderr: '' };
    },
    { label, refresh: false, quiet: true },
  );
  return r.ok ? { ok: true, value } : r;
}

// Shipped branches are kept per repository, by its common git dir, which its worktrees share.
const repoKey = (ctx) => ctx.data.commonDir;
const forgetShipped = (ctx, branch) => ctx.setConfig((c) => withoutShipped(c, repoKey(ctx), (e) => e.branch === branch));

// Shipped branches that are gone (deleted by /cleanup, say) are no longer worth watching.
function forgetGoneShipped(ctx) {
  const names = new Set(ctx.data.refs.local.map((b) => b.name));
  if (shippedIn(ctx.config, repoKey(ctx)).some((e) => !names.has(e.branch))) ctx.setConfig((c) => withoutShipped(c, repoKey(ctx), (e) => !names.has(e.branch)));
}

const howLabel = (method) => (MERGE_LABELS[method] ?? method).replace(/ and merge$/, '').toLowerCase();

/**
 * /ship [--into <branch>]: from a feature branch, in one go once you've seen the plan and said yes: pushes it
 * (the first push setting its upstream), opens its pull request with the title and description Claude drafts
 * (unless it has one open already), and turns on auto-merge with the repository's usual method (asked the
 * first time, then remembered as `shipMethods` in the config). The branch is then remembered as shipped
 * (`shipped`), and once its pull request is merged Splice offers to finish it (finishShipped). On a branch
 * shipped before, it finishes it if merged, and otherwise pushes what's new and turns auto-merge on again.
 */
export async function ship(ctx, text) {
  const host = needHost(ctx);
  if (!host) return;
  const args = shipArgs(text);
  if (args.error) return ctx.note(args.error, 'error');
  const { branch } = ctx.data.status;
  if (!branch.head) return ctx.note('HEAD is detached. Check out the branch you want to ship.', 'error');
  if (ctx.data.state) return ctx.note(`A ${OP[ctx.data.state]} is in progress. Finish it first (/continue or /abort).`, 'error');
  const repo = repoKey(ctx);
  const entry = shippedEntry(ctx.config, repo, branch.head);
  // Its pull request from the last /ship, while it's still open.
  let shipped = null;
  if (entry && host.pr) {
    const got = await hostRead(ctx, `Is ${entry.label} merged?`, (signal) => host.pr(entry.id, signal), 'Asking about the pull request');
    if (!got.ok) return got;
    if (got.value.state === 'merged') return finishShipped(ctx, entry, got.value);
    if (got.value.state === 'open') shipped = got.value;
    else {
      forgetShipped(ctx, entry.branch);
      ctx.note(`${entry.label} was closed without being merged, so /ship opens a new pull request.`);
    }
  }
  const local = ctx.data.refs.local.find((b) => b.name === branch.head);
  const source = (local && prSource(local, host.remoteName)) ?? branch.head;
  const listed = await hostRead(ctx, `Open pull requests on ${host.name}`, () => host.list());
  if (!listed.ok) return listed;
  const open = listed.value.find((p) => p.source === source && (!args.target || p.target === args.target)) ?? (shipped && (!args.target || shipped.target === args.target) ? shipped : null);
  const target = open?.target ?? args.target ?? (await findDefaultBranch(ctx)).name;
  if (!target) return ctx.note('Say which branch it goes into: /ship --into <branch>', 'error');
  if (target === branch.head) return ctx.note(`You're on ${target}, the branch pull requests go into. /ship works from a feature branch.`, 'error');
  const base = prBase(ctx, target);
  const log = await ctx.git(['log', '--reverse', '--format=%s%n%n%b', `${base}..HEAD`]).catch(() => '');
  if (!open && !log.trim()) return ctx.note(`${branch.head} has no commits that aren't in ${base}, so there's nothing to ship.`, 'error');
  const remote = branch.upstream ? branch.upstream.split('/')[0] : host.remoteName;
  const toPush = !branch.upstream ? { first: true } : branch.ahead ? { count: branch.ahead } : null;
  const methods = host.mergeMethods ?? ['merge'];
  let method = ctx.config.shipMethods?.[repo];
  for (;;) {
    if (!methods.includes(method)) {
      method = await ctx.confirm({
        title: `How should ${host.name} merge ${branch.head} into ${target}?`,
        detail: 'Splice remembers it for /ship in this repository; the plan comes next.',
        options: [...methods.map((m) => ({ label: MERGE_LABELS[m], value: m })), { label: 'Cancel', value: null }],
      });
      if (!method) return;
      const chosen = method;
      ctx.setConfig((c) => ({ ...c, shipMethods: { ...c.shipMethods, [repo]: chosen } }));
    }
    const steps = shipSteps({ branch: branch.head, target, remote, hostName: host.name, push: toPush, open, claude: Boolean(ctx.askClaude), method });
    ctx.showText(`Ship ${branch.head} into ${target}`, steps.join('\n'), { markdown: true });
    const go = await ctx.confirm({
      title: `Ship ${branch.head} into ${target}?`,
      detail: 'Listed above: each step in turn, stopping if one fails.',
      options: [
        { label: 'Yes, ship it', value: 'go' },
        { label: `Merge another way than ${howLabel(method)}`, value: 'method' },
        { label: 'No', value: null },
      ],
    });
    ctx.closeOverlay();
    if (go === 'go') break;
    if (go !== 'method') return;
    method = null;
  }
  if (toPush) {
    const pushed = await push(ctx);
    if (!pushed?.ok) return pushed;
  }
  let pr = open;
  if (!pr) {
    let draft = null;
    if (ctx.askClaude) {
      const d = await claudeDraft(ctx, branch.head, target, base, log);
      if (!d.r.ok) return d.r;
      if (d.title) draft = { title: d.title, body: d.body };
    }
    draft ??= commitsDraft(parseCommitLines(await ctx.git(['log', '--reverse', '--format=%H%x1f%s', `${base}..HEAD`]).catch(() => '')));
    if (!draft.title) return ctx.note('There was no title to open the pull request with. Open it yourself: /pr <title>', 'error');
    const made = await hostTask(ctx, `${cliName(host)} create "${draft.title}"`, (signal) => host.create({ title: draft.title, body: draft.body, source: branch.head, target }, signal), {
      label: 'Opening pull request',
      refresh: false,
    });
    if (!made.ok) return made;
    ctx.prsChanged();
    const id = prIdFromUrl(made.out);
    const found = await hostRead(ctx, 'The new pull request', async (signal) =>
      id != null && host.pr ? host.pr(id, signal) : (await host.list()).find((p) => p.source === source && p.target === target),
    );
    if (!found.ok || !found.value) return ctx.note("The pull request is open, but Splice couldn't find it again to turn on auto-merge: m on it in PRs does that.", 'error');
    pr = found.value;
  }
  ctx.setConfig((c) => withShipped(c, { repo, branch: branch.head, id: pr.id, label: pr.label, title: pr.title, url: pr.url, target: pr.target, at: Date.now() }));
  const opts = { method, deleteBranch: true, auto: true };
  const r = await hostTask(ctx, mergeTitle(host, pr, opts), (signal) => host.merge(pr, opts, signal), { label: 'Setting auto-merge', refresh: false });
  ctx.prsChanged();
  if (r.ok) ctx.note(`Shipped ${branch.head}: ${pr.label} merges into ${pr.target} once its checks and reviews pass.\nOnce it has, Splice offers to finish: switch to ${pr.target}, pull it and delete ${branch.head}.`, 'ok');
  return r;
}

/**
 * Finishing a shipped branch whose pull request (`pr`, from host.pr) was merged, after asking: switches to
 * the default branch (when you're on the shipped one; from a worktree of its own, Splice opens the main
 * working tree instead), pulls it, then deletes the branch and its worktree by /cleanup's rules and with its
 * code, so a branch with commits that are only here, or a worktree with changes, stays.
 */
export async function finishShipped(ctx, entry, pr) {
  if (!needHost(ctx)) return;
  if (!ctx.data.refs.local.some((b) => b.name === entry.branch)) {
    forgetShipped(ctx, entry.branch);
    return ctx.note(`${entry.label} was merged, and ${entry.branch} is gone already.`, 'ok');
  }
  const def = (await findDefaultBranch(ctx)).name ?? entry.target;
  const here = ctx.data.status.branch.head;
  const wt = ctx.data.worktrees.find((w) => w.branch === entry.branch);
  const main = ctx.data.worktrees.find((w) => w.main);
  const away = Boolean(wt?.current && !wt.main && main);
  const switching = !away && here === entry.branch;
  const steps = [
    away ? `open the main working tree (${basename(main.path)})` : switching ? `switch to ${def}` : null,
    switching || here === def || (away && main.branch === def) ? `pull ${def}` : 'fetch',
    `delete ${entry.branch}${wt && !wt.main ? ` and its worktree ${basename(wt.path)}` : ''}`,
  ].filter(Boolean);
  const answer = await ctx.confirm({
    title: `${pr.label} "${pr.title}" was merged into ${pr.target}. Finish ${entry.branch}?`,
    detail: `${steps.join(', ').replace(/^./, (c) => c.toUpperCase())}, as /cleanup would: it stays if it has commits that are only here.`,
    options: [
      { label: 'Yes, finish it', value: 'yes' },
      { label: 'Not now (/ship or /cleanup asks again)', value: null },
      { label: 'No, and stop asking', value: 'forget' },
    ],
  });
  if (answer === 'forget') return forgetShipped(ctx, entry.branch);
  if (!answer) return;
  if (away) {
    if (!(await ctx.openRepo(main.path))) return;
  } else if (switching) {
    const r = await checkout(ctx, def);
    if (!r?.ok) return r;
  }
  const host = ctx.host();
  const { status } = ctx.data;
  const pulled = status.branch.head === def && status.branch.upstream
    ? await ctx.exec(['pull', '--prune'], { label: 'Pulling' })
    : await ctx.exec(['fetch', '--prune', host.remoteName], { label: 'Fetching' });
  if (!pulled.ok) return pulled;
  const { root, refs, remotes } = ctx.data;
  const mergedRefs = [def, `${host.remoteName}/${def}`].filter((r) => refs.local.some((b) => b.name === r) || refs.remote.some((b) => b.name === r));
  let plan;
  const read = await ctx.task(
    `Can ${entry.branch} go?`,
    async () => {
      const server = { remoteName: host.remoteName, merged: [{ ...pr, fork: false }], open: [] };
      plan = planCleanup(await readCleanup(root, { defaultBranch: def, mergedRefs, hasRemotes: remotes.length > 0, server }));
      return { stdout: '', stderr: '' };
    },
    { label: 'Checking the branch', refresh: false, quiet: true },
  );
  if (!read.ok) return read;
  forgetShipped(ctx, entry.branch);
  const branches = plan.branches.filter((b) => b.name === entry.branch);
  if (!branches.length) {
    const kept = plan.kept.find((k) => k.name === entry.branch);
    return ctx.note(`${entry.branch} stays: ${kept?.at ? `checked out in ${kept.at}, which has changes` : (kept?.why ?? "it can't go")}. d in Branches deletes it anyway.`, 'error');
  }
  return removeCleanup(ctx, { worktrees: plan.worktrees.filter((w) => w.branch === entry.branch), branches, remote: [] });
}

/**
 * The PR list's poll (prList.js), with `open` the pull requests it found: a shipped branch's pull request
 * that's no longer among them was merged or closed. Merged, Splice offers to finish it, or says so when
 * a question or something else has the screen; closed, it stops watching. Each is looked at once a session.
 */
export async function watchShipped(ctx, open) {
  const host = ctx.host();
  if (!host?.pr || !ctx.data) return;
  const repo = repoKey(ctx);
  ctx.shipLooked ??= new Set();
  for (const e of shippedIn(ctx.config, repo)) {
    const key = `${repo}\n${e.branch}\n${e.id}`;
    if (open.some((p) => p.id === e.id) || ctx.shipLooked.has(key)) continue;
    ctx.shipLooked.add(key);
    const pr = await host.pr(e.id).catch(() => null);
    // Not answered, or still open (past the list's first 100, say): the next poll looks again.
    if (!pr || pr.state === 'open') {
      ctx.shipLooked.delete(key);
      continue;
    }
    if (pr.state !== 'merged') {
      forgetShipped(ctx, e.branch);
      ctx.note(`${e.label} was closed without being merged, so ${e.branch} isn't shipped any more.`);
    } else if (ctx.isBusy() || !ctx.viewHasKeys()) {
      ctx.note(`${e.label} "${e.title}" was merged. /ship on ${e.branch} finishes it: switch to ${e.target}, pull, delete the branch.`, 'ok');
    } else await finishShipped(ctx, e, pr);
  }
}

/**
 * /review-pr <number>, w in PRs: checks the pull request out in a worktree of its own beside the repository
 * (<repo>-pr-<n>, on a branch pr-<n>, fetched from the host's ref for the PR's head, so ones from forks work
 * too) and opens that in Splice, so reviewing leaves your own work as it is. Again for the same pull request,
 * it brings the worktree up to the PR's latest commit (asking first if the PR was rewritten) and opens it.
 */
export async function reviewPr(ctx, text, given = null) {
  const host = needHost(ctx);
  if (!host) return;
  const id = given?.id ?? prNumber(text);
  if (id == null) return (text ?? '').trim() ? ctx.note(`${text.trim()} isn't a pull request number. /review-pr 12, say.`, 'error') : ctx.prefill('/review-pr ');
  let pr = given;
  if (!pr) {
    if (!host.pr) return ctx.note(`Splice can't look up a pull request by its number on ${host.name}.`, 'error');
    const got = await hostRead(ctx, `Pull request ${id} on ${host.name}`, (signal) => host.pr(id, signal), 'Asking about the pull request');
    if (!got.ok) return got;
    pr = got.value;
    if (pr.state !== 'open') return ctx.note(`${pr.label} is ${pr.state === 'merged' ? 'merged' : 'closed'} already, so there's nothing left to review.`, 'error');
  }
  const main = ctx.data.worktrees.find((w) => w.main)?.path ?? ctx.data.root;
  const path = reviewPath(main, pr.id);
  const name = reviewBranch(pr.id);
  // Fetched into a ref of Splice's own first: git won't fetch into a branch a worktree has out.
  const temp = `refs/splice/review/${pr.id}`;
  const fetched = await ctx.exec(['fetch', host.remoteName, `+${host.headRef(pr)}:${temp}`], { label: `Fetching ${pr.label}`, refresh: false });
  if (!fetched.ok) return fetched;
  try {
    const head = (await ctx.git(['rev-parse', '--verify', `${temp}^{commit}`])).trim();
    let at = ctx.data.worktrees.find((w) => samePath(w.path, path));
    if (at?.prunable) {
      if (!(await ctx.exec(['worktree', 'prune'], { label: 'Pruning worktrees', refresh: false })).ok) return;
      at = null;
    }
    if (!at) {
      if (existsSync(path)) return ctx.note(`${path} is there already, and isn't a worktree of this repository. Move it away first.`, 'error');
      // A pr-<n> left from before (its worktree removed) moves to the PR's head, unless it has commits the PR doesn't.
      const had = ctx.data.refs.local.find((b) => b.name === name);
      if (had && had.oid !== head && !(await isAncestor(ctx, had.oid, head))) {
        const ok = await ctx.confirm({
          title: `${name} has commits that aren't in ${pr.label}. Move it to the pull request anyway?`,
          detail: 'Those commits would then only be in the reflog.',
          options: YES_NO(`Yes, move ${name}`),
          danger: true,
        });
        if (!ok) return;
      }
      const r = await ctx.exec(['worktree', 'add', '-B', name, path, head], { label: 'Adding worktree', refresh: false });
      if (!r.ok) return r;
    } else if (at.branch !== name) {
      ctx.note(`The worktree at ${path} has ${at.branch ?? 'a detached HEAD'} out, not ${name}, so it was left as it is.`, 'error');
    } else if (at.head !== head) {
      const ff = await ctx.exec(['-C', path, 'merge', '--ff-only', head], { label: `Updating ${name}`, refresh: false, quietError: true });
      if (!ff.ok) {
        if (!/fast-forward/i.test(ff.error?.message ?? '')) return ctx.note(ff.error.message, 'error');
        const ok = await ctx.confirm({
          title: `${pr.label} was rewritten since ${name} was checked out. Reset ${name} to it?`,
          detail: 'With git reset --keep, which stops rather than lose uncommitted changes; commits only on the old one stay in the reflog.',
          options: YES_NO(`Yes, reset ${name}`),
          danger: true,
        });
        if (!ok) return;
        const r = await ctx.exec(['-C', path, 'reset', '--keep', head], { label: `Resetting ${name}`, refresh: false });
        if (!r.ok) return r;
      }
    }
  } finally {
    await ctx.git(['update-ref', '-d', temp]).catch(() => {});
  }
  if (!(await ctx.openRepo(path))) return;
  ctx.note(`Reviewing ${pr.label} "${pr.title}" in ${path}, on ${name}.\n/open ${main} goes back to your own work. /cleanup removes this worktree, and ${name} once ${pr.label} is merged.`, 'ok');
}

// A /backport waiting for /continue after a conflict: { id, label, title, url, branch, name, remote }.
const backportFile = (ctx) => join(ctx.data.gitDir, 'splice-backport.json');
async function readBackport(ctx) {
  try {
    return JSON.parse(await readFile(backportFile(ctx), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * /backport <pr-number> <branch>: copies a merged pull request onto a release branch. Works out its commits
 * from how it was merged (the merge commit with -m 1, the squashed commit, or the commits it was rebased
 * as), makes backport/<n>-to-<branch> from <remote>/<branch>, cherry-picks them (-x), pushes the branch and
 * opens a pull request into <branch>, titled "[<branch>] <title>" with a link to the original. Lists all
 * that and asks first. A conflict stops it with the usual banner; /continue then carries on (finishBackport).
 */
export async function backport(ctx, text) {
  const host = needHost(ctx);
  if (!host) return;
  const args = backportArgs(text);
  if (args.error) return ctx.note(args.error, 'error');
  if (args.id == null) return ctx.prefill('/backport ');
  if (!host.pr) return ctx.note(`Splice can't look up a pull request by its number on ${host.name}.`, 'error');
  const { id, branch } = args;
  if (ctx.data.state) return ctx.note(`A ${OP[ctx.data.state]} is in progress. Finish it first (/continue or /abort).`, 'error');
  const { staged, unstaged, conflicts } = ctx.data.changes;
  if (staged.length || conflicts.length || unstaged.some((f) => f.code !== '?')) return ctx.note('Commit or stash your changes first: a backport is made on a branch of its own.', 'error');
  const got = await hostRead(ctx, `Pull request ${id} on ${host.name}`, (signal) => host.pr(id, signal), 'Asking about the pull request');
  if (!got.ok) return got;
  const pr = got.value;
  if (pr.state !== 'merged') return ctx.note(`${pr.label} isn't merged${pr.state === 'closed' ? ': it was closed' : ' yet'}, so there's nothing to backport.`, 'error');
  if (!pr.mergeCommit) return ctx.note(`${host.name} didn't say which commit merged ${pr.label}.`, 'error');
  if (branch === pr.target) return ctx.note(`${pr.label} was merged into ${branch} itself.`, 'error');
  const remote = host.remoteName;
  const name = backportBranch(pr.id, branch);
  if (ctx.data.refs.local.some((b) => b.name === name)) return ctx.note(`${name} is there already: /checkout ${name} to carry on with it, or /delete ${name} to start again.`, 'error');
  const spec = (b) => `+refs/heads/${b}:refs/remotes/${remote}/${b}`;
  const fetched = await ctx.exec(['fetch', remote, spec(branch), spec(pr.target)], { label: 'Fetching', refresh: false });
  if (!fetched.ok) return fetched;
  let how;
  let picks;
  try {
    const parents = (await ctx.git(['rev-list', '--parents', '-n', '1', pr.mergeCommit])).trim().split(' ').slice(1);
    const n = pr.commits.length;
    const landed = parents.length === 1 && n > 1 ? parseCommitLines(await ctx.git(['log', '--first-parent', `-n${n}`, '--format=%H%x1f%s', pr.mergeCommit])).reverse() : [];
    const plan = backportPicks({ mergeCommit: pr.mergeCommit, parents, commits: pr.commits, landed });
    how = plan;
    picks = parseCommitLines(await ctx.git(['log', '--no-walk=unsorted', '--format=%H%x1f%s', ...plan.picks]));
  } catch (e) {
    return ctx.note(`${short(pr.mergeCommit)}, the commit that merged ${pr.label}, isn't here even after fetching ${pr.target}: ${firstLine(e.message)}`, 'error');
  }
  ctx.showText(`Backport ${pr.label} to ${branch}`, backportSteps({ pr, branch, name, remote, how: how.how, picks, hostName: host.name }).join('\n'), { markdown: true });
  const ok = await ctx.confirm({ title: `Backport ${pr.label} to ${branch}?`, detail: 'Listed above: each step in turn, stopping if one fails.', options: YES_NO('Yes, backport it') });
  ctx.closeOverlay();
  if (!ok) return;
  const job = { id: pr.id, label: pr.label, title: pr.title, url: pr.url, branch, name, remote };
  const made = await ctx.exec(['switch', '--no-track', '-c', name, `${remote}/${branch}`], { label: 'Creating branch' });
  if (!made.ok) return made;
  await writeFile(backportFile(ctx), JSON.stringify(job));
  const picked = await ctx.exec(['cherry-pick', '-x', ...(how.mainline ? ['-m', '1'] : []), ...how.picks], { label: 'Cherry-picking' });
  if (!picked.ok) {
    if (ctx.data.state === 'cherry-picking') {
      ctx.note(`The backport of ${pr.label} stopped while cherry-picking.\nFix it in Changes (2), then /continue picks the rest, pushes ${name} and opens the pull request (/abort stops).`, 'error');
    } else await rm(backportFile(ctx), { force: true });
    return picked;
  }
  return finishBackport(ctx, job);
}

// The rest of a backport, once its commits are picked: push the branch, open the pull request.
async function finishBackport(ctx, job) {
  await rm(backportFile(ctx), { force: true });
  const host = needHost(ctx);
  if (!host) return;
  const pushed = await ctx.exec(['push', '-u', job.remote, job.name], { label: 'Pushing' });
  if (!pushed.ok) {
    ctx.note(`The commits are picked on ${job.name}. Push it (P), then open the pull request: /pr ${backportTitle(job.branch, job.title)} --into ${job.branch}`, 'error');
    return pushed;
  }
  const title = backportTitle(job.branch, job.title);
  const r = await hostTask(ctx, `${cliName(host)} create "${title}"`, (signal) => host.create({ title, body: backportBody(job, job.branch), source: job.name, target: job.branch }, signal), {
    label: 'Opening pull request',
    refresh: false,
  });
  if (r.ok) {
    ctx.prsChanged();
    ctx.note(`Backported ${job.label} to ${job.branch}.`, 'ok');
  }
  return r;
}

/**
 * /changelog [since-tag] [--into-release <tag>]: Claude writes release notes, grouped into features, fixes
 * and the rest, from the commits since a tag (by default the latest one HEAD has) and the pull requests
 * merged since, where the host can list those by when they were merged. They open in the viewer, where y
 * copies them. With --into-release, they're the notes of the release /release then makes for that tag
 * (the commits up to it, from the tag before it).
 */
export async function changelog(ctx, text) {
  if (!needClaude(ctx)) return;
  const args = changelogArgs(text);
  if (args.error) return ctx.note(args.error, 'error');
  const { release } = args;
  const host = ctx.host();
  if (release) {
    if (!needHost(ctx)) return;
    if (!host.createRelease) return ctx.note(`${host.name} has no releases made from tags, so there's no release to put the notes in. /changelog alone writes them.`, 'error');
    if (!ctx.data.refs.tags.some((t) => t.name === release)) return ctx.note(`No tag called ${release}. t on a commit in the graph makes one.`, 'error');
  }
  const until = release ?? 'HEAD';
  let since = args.since;
  if (since && !(await ctx.git(['rev-parse', '--verify', '--quiet', `${since}^{commit}`]).then(() => true, () => false))) return ctx.note(`No tag or commit called ${since}.`, 'error');
  since ??= (await ctx.git(['describe', '--tags', '--abbrev=0', release ? `${release}^` : 'HEAD']).catch(() => '')).trim() || null;
  const log = await ctx.git(['log', '--no-merges', '-n', '500', '--format=%h%x1f%s%x1f%b%x1e', since ? `${since}..${until}` : until, '--']).catch(() => '');
  if (!changelogCount(log)) return ctx.note(`There are no commits ${since ? `since ${since}` : 'yet'}${release ? ` up to ${release}` : ''}, so there's nothing to write notes about.`, 'error');
  const upTo = release ?? ctx.data.status.branch.head ?? 'HEAD';
  // The pull requests merged into what's released: the default branch for a tag, else the branch you're on.
  const into = release ? defaultBranch(ctx.data.refs, ctx.data.remotes)?.name : ctx.data.status.branch.head;
  const r = await askClaude(ctx, `release notes ${since ? `since ${since}` : 'from the start'}`, changelogPrompt(since, upTo), async (signal) => {
    let prs = null;
    if (host?.mergedSince && since) {
      const from = (await ctx.git(['log', '-1', '--format=%cI', since, '--'])).trim();
      prs = await host.mergedSince(from, signal).catch((e) => {
        if (e.cancelled) throw e;
        return null;
      });
      if (prs && into) prs = prs.filter((p) => p.target === into);
    }
    return changelogInput({ since, until: upTo, log, prs });
  });
  if (!r.ok) return r;
  const notes = r.out.trim();
  ctx.showText(`Release notes${release ? ` for ${release}` : ''}${since ? `, since ${since}` : ''}`, notes, { markdown: true, copy: { text: notes, what: 'the release notes' } });
  if (!release) return r;
  const file = join(ctx.data.gitDir, 'splice-release-notes.md');
  try {
    await writeFile(file, `${notes}\n`);
  } catch (e) {
    return ctx.note(`Couldn't write ${file}: ${firstLine(e.message)}`, 'error');
  }
  return createRelease(ctx, `${release} --notes-file "${file}"`);
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
const REWRITE_NAMES = { rebase: 'rebase', pull: 'rebase', amend: 'amend' };

/**
 * /range-diff [branch]: what the branch's last rewrite (a rebase, an amend, a reset) did to each of its
 * commits: git range-diff between the branch before it (found in the branch's reflog) and now. A rebase's
 * reflog entry says what it went onto, so commits it rebased over don't show as new. /range-diff <a> <b>
 * compares any two versions (a...b); a range, or <base> <a> <b>, goes to git as it is.
 */
export async function rangeDiff(ctx, text) {
  if (!needRepo(ctx)) return;
  const args = splitArgs(text ?? '');
  if (args.length > 3) return ctx.note('Use /range-diff [branch], /range-diff <a> <b>, or /range-diff <base> <a> <b>.', 'error');
  if (args.length > 1 || args[0]?.includes('..')) {
    const spec = args.length === 2 ? [`${args[0]}...${args[1]}`] : args;
    return showRangeDiff(ctx, `git range-diff ${spec.join(' ')}`, spec);
  }
  const name = args[0] ?? ctx.data.status.branch.head;
  if (!name) return ctx.note('HEAD is detached, so there is no branch to look back on. Name one (/range-diff <branch>), or two versions: /range-diff <a> <b>.', 'error');
  if (!ctx.data.refs.local.some((b) => b.name === name)) return ctx.note(`${name} isn't a local branch. To compare two versions: /range-diff <a> <b>.`, 'error');
  const log = await readReflog(ctx, `refs/heads/${name}`, 300);
  const rewrite = lastRewrite(log);
  const before = rewrite && log[rewrite.index + 1];
  if (!before) return ctx.note(`${name}'s reflog has no rebase, amend or reset to look back across. /range-diff <a> <b> compares two versions.`, 'error');
  let spec = [`${before.hash}...${name}`];
  if (rewrite.onto) {
    const base = (await ctx.git(['merge-base', before.hash, rewrite.onto]).catch(() => '')).trim();
    if (base) spec = [`${base}..${before.hash}`, `${rewrite.onto}..${name}`];
  }
  const what = REWRITE_NAMES[rewrite.entry.kind] ?? 'reset';
  return showRangeDiff(ctx, `${name} before its last ${what} (${name}@{${rewrite.index + 1}}) and now`, spec);
}

function showRangeDiff(ctx, title, spec) {
  ctx.showAsync(title, async () => (await ctx.git(['range-diff', ...spec])) || 'Nothing to compare: neither side has commits of its own.', { rangeDiff: true });
}

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

/**
 * w on a diff: side by side, or back in one column, for every diff from then on (the sideBySide
 * setting). Only where it fits: `width` is the window's, `need` what side by side takes there.
 */
export function toggleSideBySide(ctx, { width, need }) {
  if (width < need) return ctx.note(`Side by side needs a window at least ${need} columns wide; this one is ${width}.`, 'error');
  ctx.setConfig((c) => ({ ...c, sideBySide: c.sideBySide !== true }));
}

/** Redraws the settings list (or its folders) after a change, if it's on screen. */
export function redrawSettings(ctx) {
  const o = ctx.overlay();
  if (o?.redraw) o.redraw(o.index);
}

async function changeSetting(ctx, row) {
  if (row.action === 'toggle') {
    // Most are on until turned off; `off` ones are off until turned on.
    ctx.setConfig((c) => ({ ...c, [row.id]: row.off ? c[row.id] !== true : c[row.id] === false }));
    return redrawSettings(ctx);
  }
  if (row.action === 'accent') return ctx.prefill(`/accent ${ctx.config.accent ?? DEFAULT_ACCENT}`);
  if (row.action === 'theme') {
    ctx.setConfig((c) => ({ ...c, theme: nextTheme(c) }));
    applyTheme(ctx.config);
    // The graph's lanes take their colours as it's laid out.
    ctx.reload();
    return redrawSettings(ctx);
  }
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
