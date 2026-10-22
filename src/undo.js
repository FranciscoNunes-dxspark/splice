// Undo (z): what the last change to HEAD or the current branch was, worked out from the reflog, and
// how to take it back. Discards never reach the reflog, so before Splice throws changes away it
// keeps them under .git/splice-undo/: patches of the tracked changes and a tree of untracked files.
// The parsing and planning are pure; the rest reads and writes those files.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git.js';
import { relTime } from './parse.js';

/** For `git log -g --date=unix`: with a date format, %gd carries the entry's time (HEAD@{1760000000}). */
export const REFLOG_FORMAT = '%H%x1f%gd%x1f%gs%x1f%s';

/** What kind of change a reflog action is: "commit (amend)" → amend, "merge feature" → merge, and so on. */
export function classify(action) {
  const commit = action.match(/^commit(?: \((.+)\))?$/);
  // A merge or cherry-pick that stopped on conflicts ends with "commit (merge)" and the like.
  if (commit) return { kind: commit[1] ?? 'commit', phase: null, ref: null };
  const word = (action.match(/^[\w-]+/)?.[0] ?? action).toLowerCase();
  const phase = action.match(/\(([\w-]+)\)$/)?.[1] ?? null;
  const ref = word === 'merge' ? action.slice(6).trim() || null : null;
  return { kind: word, phase, ref };
}

/** Parses `git log -g --date=unix --format=REFLOG_FORMAT <ref>`, newest first. */
export function parseReflog(raw) {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, selector = '', gs = '', subject = ''] = line.split('\x1f');
      const sep = gs.indexOf(': ');
      const action = sep < 0 ? gs : gs.slice(0, sep);
      return {
        hash,
        time: Number(selector.match(/@\{(\d+)\}$/)?.[1]) || 0,
        action,
        message: sep < 0 ? '' : gs.slice(sep + 2),
        subject,
        ...classify(action),
      };
    });
}

/** A short name for the reflog picker: "commit", "amend", "rebase pick", "checkout"... */
export function reflogLabel(e) {
  if (e.kind === 'initial') return 'commit';
  return e.phase && e.phase !== 'finish' ? `${e.kind} ${e.phase}` : e.kind;
}

const none = (why) => ({ kind: 'none', why });

/** The last change to HEAD (a switch) or the current branch (anything that moved it), from the reflogs. */
function lastChange({ head, branch, branchName, oid }) {
  const top = head[0];
  if (top?.kind === 'checkout') {
    const m = top.message.match(/^moving from (.+) to (.+)$/);
    if (m && m[1] !== m[2]) return { kind: 'switch', from: m[1], to: m[2], time: top.time, entry: top };
  }
  if (!oid) return none('there are no commits yet.');
  let entry;
  let prev;
  if (branchName && branch?.length) {
    // The branch's own reflog has a whole rebase or pull as one step, where HEAD's has every pick.
    [entry, prev] = branch;
  } else {
    if (!top) return none('the reflog is empty.');
    entry = top;
    let i = 1;
    // Detached: step back over the rebase's own entries to where HEAD was before it started.
    if (top.phase && top.phase !== 'start' && (top.kind === 'rebase' || top.kind === 'pull')) {
      const start = head.findIndex((e) => e.phase === 'start');
      if (start > 0) i = start + 1;
    }
    prev = head[i];
  }
  const who = branchName ?? 'HEAD';
  if (entry.hash !== oid) return none(`the reflog doesn't say how ${who} got where it is.`);
  if (!prev) {
    if (entry.kind === 'initial' && branchName) return { kind: 'unborn', branch: branchName, entry, time: entry.time };
    return none(`there is nothing before "${entry.action}" in ${who}'s reflog.`);
  }
  if (prev.hash === entry.hash) return none(`the last change to ${who} (${entry.action}) didn't move it.`);
  return {
    kind: 'reset',
    // A commit or an amend comes back as staged changes; anything else moves back without touching your work.
    mode: entry.kind === 'commit' || entry.kind === 'amend' ? 'soft' : 'keep',
    entry,
    target: prev.hash,
    targetSubject: prev.subject,
    branch: branchName,
    time: entry.time,
  };
}

/**
 * What `z` would do. `head` is HEAD's reflog (newest first, enough of it to reach back past a detached
 * rebase), `branch` the current branch's last two entries, `oid` where HEAD is now, and `discard` the
 * newest discard Splice kept. The newer of that discard and the last reflog change wins.
 */
