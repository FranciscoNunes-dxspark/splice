// The pull request flows: /ship, /review-pr, /backport and /changelog. Their arguments, plans and the state
// they keep, pure; actions.js runs them against git and the PR host.
import { basename, dirname, join } from 'node:path';
import { samePath } from './config.js';
import { MERGE_LABELS } from './hosting.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (hash) => String(hash ?? '').slice(0, 7);

/** A pull request's number as typed: 12, #12 or !12. Null for anything else. */
export function prNumber(text) {
  const m = /^\s*[#!]?(\d+)\s*$/.exec(text ?? '');
  return m ? Number(m[1]) : null;
}

/** "/ship [--into <branch>]": { target } (null when not given), or { error }. */
export function shipArgs(text) {
  const s = (text ?? '').trim();
  if (!s) return { target: null };
  const m = /^--(?:into|base)\s+(\S+)$/.exec(s);
  return m ? { target: m[1] } : { error: `Unknown option: ${s}. /ship takes --into <branch>.` };
}

// The branches you shipped live in the config as `shipped`: { repo, branch, id, label, title, url, target, at },
// `repo` the repository's common git dir, which its worktrees share.

/** The branches shipped from the repository whose common git dir is `repo`. */
export const shippedIn = (config, repo) => (config?.shipped ?? []).filter((e) => repo && samePath(e.repo, repo));

/** The entry for `branch` of `repo`, if it was shipped. */
export const shippedEntry = (config, repo, branch) => shippedIn(config, repo).find((e) => e.branch === branch) ?? null;

/** The config with `entry` recorded (replacing one for the same branch); the last 50 are kept. */
export function withShipped(config, entry) {
  const rest = (config.shipped ?? []).filter((e) => !(samePath(e.repo, entry.repo) && e.branch === entry.branch));
  return { ...config, shipped: [...rest, entry].slice(-50) };
}

/** The config without the entries of `repo` whose branch `drop(entry)` says. */
export function withoutShipped(config, repo, drop) {
  const shipped = (config.shipped ?? []).filter((e) => !(samePath(e.repo, repo) && drop(e)));
  return shipped.length === (config.shipped ?? []).length ? config : { ...config, shipped };
}

/**
 * What /ship will do, as a Markdown list for the viewer before it asks. `push`: null when the server has
 * every commit, else { first } (no upstream yet) or { count }. `open`: the branch's open PR, if there is
 * one. `claude`: whether Claude drafts the title and description (else they come from the commits).
 */
export function shipSteps({ branch, target, remote, hostName, push, open, claude, method }) {
  const b = code(branch);
  const steps = [];
  if (!push) steps.push(`Nothing to push: ${remote} has every commit of ${b}.`);
  else if (push.first) steps.push(`Push ${b} to ${remote}, setting its upstream (the first push).`);
  else steps.push(`Push ${plural(push.count, 'new commit')} of ${b} to ${remote}.`);
  if (open) steps.push(`Use ${open.label} "${open.title}", already open on ${hostName}.`);
  else steps.push(`Open a pull request from ${b} into ${code(target)} on ${hostName}, ${claude ? 'with the title and description Claude drafts' : "titled after the latest commit (Claude isn't available here)"}.`);
  steps.push(`Turn on auto-merge (${MERGE_LABELS[method] ?? method}): it merges once its required checks and reviews pass, and ${b} is deleted on ${hostName} then.`);
  return [
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `Once it's merged, Splice offers to finish: switch to ${code(target)}, pull it, and delete ${b} here (and its worktree), as /cleanup would. It notices in the PRs and Branches views, or when you run /ship or /cleanup again.`,
  ];
}

// A name in Markdown, as code, so _ and * in it stay as they are.
const code = (s) => `\`${s}\``;

/** A title and description from the commits, for when Claude can't draft them: the latest subject, then the list. */
export function commitsDraft(commits) {
  const list = commits.filter((c) => c.subject);
  if (!list.length) return { title: '', body: '' };
  return { title: list.at(-1).subject, body: list.length > 1 ? list.map((c) => `- ${c.subject}`).join('\n') : '' };
}

/** `git log --format=%H%x1f%s` output as [{ hash, subject }], in the order given. */
export function parseCommitLines(out) {
  return String(out ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, subject = ''] = l.split('\x1f');
      return { hash, subject };
    });
}

// /review-pr: each pull request gets a worktree next to the repository, as n in Worktrees names them, on a branch of its own.

/** Where /review-pr checks out pull request `id`: beside the main working tree, as <repo>-pr-<id>. */
export const reviewPath = (mainRoot, id) => join(dirname(mainRoot), `${basename(mainRoot)}-pr-${id}`);
/** Where /run-at puts a detached worktree at a commit: <repo>-at-<short hash>, beside the main working tree. */
export const runAtPath = (mainRoot, hash) => join(dirname(mainRoot), `${basename(mainRoot)}-at-${hash.slice(0, 7)}`);
/** The branch it's on there. /cleanup knows these by name (cleanup.js's reviewBranchId). */
export const reviewBranch = (id) => `pr-${id}`;

