// Pull requests on the server a repository's remote points at: GitHub (through the gh CLI)
// or Azure DevOps (through the az CLI and its azure-devops extension). Both CLIs use the
// sign-in you already have, so Tiller never sees or stores a token.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { git } from './git.js';

/** Recognises GitHub and Azure DevOps remote URLs (https and ssh). */
export function parseRemote(url) {
  if (!url) return null;
  const dec = (s) => decodeURIComponent(s);
  let m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (m) return { kind: 'github', owner: m[1], repo: m[2] };
  m = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/);
  if (m) return { kind: 'azure', org: dec(m[1]), orgUrl: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  m = url.match(/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/);
  if (m) return { kind: 'azure', org: dec(m[1]), orgUrl: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  m = url.match(/([^/@.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i);
  if (m) return { kind: 'azure', org: m[1], orgUrl: `https://${m[1]}.visualstudio.com`, project: dec(m[2]), repo: dec(m[3]) };
  m = url.match(/vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/);
  if (m) return { kind: 'azure', org: dec(m[1]), orgUrl: `https://${m[1]}.visualstudio.com`, project: dec(m[2]), repo: dec(m[3]) };
  return null;
}

const same = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase();
const stripRef = (r) => (r ?? '').replace(/^refs\/heads\//, '');

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** Counts GitHub's statusCheckRollup (check runs and commit statuses) as passed, failed, pending. */
export function checkSummary(rollup = []) {
  const out = { passed: 0, failed: 0, pending: 0 };
  for (const c of rollup ?? []) {
    const state = (c.conclusion || c.state || c.status || '').toUpperCase();
    if (FAILED.has(state)) out.failed++;
    else if (PASSED.has(state)) out.passed++;
    else out.pending++;
  }
  return out;
}

const GH_REVIEW = {
  APPROVED: { text: 'Approved', tone: 'good' },
  CHANGES_REQUESTED: { text: 'Changes requested', tone: 'bad' },
  REVIEW_REQUIRED: { text: 'Review required', tone: 'wait' },
};

/** One GitHub PR from `gh pr list --json`, in Tiller's shape. */
export function githubPr(p, me) {
  return {
    id: p.number,
    label: `#${p.number}`,
    title: p.title,
    author: p.author?.login ?? '',
    mine: same(p.author?.login, me),
    reviewMe: !same(p.author?.login, me) && (p.reviewRequests ?? []).some((r) => same(r.login, me)),
    source: p.headRefName,
    target: p.baseRefName,
    draft: Boolean(p.isDraft),
    url: p.url,
    time: Date.parse(p.updatedAt) / 1000,
    review: GH_REVIEW[p.reviewDecision] ?? { text: 'No reviews', tone: 'none' },
    checks: checkSummary(p.statusCheckRollup),
    reviewers: [],
    description: p.body ?? '',
  };
}

// Azure DevOps votes: 10 approved, 5 approved with suggestions, 0 none, -5 waiting for author, -10 rejected.
const VOTES = { 10: 'approved', 5: 'suggestions', 0: 'none', [-5]: 'waiting', [-10]: 'rejected' };

/** Overall review state from Azure DevOps reviewers. */
export function azureReview(reviewers) {
  if (reviewers.some((r) => r.vote === 'rejected')) return { text: 'Rejected', tone: 'bad' };
  if (reviewers.some((r) => r.vote === 'waiting')) return { text: 'Waiting for author', tone: 'bad' };
  const approved = reviewers.filter((r) => r.vote === 'approved' || r.vote === 'suggestions');
  const required = reviewers.filter((r) => r.required && !r.group);
  if (approved.length && required.every((r) => r.vote === 'approved' || r.vote === 'suggestions')) return { text: 'Approved', tone: 'good' };
  if (approved.length) return { text: `${approved.length} approved`, tone: 'wait' };
  return { text: 'No votes yet', tone: 'none' };
}

/** One Azure DevOps PR from `az repos pr list`, in Tiller's shape. */
export function azurePr(p, me, remote) {
  const reviewers = (p.reviewers ?? []).map((r) => ({
    name: r.displayName,
    vote: VOTES[r.vote] ?? 'none',
    required: Boolean(r.isRequired),
    group: Boolean(r.isContainer),
    me: same(r.uniqueName, me),
  }));
  const id = p.pullRequestId;
  return {
    id,
    label: `!${id}`,
    title: p.title,
    author: p.createdBy?.displayName ?? '',
    mine: same(p.createdBy?.uniqueName, me),
    // Authors are often added as a reviewer of their own PR; that isn't a request for review.
    reviewMe: !same(p.createdBy?.uniqueName, me) && reviewers.some((r) => r.me && r.vote === 'none'),
    source: stripRef(p.sourceRefName),
    target: stripRef(p.targetRefName),
    draft: Boolean(p.isDraft),
    url: `${remote.orgUrl}/${encodeURIComponent(remote.project)}/_git/${encodeURIComponent(remote.repo)}/pullrequest/${id}`,
    time: Date.parse(p.creationDate) / 1000,
    review: azureReview(reviewers),
    checks: null,
    conflicts: p.mergeStatus === 'conflicts',
    reviewers,
    description: p.description ?? '',
  };
}

/** Your review requests first, then your own PRs, then the rest; newest first within each. */
export function sortPrs(prs) {
  const rank = (p) => (p.reviewMe ? 0 : p.mine ? 1 : 2);
  return [...prs].sort((a, b) => rank(a) - rank(b) || b.time - a.time);
}

/**
 * The open PR of each branch, for the Branches view, keyed `local:<name>` and `remote:<name>`.
 * A PR's source is a branch name on the host's remote (`remoteName`): it matches that remote's
 * branch (origin/feature), and a local branch that tracks it, or has the same name and no upstream
 * elsewhere. Where a branch has several PRs (into different targets), the first in `prs` wins.
 */
export function prsByBranch(prs, refs, remoteName) {
  const bySource = new Map();
  for (const p of prs ?? []) if (p.source && !bySource.has(p.source)) bySource.set(p.source, p);
  const out = new Map();
  if (!bySource.size) return out;
  const prefix = `${remoteName}/`;
  for (const b of refs.remote) {
    if (b.name.startsWith(prefix) && bySource.has(b.name.slice(prefix.length))) out.set(`remote:${b.name}`, bySource.get(b.name.slice(prefix.length)));
  }
  for (const b of refs.local) {
    const source = !b.upstream ? b.name : b.upstream.startsWith(prefix) ? b.upstream.slice(prefix.length) : null;
    if (source && bySource.has(source)) out.set(`local:${b.name}`, bySource.get(source));
  }
  return out;
}

// Runs a CLI and resolves with stdout. On Windows az is a .cmd wrapper that Node won't start
// without a shell, so call the Python it wraps directly: no shell, so no quoting surprises.
export function cli(program, args, { cwd, signal, input } = {}) {
  let file = program;
  let argv = args;
  let env = process.env;
  if (program === 'az' && process.platform === 'win32') {
    const dir = (process.env.PATH ?? '').split(delimiter).find((d) => d && existsSync(join(d, 'az.cmd')));
    const python = dir && join(dir, '..', 'python.exe');
    if (!python || !existsSync(python)) return Promise.reject(new Error('The Azure CLI (az) is not installed. Get it from https://aka.ms/installazurecliwindows'));
    file = python;
    // -X utf8: otherwise Python writes the console code page and accented names arrive garbled.
    // (An environment variable wouldn't do: -I, which az's own wrapper passes, ignores them.)
    argv = ['-X', 'utf8', '-IBm', 'azure.cli', ...args];
    env = { ...process.env, AZ_INSTALLER: 'MSI' };
  }
  return new Promise((resolve, reject) => {
    const child = execFile(file, argv, { cwd, env, signal, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      // Esc: shown as "Cancelled", like a cancelled git command.
      if (err.name === 'AbortError') return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (err.code === 'ENOENT') return reject(new Error(`${program} is not installed or not on the PATH.`));
      // CLI warnings come before the error itself; the last lines say what went wrong.
      const lines = (stderr || err.message).trim().split('\n').filter((l) => !/^WARNING:/.test(l));
      reject(new Error(lines.slice(-3).join('\n') || `${program} failed`));
    });
    // Written to stdin, for what's too big for an argument (a diff for Claude).
    if (input != null) child.stdin.end(input);
  });
}

const json = async (p) => JSON.parse(await p);

function github(root, remote) {
  const gh = (args, opts) => cli('gh', args, { cwd: root, ...opts });
  const repoArg = ['-R', `${remote.owner}/${remote.repo}`];
  let me;
  const whoami = async () => (me ??= (await gh(['api', 'user', '--jq', '.login'])).trim());
  return {
    kind: 'github',
    name: 'GitHub',
    signIn: 'gh auth login',
    async list() {
      const [login, list] = await Promise.all([
        whoami(),
        json(gh(['pr', 'list', ...repoArg, '--state', 'open', '--limit', '100', '--json',
          'number,title,author,headRefName,baseRefName,isDraft,reviewDecision,url,updatedAt,reviewRequests,statusCheckRollup,body'])),
      ]);
      return sortPrs(list.map((p) => githubPr(p, login)));
    },
    async detail(pr) {
      const d = await json(gh(['pr', 'view', String(pr.id), ...repoArg, '--json', 'comments,latestReviews,reviewRequests,statusCheckRollup,mergeable']));
      const voted = (d.latestReviews ?? []).map((r) => ({
        name: r.author?.login,
        vote: { APPROVED: 'approved', CHANGES_REQUESTED: 'rejected' }[r.state] ?? 'commented',
      }));
      const waiting = (d.reviewRequests ?? [])
        .map((r) => ({ name: r.login ?? r.name ?? r.slug, vote: 'none' }))
        .filter((r) => !voted.some((v) => v.name === r.name));
      return {
        reviewers: [...voted, ...waiting],
        checks: (d.statusCheckRollup ?? []).map((c) => ({ name: c.name || c.context, state: checkSummary([c]).failed ? 'fail' : checkSummary([c]).passed ? 'pass' : 'pending' })),
        comments: (d.comments ?? []).map((c) => ({ author: c.author?.login, text: c.body, time: Date.parse(c.createdAt) / 1000 })),
        conflicts: d.mergeable === 'CONFLICTING',
      };
    },
    diff: (pr) => gh(['pr', 'diff', String(pr.id), ...repoArg]),
    checkout: (pr, signal) => gh(['pr', 'checkout', String(pr.id), ...repoArg], { signal }),
    approve: (pr, signal) => gh(['pr', 'review', String(pr.id), ...repoArg, '--approve'], { signal }),
    comment: (pr, text, signal) => gh(['pr', 'comment', String(pr.id), ...repoArg, '--body', text], { signal }),
    async create({ title, body = '', source, target, draft }, signal) {
      const url = await gh(['pr', 'create', ...repoArg, '--title', title, '--body', body, '--base', target, '--head', source, ...(draft ? ['--draft'] : [])], { signal });
      return url.trim().split('\n').at(-1);
    },
    async defaultBranch() {
      return (await json(gh(['repo', 'view', `${remote.owner}/${remote.repo}`, '--json', 'defaultBranchRef']))).defaultBranchRef?.name;
    },
  };
}

function azure(root, remote, remoteName) {
  const org = ['--org', remote.orgUrl];
  const az = (args, opts) => cli('az', [...args, ...org, '--only-show-errors', '-o', 'json'], { cwd: root, ...opts });
  const threadsRoute = (pr) => ['devops', 'invoke', '--area', 'git', '--resource', 'pullRequestThreads', '--api-version', '7.0',
    '--route-parameters', `project=${remote.project}`, `repositoryId=${remote.repo}`, `pullRequestId=${pr.id}`];
  let me;
  const whoami = async () => (me ??= JSON.parse(await cli('az', ['account', 'show', '--query', 'user.name', '-o', 'json'])));
  return {
    kind: 'azure',
    name: 'Azure DevOps',
    signIn: 'az login',
    async list() {
      const [user, list] = await Promise.all([
        whoami().catch(() => ''),
        json(az(['repos', 'pr', 'list', '--project', remote.project, '--repository', remote.repo, '--status', 'active', '--top', '100'])),
      ]);
      return sortPrs(list.map((p) => azurePr(p, user, remote)));
    },
    async detail(pr) {
      const [threads, policies] = await Promise.all([
        json(az(threadsRoute(pr))).catch(() => ({ value: [] })),
        json(az(['repos', 'pr', 'policy', 'list', '--id', String(pr.id)])).catch(() => []),
      ]);
      const comments = [];
      for (const t of threads.value ?? []) {
        for (const c of t.comments ?? []) {
          // Skip the system's own notes ("X voted", "pushed 2 commits").
          if (c.commentType === 'system' || c.isDeleted || !c.content) continue;
          comments.push({ author: c.author?.displayName, text: c.content, time: Date.parse(c.publishedDate) / 1000 });
        }
      }
      comments.sort((a, b) => a.time - b.time);
      const STATE = { approved: 'pass', rejected: 'fail', running: 'pending', queued: 'pending', broken: 'fail' };
      const checks = policies
        .filter((p) => p.status !== 'notApplicable')
        .map((p) => ({ name: p.configuration?.settings?.displayName || p.configuration?.type?.displayName || 'Policy', state: STATE[p.status] ?? 'pending' }));
      return { reviewers: pr.reviewers, checks, comments, conflicts: pr.conflicts };
    },
    // Azure DevOps has no "pr diff" command, so diff the two branches locally (three dots: what the PR adds).
    async diff(pr) {
      const spec = (b) => `+refs/heads/${b}:refs/remotes/${remoteName}/${b}`;
      await git(root, ['fetch', '--quiet', remoteName, spec(pr.source), spec(pr.target)]);
      return git(root, ['diff', '-M', `${remoteName}/${pr.target}...${remoteName}/${pr.source}`]);
    },
    checkout: null, // done with plain git: fetch, then switch to a tracking branch
    approve: (pr, signal) => az(['repos', 'pr', 'set-vote', '--id', String(pr.id), '--vote', 'approve'], { signal }),
    async comment(pr, text, signal) {
      // Posting a thread needs a JSON body, which `az devops invoke` only takes from a file.
      const dir = await mkdtemp(join(tmpdir(), 'tiller-'));
      const file = join(dir, 'thread.json');
      try {
        await writeFile(file, JSON.stringify({ comments: [{ parentCommentId: 0, content: text, commentType: 1 }], status: 1 }));
        return await az([...threadsRoute(pr), '--http-method', 'POST', '--in-file', file], { signal });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async create({ title, body = '', source, target, draft }, signal) {
      // az takes the description as one value per line.
      const description = body ? ['--description', ...body.split('\n')] : [];
      const pr = await json(
        az(['repos', 'pr', 'create', '--project', remote.project, '--repository', remote.repo, '--source-branch', source,
          '--target-branch', target, '--title', title, ...description, ...(draft ? ['--draft', 'true'] : [])], { signal }),
      );
      return azurePr(pr, '', remote).url;
    },
    async defaultBranch() {
      return stripRef((await json(az(['repos', 'show', '--project', remote.project, '--repository', remote.repo]))).defaultBranch);
    },
  };
}

/** The PR host for a loaded repository: origin first, else the first remote Tiller recognises. */
export function hostFor(data) {
  if (!data?.remoteUrls) return null;
  const names = Object.keys(data.remoteUrls).sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0));
  for (const name of names) {
    const remote = parseRemote(data.remoteUrls[name]);
    if (remote?.kind === 'github') return { ...github(data.root, remote), remoteName: name, remote };
    if (remote?.kind === 'azure') return { ...azure(data.root, remote, name), remoteName: name, remote };
  }
  return null;
}

/** Opens a URL in the default browser. */
export function openUrl(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, { windowsHide: true }, () => {});
}