export function planUndo({ head = [], branch = null, branchName = null, oid = null, discard = null }) {
  const change = lastChange({ head, branch, branchName, oid });
  if (discard && (change.kind === 'none' || discard.at / 1000 >= change.time)) return { kind: 'discard', discard, time: discard.at / 1000 };
  return change;
}

const shortRef = (s) => (/^[0-9a-f]{40}$/.test(s) ? s.slice(0, 7) : s);

/** The confirmation for a plan: { title, detail, yes }. `pushed` names the upstream already holding what goes. */
export function describeUndo(plan, { pushed = null, now = Date.now() / 1000 } = {}) {
  if (plan.kind === 'switch') {
    const from = shortRef(plan.from);
    return { title: `Switch back to ${from}?`, detail: `Undoes the switch from ${from} to ${shortRef(plan.to)}.`, yes: 'Yes, switch back' };
  }
  if (plan.kind === 'discard') {
    const age = relTime(plan.time, now);
    const d = plan.discard;
    return {
      title: `Bring back ${d.what}?`,
      detail: `Undoes the discard from ${age === 'now' ? 'just now' : `${age} ago`}.${d.untracked ? ' Untracked files come back too.' : ''}`,
      yes: 'Yes, bring it back',
    };
  }
  if (plan.kind === 'unborn') {
    return {
      title: `Undo the first commit "${plan.entry.subject}"?`,
      detail: `${plan.branch} goes back to having no commits. Its files stay, staged.`,
      yes: 'Yes, undo',
    };
  }
  const e = plan.entry;
  const who = plan.branch ?? 'HEAD';
  const to = `${plan.target.slice(0, 7)} "${plan.targetSubject}"`;
  const titles = {
    commit: `Undo the commit "${e.subject}"?`,
    amend: `Undo the amend of "${e.subject}"?`,
    merge: e.ref ? `Undo the merge of ${e.ref} into ${who}?` : `Undo the merge "${e.subject}"?`,
    rebase: `Undo the rebase of ${who}?`,
    pull: `Undo the pull into ${who}?`,
    reset: `Undo the reset of ${who} (${e.message})?`,
    'cherry-pick': `Undo the cherry-pick of "${e.subject}"?`,
    revert: `Undo the revert "${e.subject}"?`,
    sync: `Undo the sync of ${who} with its upstream?`,
    undo: 'Redo what was just undone?',
    redo: 'Undo that again?',
  };
  let detail =
    e.kind === 'commit'
      ? `Its changes go back to staged; ${who} goes back to ${to}.`
      : e.kind === 'amend'
        ? `${who} goes back to ${to}, as it was before; what the amend changed goes back to staged.`
        : `${who} goes back to ${to}. Your uncommitted changes stay (git stops rather than overwrite them).`;
  // A sync only fast-forwarded the branch to what its upstream already had: undoing it leaves the branch behind, nothing to push.
  if (e.kind === 'sync') detail = `${who} goes back to ${to}, behind its upstream again (/sync or p brings it forward). Your uncommitted changes stay.`;
  else if (pushed) detail = `It's already on ${pushed}: this only undoes it here, so pushing again would need /push --force. ${detail}`;
  return {
    title: titles[e.kind] ?? `Undo "${e.action}${e.message ? `: ${e.message}` : ''}"?`,
    detail,
    yes: e.kind === 'undo' ? 'Yes, redo' : 'Yes, undo',
  };
}

/** What a reset made by undo writes in the reflog, so the next z can say it's a redo (and the one after, an undo). */
export const reflogActionFor = (plan) => (plan.entry?.kind === 'undo' ? 'redo' : 'undo');

// The kept discards: .git/splice-undo/discards.json (newest last) and the patch files it names.
const KEEP = 10;
const dirOf = (gitDir) => join(gitDir, 'splice-undo');
const listFile = (gitDir) => join(dirOf(gitDir), 'discards.json');