/** "/backport <pr> <branch>": { id, branch }, or { error }, or {} when nothing was typed. */
export function backportArgs(text) {
  const words = (text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return {};
  const id = prNumber(words[0]);
  if (id == null || words.length !== 2) return { error: 'Say which pull request goes to which branch: /backport <pr-number> <branch>' };
  return { id, branch: words[1].replace(/^refs\/heads\//, '') };
}

/** The branch a backport is made on. */
export const backportBranch = (id, branch) => `backport/${id}-to-${branch}`;

/**
 * Which commits copy a merged pull request, from its merge commit on the target (`mergeCommit`, with its
 * `parents`), the PR's own `commits` (oldest first) and `landed`: the same number of commits on the target's
 * first-parent line ending at the merge commit (oldest first). A merge commit is copied as what it brought
 * in (-m 1); a single commit is the squashed one; a run whose subjects are the PR's, in order, is a rebase
 * merge, copied commit by commit. Returns { how: 'merge' | 'squash' | 'rebase', picks, mainline }.
 */
export function backportPicks({ mergeCommit, parents = [], commits = [], landed = [] }) {
  if (parents.length > 1) return { how: 'merge', picks: [mergeCommit], mainline: true };
  const n = commits.length;
  if (n > 1 && landed.length === n && landed.at(-1)?.hash === mergeCommit && landed.every((c, i) => c.subject === commits[i].subject)) {
    return { how: 'rebase', picks: landed.map((c) => c.hash), mainline: false };
  }
  return { how: 'squash', picks: [mergeCommit], mainline: false };
}

const HOW = { merge: 'its merge commit, as what it brought in (-m 1)', squash: 'the commit it was squashed into', rebase: 'the commits it was rebased as, oldest first' };

/** What /backport will do, as a Markdown list for the viewer. `picks` are { hash, subject }. */
export function backportSteps({ pr, branch, name, remote, how, picks, hostName }) {
  return [
    `Backport ${pr.label} "${pr.title}" (merged into ${code(pr.target)}) to ${code(branch)}:`,
    '',
    `1. Make ${code(name)} from ${code(`${remote}/${branch}`)}, and switch to it.`,
    `2. Cherry-pick ${HOW[how]}, with -x (each message says where it came from):`,
    ...picks.map((c) => `   - ${code(short(c.hash))} ${c.subject}`),
    `3. Push ${code(name)} to ${remote}.`,
    `4. Open a pull request into ${code(branch)} on ${hostName}: "${backportTitle(branch, pr.title)}".`,
    '',
    'If a commit stops on a conflict, fix it in Changes, then /continue picks the rest, pushes and opens the pull request (/abort stops).',
  ];
}

export const backportTitle = (branch, title) => `[${branch}] ${title}`;

export function backportBody(pr, branch) {
  return `Backport of ${pr.label} (${pr.url}) to \`${branch}\`.\n\n${pr.title}`;
}

/** "/changelog [since-tag] [--into-release <tag>]": { since, release } (null when not given), or { error }. */
export function changelogArgs(text) {
  let release = null;
  const rest = (text ?? '')
    .replace(/(^|\s)--into-release(?:\s+(\S+))?/g, (_, space, tag) => {
      release = tag ?? '';
      return space;
    })
    .trim();
  if (release === '') return { error: 'Say which release: /changelog [since-tag] --into-release <tag>' };
  const words = rest.split(/\s+/).filter(Boolean);
  if (words.length > 1) return { error: `One tag to start from: /changelog [since-tag] [--into-release <tag>] (got ${words.join(' ')})` };
  return { since: words[0] ?? null, release };
}

/**
 * What Claude gets for release notes: the commits (`git log --format=%h%x1f%s%x1f%b%x1e` output, newest
 * first) and the merged pull requests (null when the host wasn't asked).
 */
export function changelogInput({ since, until, log, prs }) {
  const commits = String(log ?? '')
    .split('\x1e')
    .map((c) => c.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((c) => {
      const [hash, subject = '', body = ''] = c.split('\x1f');
      const b = body.trim();
      return `- ${hash} ${subject}${b ? `\n${b.replace(/^/gm, '    ')}` : ''}`;
    });
  const out = [`Commits from ${since ?? 'the start'} to ${until}, newest first (${commits.length}):`, ...commits];
  if (prs?.length) out.push('', `Pull requests merged since then (${prs.length}):`, ...prs.map((p) => `- ${p.label} ${p.title}${p.author ? ` (${p.author})` : ''}`));
  return out.join('\n');
}

/** How many commits `changelogInput`'s log holds. */
export const changelogCount = (log) => String(log ?? '').split('\x1e').filter((c) => c.trim()).length;