export async function readDiscards(gitDir) {
  try {
    const list = JSON.parse(await readFile(listFile(gitDir), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeDiscards(gitDir, list) {
  await writeFile(listFile(gitDir), JSON.stringify(list, null, 1));
}

async function removeFiles(gitDir, d) {
  for (const f of [d.index, d.worktree]) if (f) await rm(join(dirOf(gitDir), f), { force: true });
}

const nonEmpty = async (file) => (await stat(file).catch(() => null))?.size > 0;

/**
 * Keeps a copy of what a discard is about to throw away, before it does. Returns the record to pass to
 * `saveDiscard` once the discard has happened (or `forgetCapture` if it didn't).
 * - `paths`: the tracked files (null for all of them); `staged`: their staged changes go too.
 * - `patch`: instead of `paths`, the exact patch whose reverse is about to be applied to the working tree.
 * - `untracked`: untracked files about to be deleted.
 */
export async function captureDiscard(root, gitDir, { what, paths = null, staged = false, patch = null, untracked = [] }) {
  const dir = dirOf(gitDir);
  await mkdir(dir, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const d = { id, at: Date.now(), what, index: null, worktree: null, untracked: null };
  const scope = paths ? ['--', ...paths] : [];
  try {
    if (patch != null) {
      await writeFile(join(dir, `${id}-worktree.patch`), patch);
      d.worktree = `${id}-worktree.patch`;
    } else {
      // --output writes git's bytes untouched, whatever the files' encoding.
      if (staged) {
        const file = join(dir, `${id}-index.patch`);
        await git(root, ['diff', '--cached', '--binary', `--output=${file}`, ...scope]);
        if (await nonEmpty(file)) d.index = `${id}-index.patch`;
      }
      const file = join(dir, `${id}-worktree.patch`);
      await git(root, ['diff', '--binary', `--output=${file}`, ...scope]);
      if (await nonEmpty(file)) d.worktree = `${id}-worktree.patch`;
    }
    const files = untracked.filter((p) => !p.endsWith('/'));
    if (files.length) {
      // Untracked files go into a tree of their own, through a throwaway index.
      const env = { GIT_INDEX_FILE: join(dir, `${id}.index`) };
      try {
        await git(root, ['update-index', '--add', '-z', '--stdin'], { env, input: `${files.join('\0')}\0` });
        d.untracked = (await git(root, ['write-tree'], { env })).trim();
      } finally {
        await rm(env.GIT_INDEX_FILE, { force: true });
      }
    }
  } catch (e) {
    await removeFiles(gitDir, d);
    throw e;
  }
  return d;
}

export const forgetCapture = (gitDir, d) => removeFiles(gitDir, d);

export async function saveDiscard(gitDir, d) {
  if (!d.index && !d.worktree && !d.untracked) return;
  // Timed when done, after anything the discard itself wrote in the reflog (git reset --hard does).
  const list = [...(await readDiscards(gitDir)), { ...d, at: Date.now() }];
  for (const old of list.splice(0, Math.max(0, list.length - KEEP))) await removeFiles(gitDir, old);
  await writeDiscards(gitDir, list);
}

export async function dropDiscard(gitDir, id) {
  const list = await readDiscards(gitDir);
  const d = list.find((x) => x.id === id);
  if (d) await removeFiles(gitDir, d);
  await writeDiscards(gitDir, list.filter((x) => x.id !== id));
}

/** The git commands that put a discard back, in order, with the env each needs. */
export function restoreSteps(gitDir, d) {
  const dir = dirOf(gitDir);
  const steps = [];
  if (d.index) steps.push({ args: ['apply', '--index', '--whitespace=nowarn', join(dir, d.index)] });
  if (d.worktree) steps.push({ args: ['apply', '--recount', '--whitespace=nowarn', join(dir, d.worktree)] });
  if (d.untracked) {
    const env = { GIT_INDEX_FILE: join(dir, `${d.id}.index`) };
    steps.push({ args: ['read-tree', d.untracked], env }, { args: ['checkout-index', '-a'], env, temp: env.GIT_INDEX_FILE });
  }
  return steps;
}

/** Untracked files the discard kept that exist again, which restoring would have to overwrite. */
export async function untrackedInTheWay(root, d) {
  if (!d.untracked) return [];
  const names = (await git(root, ['ls-tree', '-r', '-z', '--name-only', d.untracked])).split('\0').filter(Boolean);
  return names.filter((n) => existsSync(join(root, n)));
}

/**
 * Where a branch's reflog (parseReflog, newest first) last had its commits rewritten: a rebase or a
 * pull --rebase finishing, an amend, a reset (an undo's or redo's too). Returns { index, entry, onto }
 * (`onto`: the commit a rebase put the branch on, from the entry's message), or null. The branch as it
 * was before is the entry after it, <branch>@{index + 1}.
 */
export function lastRewrite(entries) {
  const index = entries.findIndex(
    (e) => ((e.kind === 'rebase' || e.kind === 'pull') && e.phase === 'finish') || ['amend', 'reset', 'undo', 'redo'].includes(e.kind),
  );
  if (index < 0) return null;
  const entry = entries[index];
  return { index, entry, onto: entry.message.match(/ onto ([0-9a-f]{40})$/)?.[1] ?? null };
}
