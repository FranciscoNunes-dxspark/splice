// Pull requests on the server a repository's remote points at: GitHub (through the gh CLI),
// Azure DevOps (through the az CLI and its azure-devops extension) or GitLab (through the glab CLI,
// mostly its `glab api`). The CLIs use the sign-in you already have, so Splice never sees or stores a token.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { git } from './git.js';

/**
 * A remote URL's host and repository path, from https, ssh:// and scp-like (git@host:group/repo) URLs:
 * { host, path }, the host lowercased (with its port for http, without it for ssh), the path without
 * slashes around it or ".git". Null for what isn't a URL (a local path).
 */
export function remoteParts(url) {
  let host;
  let path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol === 'file:') return null;
    host = /^https?:$/.test(u.protocol) ? u.host : u.hostname;
    path = decodeURIComponent(u.pathname);
  } else {
    // A one-letter "host" is a Windows drive (C:\repo), not a server.
    const m = /^(?:[^@/\\]+@)?([^:/\\]{2,}):(.+)$/.exec(url);
    if (!m) return null;
    host = m[1];
    path = m[2];
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return host && path ? { host: host.toLowerCase(), path } : null;
}

/**
 * Whether a server is GitLab: gitlab.com, a self-managed one with "gitlab" in its name, or one the
 * config's `hosts` names as GitLab ({ "git.example.com": "gitlab" }).
 */
export function isGitlabHost(host, hosts = {}) {
  const named = Object.entries(hosts ?? {}).find(([h]) => h.toLowerCase() === host);
  if (named) return String(named[1]).toLowerCase() === 'gitlab';
  return host === 'gitlab.com' || host.includes('gitlab');
}

/**
 * Recognises GitHub, Azure DevOps and GitLab remote URLs (https and ssh). `hosts` is the config's map
 * of server names to what they are, for self-managed GitLab whose name doesn't say so.
 */
export function parseRemote(url, hosts = {}) {
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
  // GitLab projects can sit in nested groups (group/sub/repo), so the whole path is the project.
  const parts = remoteParts(url);
  if (parts && parts.path.includes('/') && isGitlabHost(parts.host, hosts)) {
    return { kind: 'gitlab', host: parts.host, path: parts.path, url: `https://${parts.host}/${parts.path}` };
  }
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

/** One GitHub PR from `gh pr list --json`, in Splice's shape. */
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
    head: p.headRefOid ?? null,
    draft: Boolean(p.isDraft),
    url: p.url,
    time: Date.parse(p.updatedAt) / 1000,
    review: GH_REVIEW[p.reviewDecision] ?? { text: 'No reviews', tone: 'none' },
    checks: checkSummary(p.statusCheckRollup),
    // Each reviewer's latest review, which notify.js compares from one poll to the next.
    reviews: (p.latestReviews ?? []).map((r) => ({ by: r.author?.login ?? '', state: r.state, at: r.submittedAt ?? '' })),
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

/** One Azure DevOps PR from `az repos pr list`, in Splice's shape. */
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
    head: p.lastMergeSourceCommit?.commitId ?? null,
    draft: Boolean(p.isDraft),
    url: `${remote.orgUrl}/${encodeURIComponent(remote.project)}/_git/${encodeURIComponent(remote.repo)}/pullrequest/${id}`,
    time: Date.parse(p.creationDate) / 1000,
    review: azureReview(reviewers),
    checks: null,
    // The votes cast, as reviews: a vote that changes is a new one.
    reviews: reviewers.filter((r) => r.vote !== 'none' && !r.me && !r.group).map((r) => ({ by: r.name, state: r.vote, at: '' })),
    conflicts: p.mergeStatus === 'conflicts',
    reviewers,
    description: p.description ?? '',
  };
}

/**
 * GitHub review comments (the pulls/<n>/comments REST API) as threads, in Splice's shape:
 * { id, nodeId, path, line, side: 'new' | 'old', outdated, resolved, comments: [{ id, author, body, time }] }.
 * A thread is a comment and its replies; `id` is the first comment's, which replies are posted to.
 * `nodeId` is the host's own id for the thread where it isn't `id` (resolving one goes by it), else null.
 * The REST API doesn't say which threads are resolved, so `resolved` is null: this is the fallback for
 * when GraphQL (githubReviewThreads) fails.
 */
export function githubThreads(comments) {
  const threadOf = new Map();
  const threads = [];
  for (const c of [...comments].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const comment = { id: c.id, author: c.user?.login ?? '', body: c.body ?? '', time: Date.parse(c.created_at) / 1000 };
    const parent = c.in_reply_to_id != null ? threadOf.get(c.in_reply_to_id) : null;
    if (parent) {
      parent.comments.push(comment);
      threadOf.set(c.id, parent);
      continue;
    }
    // A comment on code that has since changed has no line any more, only the one it was written on.
    const t = { id: c.id, nodeId: null, path: c.path, line: c.line ?? null, side: c.side === 'LEFT' ? 'old' : 'new', outdated: c.line == null, resolved: null, comments: [comment] };
    threads.push(t);
    threadOf.set(c.id, t);
  }
  return threads;
}

// A pull request's review threads through GitHub's GraphQL API, which (unlike REST) says which are
// resolved. A page at a time: `gh api graphql --paginate` fills $endCursor from pageInfo.
export const GITHUB_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line diffSide
          comments(first: 100) { nodes { databaseId body createdAt author { login } } }
        }
      }
    }
  }
}`;

/** `gh api graphql` arguments for a PR's review threads, one thread per line of output. */
export function githubThreadsArgs(remote, pr) {
  return ['api', 'graphql', '--paginate', '-f', `query=${GITHUB_THREADS_QUERY}`, '-f', `owner=${remote.owner}`, '-f', `repo=${remote.repo}`,
    '-F', `number=${pr.id}`, '--jq', '.data.repository.pullRequest.reviewThreads.nodes[]'];
}

/**
 * GitHub's GraphQL reviewThreads nodes as threads, in githubThreads' shape, with `resolved` known and
 * `nodeId` the thread's node id (which resolveReviewThread takes). Replies still go to the first comment.
 */
export function githubReviewThreads(nodes) {
  const out = [];
  for (const t of nodes ?? []) {
    const comments = (t.comments?.nodes ?? []).map((c) => ({ id: c.databaseId, author: c.author?.login ?? '', body: c.body ?? '', time: Date.parse(c.createdAt) / 1000 }));
    if (!comments.length) continue;
    out.push({
      id: comments[0].id,
      nodeId: t.id,
      path: t.path,
      line: t.line ?? null,
      side: t.diffSide === 'LEFT' ? 'old' : 'new',
      outdated: Boolean(t.isOutdated) || t.line == null,
      resolved: Boolean(t.isResolved),
      comments,
    });
  }
  return out;
}

/** `gh api graphql` arguments that resolve a review thread (by its node id), or reopen it. */
export function githubResolveArgs(nodeId, resolved) {
  const name = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  return ['api', 'graphql', '-f', `query=mutation($id: ID!) { ${name}(input: { threadId: $id }) { thread { id isResolved } } }`, '-f', `id=${nodeId}`];
}

/**
 * `gh api` arguments for a new review comment on one line of a PR's diff: `at` is { path, line, side }
 * ('new' is GitHub's RIGHT, 'old' its LEFT), `head` the commit the diff was made at. -F sends the line as a number.
 */
export function githubNewThreadArgs(repo, pr, head, at, text) {
  return ['api', '-X', 'POST', `repos/${repo}/pulls/${pr.id}/comments`, '-f', `body=${text}`, '-f', `commit_id=${head}`, '-f', `path=${at.path}`,
    '-F', `line=${at.line}`, '-f', `side=${at.side === 'old' ? 'LEFT' : 'RIGHT'}`];
}

/** `gh pr review` arguments asking for changes; GitHub won't take the review without its text. */
export function githubRequestChangesArgs(pr, repo, text) {
  return ['pr', 'review', String(pr.id), '-R', repo, '--request-changes', '--body', text];
}

// Azure DevOps thread statuses, as its API numbers them.
const AZURE_STATUS = { active: 1, fixed: 2 };

/**
 * The pullRequestThreads body for a new thread on one line of a PR's diff: `at` is { path, line, side, text },
 * the range the whole line (the right side is the source branch's file, the left the target's).
 */
export function azureNewThreadBody(at, text) {
  const side = at.side === 'old' ? 'left' : 'right';
  return {
    comments: [{ parentCommentId: 0, content: text, commentType: 1 }],
    status: AZURE_STATUS.active,
    threadContext: {
      filePath: `/${at.path.replace(/^\//, '')}`,
      [`${side}FileStart`]: { line: at.line, offset: 1 },
      [`${side}FileEnd`]: { line: at.line, offset: (at.text ?? '').length + 1 },
    },
  };
}

/** The body that marks an Azure DevOps thread fixed (resolved), or active again. */
export const azureResolveBody = (resolved) => ({ status: resolved ? AZURE_STATUS.fixed : AZURE_STATUS.active });

const DONE = new Set(['fixed', 'closed', 'byDesign', 'wontFix']);

/**
 * Azure DevOps pull request threads on code (pullRequestThreads), in the shape githubThreads gives.
 * General comments (no file) and the system's own notes are left out.
 */
export function azureThreads(value) {
  const out = [];
  for (const t of value ?? []) {
    const at = t.threadContext;
    if (t.isDeleted || !at?.filePath) continue;
    const comments = (t.comments ?? [])
      .filter((c) => !c.isDeleted && c.commentType !== 'system' && c.content)
      .map((c) => ({ id: c.id, author: c.author?.displayName ?? '', body: c.content, time: Date.parse(c.publishedDate) / 1000 }));
    if (!comments.length) continue;
    const side = at.rightFileStart ? 'new' : 'old';
    const line = (side === 'new' ? at.rightFileStart : at.leftFileStart)?.line ?? null;
    out.push({ id: t.id, nodeId: null, path: at.filePath.replace(/^\//, ''), line, side, outdated: false, resolved: DONE.has(t.status), comments });
  }
  return out;
}

/**
 * A GitHub PR's checks, from statusCheckRollup (check runs and commit statuses), in Splice's shape:
 * { name, workflow, state: 'pass' | 'fail' | 'pending', url, runId, jobId }. A GitHub Actions job
 * carries its run and job ids (from its link), which its log and re-running need.
 */
export function githubChecks(rollup = []) {
  return (rollup ?? []).map((c) => {
    const url = c.detailsUrl || c.targetUrl || null;
    const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(url ?? '');
    const sum = checkSummary([c]);
    return {
      name: c.name || c.context || 'Check',
      workflow: c.workflowName || '',
      state: sum.failed ? 'fail' : sum.passed ? 'pass' : 'pending',
      url,
      runId: m ? m[1] : null,
      jobId: m ? m[2] : null,
    };
  });
}

const POLICY_STATE = { approved: 'pass', rejected: 'fail', running: 'pending', queued: 'pending', broken: 'fail' };

/**
 * An Azure DevOps PR's policy evaluations (`az repos pr policy list`) as checks, in githubChecks' shape plus
 * `evaluationId` (to queue it again) and `buildId` for build policies, whose results page is the link.
 */
export function azureChecks(policies, remote) {
  return (policies ?? [])
    .filter((p) => p.status !== 'notApplicable')
    .map((p) => {
      const buildId = p.context?.buildId ?? null;
      return {
        name: p.configuration?.settings?.displayName || p.configuration?.type?.displayName || 'Policy',
        workflow: buildId ? 'Build' : '',
        state: POLICY_STATE[p.status] ?? 'pending',
        url: buildId ? `${remote.orgUrl}/${encodeURIComponent(remote.project)}/_build/results?buildId=${buildId}` : null,
        evaluationId: p.evaluationId ?? null,
        buildId,
      };
    });
}

/** The log ids of a build's failed steps, from its timeline (records with result "failed" and a log). */
export function failedLogs(timeline) {
  return (timeline?.records ?? [])
    .filter((r) => r.result === 'failed' && r.log?.id != null)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((r) => ({ id: r.log.id, name: r.name ?? '' }));
}

// GitLab: merge requests through its REST v4 API (`glab api`), and the open ones' list through its
// GraphQL API, which answers with the approvals, reviewers' states and pipeline in one call. The GraphQL
// query names its fields as REST does, so one normaliser (gitlabPr) reads both.

const lower = (s) => String(s ?? '').toLowerCase();
// A GraphQL connection ({ nodes }) or a REST array; an approval ({ user }) or the user itself.
const nodes = (x) => (Array.isArray(x) ? x : (x?.nodes ?? []));
const userOf = (x) => x?.user ?? x ?? {};
const nameOf = (u) => u?.name || u?.username || '';

/**
 * Concatenated JSON from `glab api --paginate`, which prints each page after the one before
 * ([...][...]), as one array; a single value that isn't an array comes back as [value].
 */
export function jsonPages(text) {
  const s = (text ?? '').trim();
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [v];
  } catch {}
  const out = [];
  let depth = 0;
  let start = 0;
  let str = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') str = false;
    } else if (c === '"') str = true;
    else if (c === '[' || c === '{') {
      if (depth++ === 0) start = i;
    } else if ((c === ']' || c === '}') && --depth === 0) {
      const v = JSON.parse(s.slice(start, i + 1));
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    }
  }
  return out;
}

// GitLab's pipeline and job statuses as a check's state. A manual job (or a pipeline waiting on one) is
// still to be started by someone, so it counts as pending.
const GITLAB_STATE = { success: 'pass', skipped: 'pass', failed: 'fail', canceled: 'fail', canceling: 'fail' };
export const gitlabState = (status) => GITLAB_STATE[lower(status)] ?? 'pending';

/** The open merge requests, with what the list shows of each, from GitLab's GraphQL API. */
export function gitlabMrsQuery(path) {
  return `query {
  project(fullPath: ${JSON.stringify(path)}) {
    mergeRequests(state: opened, first: 100, sort: UPDATED_DESC) {
      nodes {
        iid title description draft approved
        web_url: webUrl
        updated_at: updatedAt
        source_branch: sourceBranch
        target_branch: targetBranch
        sha: diffHeadSha
        has_conflicts: conflicts
        detailed_merge_status: detailedMergeStatus
        author { username name }
        approved_by: approvedBy { nodes { username name } }
        reviewers { nodes { username name mergeRequestInteraction { review_state: reviewState } } }
        head_pipeline: headPipeline { status }
      }
    }
  }
}`;
}

/**
 * Overall review state of a GitLab merge request: changes requested by a reviewer, approved (`approved`
 * is GitLab's "has every approval it needs", true too when none are required), some approvals of more
 * needed, or none yet. The REST list has no approvals, only `detailed_merge_status`.
 */
export function gitlabReview(mr) {
  const states = nodes(mr.reviewers).map((r) => lower(r.review_state ?? r.mergeRequestInteraction?.review_state));
  if (states.includes('requested_changes')) return { text: 'Changes requested', tone: 'bad' };
  const approvers = nodes(mr.approved_by);
  if (approvers.length) return mr.approved === false ? { text: `${approvers.length} approved`, tone: 'wait' } : { text: 'Approved', tone: 'good' };
  if (mr.approved === false || lower(mr.detailed_merge_status) === 'not_approved') return { text: 'Approval required', tone: 'wait' };
  return { text: 'No reviews', tone: 'none' };
}

// A reviewer's state as the vote PrView draws, and as the review notify.js tells you about.
const GITLAB_VOTE = { approved: 'approved', requested_changes: 'rejected', reviewed: 'commented' };
const GITLAB_REVIEWED = { approved: 'approved', rejected: 'CHANGES_REQUESTED', commented: 'COMMENTED' };

/**
 * One GitLab merge request, from the GraphQL list (gitlabMrsQuery) or the REST API's merge_requests, in
 * Splice's shape. Merge requests are numbered per project (iid), shown as !12. The checks are the head
 * pipeline's status, as one check: the list doesn't carry its jobs.
 */
export function gitlabPr(mr, me, remote) {
  const id = Number(mr.iid);
  const author = mr.author ?? {};
  const mine = same(author.username, me);
  const approvers = nodes(mr.approved_by).map(userOf);
  const approved = new Set(approvers.map((u) => lower(u.username)));
  const reviewers = nodes(mr.reviewers).map((r) => {
    const state = lower(r.review_state ?? r.mergeRequestInteraction?.review_state);
    const vote = approved.has(lower(r.username)) ? 'approved' : (GITLAB_VOTE[state] ?? 'none');
    return { name: nameOf(r), username: r.username, vote, required: false, group: false, me: same(r.username, me) };
  });
  // Anyone may approve, asked to review or not.
  for (const u of approvers) {
    if (!reviewers.some((r) => same(r.username, u.username))) reviewers.push({ name: nameOf(u), username: u.username, vote: 'approved', required: false, group: false, me: same(u.username, me) });
  }
  const state = mr.head_pipeline?.status ? gitlabState(mr.head_pipeline.status) : null;
  return {
    id,
    label: `!${id}`,
    title: mr.title,
    author: nameOf(author),
    mine,
    reviewMe: !mine && reviewers.some((r) => r.me && r.vote === 'none'),
    source: mr.source_branch,
    target: mr.target_branch,
    head: mr.sha ?? null,
    draft: Boolean(mr.draft ?? mr.work_in_progress),
    url: mr.web_url ?? `${remote.url}/-/merge_requests/${id}`,
    time: Date.parse(mr.updated_at) / 1000,
    review: gitlabReview(mr),
    checks: state ? { passed: Number(state === 'pass'), failed: Number(state === 'fail'), pending: Number(state === 'pending') } : null,
    reviews: reviewers.filter((r) => r.vote !== 'none' && !r.me).map((r) => ({ by: r.name, state: GITLAB_REVIEWED[r.vote], at: '' })),
    conflicts: Boolean(mr.has_conflicts),
    reviewers,
    description: mr.description ?? '',
  };
}

/** A merge request's comments (its notes), without GitLab's own ("added 2 commits") or those on lines of the diff. */
export function gitlabComments(notes) {
  return (notes ?? [])
    .filter((n) => !n.system && n.type !== 'DiffNote' && n.body)
    .map((n) => ({ author: nameOf(n.author), text: n.body, time: Date.parse(n.created_at) / 1000 }))
    .sort((a, b) => a.time - b.time);
}

/**
 * GitLab merge request discussions on lines of the diff, in the shape githubThreads gives; `id` is the
 * discussion's, which replies and resolving go to. `head` is the merge request's head commit now: a
 * discussion on another one is about code that has since changed (outdated), so its line isn't placed.
 * General discussions, GitLab's own notes and comments on images are left out.
 */
export function gitlabThreads(discussions, head = null) {
  const out = [];
  for (const d of discussions ?? []) {
    const notes = (d.notes ?? []).filter((n) => !n.system);
    const pos = notes[0]?.type === 'DiffNote' ? notes[0].position : null;
    if (!pos || (pos.position_type && pos.position_type !== 'text')) continue;
    const side = pos.new_line != null ? 'new' : 'old';
    const outdated = Boolean(head && pos.head_sha && pos.head_sha !== head);
    const resolvable = notes.filter((n) => n.resolvable);
    out.push({
      id: d.id,
      nodeId: null,
      path: (side === 'new' ? pos.new_path : pos.old_path) ?? pos.new_path ?? pos.old_path,
      line: outdated ? null : ((side === 'new' ? pos.new_line : pos.old_line) ?? null),
      side,
      outdated,
      resolved: resolvable.length ? resolvable.every((n) => n.resolved) : null,
      comments: notes.map((n) => ({ id: n.id, author: nameOf(n.author), body: n.body ?? '', time: Date.parse(n.created_at) / 1000 })),
    });
  }
  return out;
}

/**
 * The discussions body for a new thread on one line of a merge request's diff: `refs` is the merge
 * request's diff_refs, `at` { path, line, side, old | new }. A line both sides have (one around the changes)
 * needs both its numbers, which `old` or `new` gives.
 */
export function gitlabNewThreadBody(refs, at, text) {
  const position = { position_type: 'text', base_sha: refs?.base_sha, start_sha: refs?.start_sha, head_sha: refs?.head_sha, old_path: at.path, new_path: at.path };
  if (at.side === 'old') {
    position.old_line = at.line;
    if (at.new != null) position.new_line = at.new;
  } else {
    position.new_line = at.line;
    if (at.old != null) position.old_line = at.old;
  }
  return { body: text, position };
}

/**
 * A pipeline's jobs as checks, in githubChecks' shape plus `jobId` (its log, retrying) and `pipelineId`.
 * A job allowed to fail doesn't fail the pipeline, so it doesn't count as failed here either.
 */
export function gitlabChecks(jobs, pipelineId = null) {
  return (jobs ?? []).map((j) => {
    const allowed = Boolean(j.allow_failure) && gitlabState(j.status) === 'fail';
    return {
      name: allowed ? `${j.name} (allowed to fail)` : j.name,
      workflow: j.stage ?? '',
      state: allowed ? 'pass' : gitlabState(j.status),
      url: j.web_url ?? null,
      jobId: j.id ?? null,
      pipelineId: j.pipeline?.id ?? pipelineId,
    };
  });
}

/**
 * A GitLab job's log as text: without its colours, the markers that fold its sections, and what a
 * progress bar wrote over with \r (only the last of it stays).
 */
export function gitlabTrace(text) {
  return (text ?? '')
    .replace(/section_(?:start|end):\d+:[^\r\n]*?\r(?:\x1b\[0K)?/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.split('\r').filter(Boolean).at(-1) ?? '')
    .join('\n')
    .trimEnd();
}

// GitLab drafts are a title prefix: Draft:, [Draft] or (Draft).
const DRAFT_PREFIX = /^\s*(?:draft:|\[draft\]|\(draft\))\s*/i;

/** A merge request's title made a draft ("Draft: …"), or ready (the prefix taken off). */
export const gitlabDraftTitle = (title, draft) => {
  const bare = (title ?? '').replace(DRAFT_PREFIX, '');
  return draft ? `Draft: ${bare}` : bare;
};

/**
 * The merge_requests/<iid>/merge body. Auto-merge is GitLab's "merge when the pipeline succeeds" (named
 * auto_merge since GitLab 17; both are sent, and each version ignores the name it doesn't know).
 * `sha` makes GitLab refuse if the branch has moved since it was looked at.
 */
export function gitlabMergeBody({ method, deleteBranch, auto }, sha) {
  return {
    squash: method === 'squash',
    should_remove_source_branch: Boolean(deleteBranch),
    ...(auto ? { merge_when_pipeline_succeeds: true, auto_merge: true } : {}),
    ...(sha ? { sha } : {}),
  };
}

/** Release notes made here, as GitLab writes none: the subjects of the commits since the tag before. */
export function gitlabReleaseNotes(subjects, since) {
  const list = subjects.filter(Boolean);
  if (!list.length) return '';
  return [`Changes${since ? ` since ${since}` : ''}:`, '', ...list.map((s) => `- ${s}`)].join('\n');
}

// How a pull request can be merged, in the order offered. Azure DevOps' CLI only chooses between squashing or not;
// on GitLab, rebase rebases the branch on the server first, then merges it as the project merges.
export const MERGE_METHODS = { github: ['squash', 'merge', 'rebase'], azure: ['squash', 'merge'], gitlab: ['squash', 'merge', 'rebase'] };
export const MERGE_LABELS = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };

/**
 * Reads "/merge-pr" arguments: a method (squash, merge or rebase), --delete-branch (-d) and --auto.
 * Leaves out what isn't given (null), so the rest can be asked.
 */
export function mergePrArgs(text) {
  const out = { method: null, deleteBranch: null, auto: null };
  for (const w of (text ?? '').split(/\s+/).filter(Boolean)) {
    if (MERGE_LABELS[w.replace(/^--/, '')]) out.method = w.replace(/^--/, '');
    else if (w === '--delete-branch' || w === '-d') out.deleteBranch = true;
    else if (w === '--keep-branch') out.deleteBranch = false;
    else if (w === '--auto') out.auto = true;
    else return { ...out, error: `Unknown option: ${w}. Use squash, merge or rebase, --delete-branch, --keep-branch, --auto.` };
  }
  return out;
}

/**
 * Reads "/body" arguments: `--file <path>` (the description is that file), text (with \n for a line
 * break), or nothing, which asks for the file to be made.
 */
export function bodyArgs(text) {
  const s = (text ?? '').trim();
  const file = /^--file(?:\s+([\s\S]*))?$/.exec(s);
  if (file) return { file: (file[1] ?? '').trim().replace(/^(["'])(.*)\1$/, '$2') || null };
  if (!s) return {};
  return { text: s.replace(/\\n/g, '\n') };
}

/**
 * Reads "/release <tag> [--draft] [--notes-file <path>] [title]": the title is the rest, kept as typed. The
 * path may be in double quotes; `notesFile` is there only when given.
 */
export function releaseArgs(text) {
  let draft = false;
  let notesFile = null;
  const rest = (text ?? '')
    .replace(/(^|\s)--notes-file\s+(?:"([^"]*)"|(\S+))/g, (_, space, quoted, bare) => {
      notesFile = quoted ?? bare;
      return space;
    })
    .replace(/(^|\s)--draft(?=\s|$)/g, (_, space) => {
      draft = true;
      return space;
    });
  const m = /^\s*(\S+)\s*([\s\S]*)$/.exec(rest);
  return { tag: m ? m[1] : null, title: m ? m[2].replace(/\s+/g, ' ').trim() : '', draft, ...(notesFile ? { notesFile } : {}) };
}

/**
 * `gh release create` arguments: only for a tag the server already has, with notes GitHub writes, or with
 * `notes` given (sent on stdin: --notes-file -).
 */
export function githubReleaseArgs(repo, { tag, title, draft, notes }) {
  return ['release', 'create', tag, '-R', repo, '--verify-tag', ...(notes != null ? ['--notes-file', '-'] : ['--generate-notes']), ...(title ? ['--title', title] : []), ...(draft ? ['--draft'] : [])];
}

/** `gh pr merge` arguments. --auto merges once the required checks and reviews pass. */
export function githubMergeArgs(pr, repo, { method, deleteBranch, auto }) {
  return ['pr', 'merge', String(pr.id), '-R', repo, `--${method}`, ...(deleteBranch ? ['--delete-branch'] : []), ...(auto ? ['--auto'] : [])];
}

/** `az repos pr update` arguments: completed now, or set to complete itself (auto-complete) once its policies pass. */
export function azureMergeArgs(pr, { method, deleteBranch, auto }) {
  return [
    'repos', 'pr', 'update', '--id', String(pr.id),
    ...(auto ? ['--auto-complete', 'true'] : ['--status', 'completed']),
    '--squash', method === 'squash' ? 'true' : 'false',
    '--delete-source-branch', deleteBranch ? 'true' : 'false',
  ];
}

// One pull request by its number, whatever its state, with what /ship, /review-pr and /backport need:
// `state` ('open', 'merged' or 'closed'), `mergeCommit` (the commit on the target that merged it: a merge
// commit, the squashed one, or the last of the rebased ones) and its own `commits` ({ hash, subject }, oldest first).

const GH_STATE = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

/** A GitHub PR from `gh pr view --json` (with state, mergeCommit and commits), in Splice's shape plus those. */
export function githubPrFull(p) {
  return {
    ...githubPr(p, ''),
    state: GH_STATE[p.state] ?? lower(p.state),
    mergeCommit: p.mergeCommit?.oid ?? null,
    mergedAt: p.mergedAt ?? null,
    fork: Boolean(p.isCrossRepository),
    commits: (p.commits ?? []).map((c) => ({ hash: c.oid, subject: c.messageHeadline ?? '' })),
  };
}

const AZ_STATE = { active: 'open', completed: 'merged', abandoned: 'closed' };

/** An Azure DevOps PR (`az repos pr show`) and its commits (pullRequestCommits, newest first), in githubPrFull's shape. */
export function azurePrFull(p, commits, remote) {
  return {
    ...azurePr(p, '', remote),
    state: AZ_STATE[p.status] ?? lower(p.status),
    mergeCommit: p.status === 'completed' ? (p.lastMergeCommit?.commitId ?? null) : null,
    mergedAt: p.status === 'completed' ? (p.closedDate ?? null) : null,
    fork: Boolean(p.forkSource),
    commits: [...(commits ?? [])].reverse().map((c) => ({ hash: c.commitId, subject: firstLineOf(c.comment) })),
  };
}

const GL_STATE = { opened: 'open', merged: 'merged', closed: 'closed', locked: 'closed' };

/**
 * A GitLab merge request (REST) and its commits (newest first), in githubPrFull's shape. GitLab names the
 * merge commit, or else the squashed one; a fast-forward merge leaves the branch's own head on the target.
 */
export function gitlabPrFull(mr, commits, remote) {
  const merged = mr.state === 'merged';
  return {
    ...gitlabPr(mr, '', remote),
    state: GL_STATE[mr.state] ?? lower(mr.state),
    mergeCommit: merged ? (mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha ?? null) : null,
    mergedAt: mr.merged_at ?? null,
    fork: mr.source_project_id != null && mr.source_project_id !== mr.target_project_id,
    commits: [...(commits ?? [])].reverse().map((c) => ({ hash: c.id, subject: c.title ?? firstLineOf(c.message) })),
  };
}

const firstLineOf = (s) => String(s ?? '').split('\n')[0];

/**
 * Where a pull request's head is on the host's remote, to fetch it from: GitHub keeps every PR's (forks'
 * too) at refs/pull/<n>/head, GitLab at refs/merge-requests/<iid>/head; Azure DevOps keeps only the merge
 * it would make, so there it's the source branch.
 */
export function prHeadRef(kind, pr) {
  if (kind === 'github') return `refs/pull/${pr.id}/head`;
  if (kind === 'gitlab') return `refs/merge-requests/${pr.id}/head`;
  return `refs/heads/${pr.source}`;
}

/** The number in a pull request's link, as the hosts' create answers with it (…/pull/12, …/merge_requests/12, …/pullrequest/12). */
export function prIdFromUrl(url) {
  const m = /\/(?:pull|pulls|merge_requests|pullrequest)\/(\d+)\/?(?:[?#].*)?$/.exec(String(url ?? '').trim());
  return m ? Number(m[1]) : null;
}

/** A merged pull request, for release notes: { id, label, title, url, author, target, mergedAt }. */
const mergedEntry = (pr, mergedAt) => ({ id: pr.id, label: pr.label, title: pr.title, url: pr.url, author: pr.author, target: pr.target, mergedAt });

/** The ones merged at `since` (an ISO date) or after, newest first. */
export function mergedAfter(list, since) {
  const from = Date.parse(since);
  return list.filter((p) => p.mergedAt && !(Date.parse(p.mergedAt) < from)).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
}

/** Your review requests first, then your own PRs, then the rest; newest first within each. */
export function sortPrs(prs) {
  const rank = (p) => (p.reviewMe ? 0 : p.mine ? 1 : 2);
  return [...prs].sort((a, b) => rank(a) - rank(b) || b.time - a.time);
}

/**
 * The branch name on the host's remote that local branch `b`'s pull requests come from: what it
 * tracks there, else its own name when it tracks nothing. Null when it tracks another remote.
 */
export function prSource(b, remoteName) {
  const prefix = `${remoteName}/`;
  return !b.upstream ? b.name : b.upstream.startsWith(prefix) ? b.upstream.slice(prefix.length) : null;
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
    const source = prSource(b, remoteName);
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
    // Written to stdin, for what's too big for an argument (a diff for Claude). A program that exits
    // before reading it all (not signed in, say) closes the pipe first: its own error is the answer.
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input);
  });
}

const json = async (p) => JSON.parse(await p);

// Runs `fn` with the path of a temporary file holding `body` as JSON, removed afterwards.
async function withJsonFile(body, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'splice-'));
  const file = join(dir, 'body.json');
  try {
    await writeFile(file, JSON.stringify(body));
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function github(root, remote) {
  const gh = (args, opts) => cli('gh', args, { cwd: root, ...opts });
  const repoArg = ['-R', `${remote.owner}/${remote.repo}`];
  let me;
  const whoami = async () => (me ??= (await gh(['api', 'user', '--jq', '.login'])).trim());
  return {
    kind: 'github',
    name: 'GitHub',
    signIn: 'gh auth login',
    // Your login, for leaving yourself out of the reviewers CODEOWNERS suggests.
    me: whoami,
    async list() {
      const [login, list] = await Promise.all([
        whoami(),
        json(gh(['pr', 'list', ...repoArg, '--state', 'open', '--limit', '100', '--json',
          'number,title,author,headRefName,baseRefName,isDraft,reviewDecision,url,updatedAt,reviewRequests,statusCheckRollup,latestReviews,body'])),
      ]);
      return sortPrs(list.map((p) => githubPr(p, login)));
    },
    // The latest merged PRs, for /cleanup. A fork's branch names aren't this repository's (`fork`).
    async merged(signal) {
      const list = await json(gh(['pr', 'list', ...repoArg, '--state', 'merged', '--limit', '200', '--json',
        'number,title,headRefName,headRefOid,baseRefName,isCrossRepository,url,updatedAt'], { signal }));
      return list.map((p) => ({ ...githubPr(p, ''), fork: Boolean(p.isCrossRepository) }));
    },
    // One PR by number, in any state, with its merge commit and its own commits.
    async pr(id, signal) {
      return githubPrFull(await json(gh(['pr', 'view', String(id), ...repoArg, '--json',
        'number,title,author,headRefName,baseRefName,headRefOid,isDraft,url,updatedAt,body,state,mergeCommit,mergedAt,commits,isCrossRepository'], { signal })));
    },
    // The PRs merged since a date, for release notes: GitHub's search goes by merge time.
    async mergedSince(since, signal) {
      const day = new Date(since).toISOString().replace(/\.\d+Z$/, 'Z');
      const list = await json(gh(['pr', 'list', ...repoArg, '--state', 'merged', '--search', `merged:>=${day}`, '--limit', '200', '--json',
        'number,title,author,url,baseRefName,headRefName,mergedAt,updatedAt'], { signal }));
      return mergedAfter(list.map((p) => mergedEntry(githubPr(p, ''), p.mergedAt)), since);
    },
    headRef: (pr) => prHeadRef('github', pr),
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
        checks: githubChecks(d.statusCheckRollup),
        comments: (d.comments ?? []).map((c) => ({ author: c.author?.login, text: c.body, time: Date.parse(c.createdAt) / 1000 })),
        conflicts: d.mergeable === 'CONFLICTING',
      };
    },
    diff: (pr) => gh(['pr', 'diff', String(pr.id), ...repoArg]),
    // GraphQL says which threads are resolved; the REST comments are the fallback, without that.
    // --jq: one thread (or comment) per line, which reads the same whatever page it came on.
    async threads(pr) {
      const lines = (out) => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      try {
        return githubReviewThreads(lines(await gh(githubThreadsArgs(remote, pr))));
      } catch {
        return githubThreads(lines(await gh(['api', '--paginate', `repos/${remote.owner}/${remote.repo}/pulls/${pr.id}/comments`, '--jq', '.[]'])));
      }
    },
    // -f sends the text as it is (-F would read a file for text starting with @).
    reply: (pr, thread, text, signal) =>
      gh(['api', '-X', 'POST', `repos/${remote.owner}/${remote.repo}/pulls/${pr.id}/comments/${thread.id}/replies`, '-f', `body=${text}`], { signal }),
    // On the PR's head as it is now, which the diff on screen was made from.
    async addThread(pr, at, text, signal) {
      const head = (await gh(['pr', 'view', String(pr.id), ...repoArg, '--json', 'headRefOid', '--jq', '.headRefOid'], { signal })).trim();
      return gh(githubNewThreadArgs(`${remote.owner}/${remote.repo}`, pr, head, at, text), { signal });
    },
    async resolveThread(pr, thread, resolved, signal) {
      if (!thread.nodeId) throw new Error("GitHub's GraphQL API didn't answer when the comments were loaded, so Splice doesn't know this thread's id there to resolve it.");
      return gh(githubResolveArgs(thread.nodeId, resolved), { signal });
    },
    checkout: (pr, signal) => gh(['pr', 'checkout', String(pr.id), ...repoArg], { signal }),
    approve: (pr, signal) => gh(['pr', 'review', String(pr.id), ...repoArg, '--approve'], { signal }),
    requestChangesNeedsText: true,
    requestChanges: (pr, text, signal) => gh(githubRequestChangesArgs(pr, `${remote.owner}/${remote.repo}`, text), { signal }),
    mergeMethods: MERGE_METHODS.github,
    async checks(pr) {
      return githubChecks((await json(gh(['pr', 'view', String(pr.id), ...repoArg, '--json', 'statusCheckRollup']))).statusCheckRollup);
    },
    // A GitHub Actions job's log: just its failed steps when it failed, else all of it.
    async checkLog(check, signal) {
      if (!check.jobId) throw new Error(`${check.name} isn't a GitHub Actions job, so its log is on its own site: o opens it.`);
      const log = (failed) => gh(['run', 'view', '--job', check.jobId, ...repoArg, failed ? '--log-failed' : '--log'], { signal });
      const out = check.state === 'fail' ? await log(true).catch(() => '') : '';
      return out.trim() ? out : log(false);
    },
    releaseDrafts: true,
    releaseNotesBy: 'GitHub writes the notes from what was merged since the last release.',
    async createRelease(opts, signal) {
      return (await gh(githubReleaseArgs(`${remote.owner}/${remote.repo}`, opts), { signal, input: opts.notes ?? undefined })).trim().split('\n').at(-1);
    },
    addReviewers: (pr, names, signal) => gh(['pr', 'edit', String(pr.id), ...repoArg, '--add-reviewer', names.join(',')], { signal }),
    setDraft: (pr, draft, signal) => gh(['pr', 'ready', String(pr.id), ...repoArg, ...(draft ? ['--undo'] : [])], { signal }),
    // The body goes on stdin (--body-file -): it can be long, and is taken as it is.
    edit: (pr, { title, body }, signal) =>
      gh(['pr', 'edit', String(pr.id), ...repoArg, ...(title != null ? ['--title', title] : []), ...(body != null ? ['--body-file', '-'] : [])], {
        signal,
        input: body ?? undefined,
      }),
    canRerun: true,
    async rerun(pr, checks, signal) {
      const runs = [...new Set(checks.filter((c) => c.state === 'fail' && c.runId).map((c) => c.runId))];
      if (!runs.length) throw new Error('None of the failed checks is a GitHub Actions run, so there is nothing to re-run from here.');
      for (const run of runs) await gh(['run', 'rerun', run, '--failed', ...repoArg], { signal });
      return `Re-running the failed jobs of ${runs.length} workflow run${runs.length === 1 ? '' : 's'}`;
    },
    merge: (pr, opts, signal) => gh(githubMergeArgs(pr, `${remote.owner}/${remote.repo}`, opts), { signal }),
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
  // Posting needs a JSON body, which `az devops invoke` only takes from a file.
  const post = (route, body, signal, method = 'POST') => withJsonFile(body, (file) => az([...route, '--http-method', method, '--in-file', file], { signal }));
  const comment = (pr, text, signal) => post(threadsRoute(pr), { comments: [{ parentCommentId: 0, content: text, commentType: 1 }], status: AZURE_STATUS.active }, signal);
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
    // The latest completed (merged) PRs, for /cleanup. A fork's branch names aren't this repository's (`fork`).
    async merged(signal) {
      const list = await json(az(['repos', 'pr', 'list', '--project', remote.project, '--repository', remote.repo, '--status', 'completed', '--top', '200'], { signal }));
      return list.map((p) => ({ ...azurePr(p, '', remote), fork: Boolean(p.forkSource) }));
    },
    async pr(id, signal) {
      const [p, commits] = await Promise.all([
        json(az(['repos', 'pr', 'show', '--id', String(id)], { signal })),
        json(az(['devops', 'invoke', '--area', 'git', '--resource', 'pullRequestCommits', '--api-version', '7.0', '--route-parameters',
          `project=${remote.project}`, `repositoryId=${remote.repo}`, `pullRequestId=${id}`], { signal })).catch((e) => {
          if (e.cancelled) throw e;
          return { value: [] };
        }),
      ]);
      return azurePrFull(p, commits.value, remote);
    },
    // The CLI can't ask for a date, so the latest completed ones are read and the older ones left out.
    async mergedSince(since, signal) {
      const list = await json(az(['repos', 'pr', 'list', '--project', remote.project, '--repository', remote.repo, '--status', 'completed', '--top', '200'], { signal }));
      return mergedAfter(list.map((p) => mergedEntry(azurePr(p, '', remote), p.closedDate)), since);
    },
    headRef: (pr) => prHeadRef('azure', pr),
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
      return { reviewers: pr.reviewers, checks: azureChecks(policies, remote), comments, conflicts: pr.conflicts };
    },
    // Azure DevOps has no "pr diff" command, so diff the two branches locally (three dots: what the PR adds).
    async diff(pr) {
      const spec = (b) => `+refs/heads/${b}:refs/remotes/${remoteName}/${b}`;
      await git(root, ['fetch', '--quiet', remoteName, spec(pr.source), spec(pr.target)]);
      return git(root, ['diff', '-M', `${remoteName}/${pr.target}...${remoteName}/${pr.source}`]);
    },
    checkout: null, // done with plain git: fetch, then switch to a tracking branch
    approve: (pr, signal) => az(['repos', 'pr', 'set-vote', '--id', String(pr.id), '--vote', 'approve'], { signal }),
    mergeMethods: MERGE_METHODS.azure,
    async checks(pr) {
      return azureChecks(await json(az(['repos', 'pr', 'policy', 'list', '--id', String(pr.id)])), remote);
    },
    // A build policy's log: the failed steps' logs, from the build's timeline (each log comes as its lines).
    async checkLog(check, signal) {
      if (!check.buildId) throw new Error(`${check.name} isn't a build, so it has no log.`);
      const build = (resource, ...params) =>
        json(az(['devops', 'invoke', '--area', 'build', '--resource', resource, '--api-version', '7.0', '--route-parameters',
          `project=${remote.project}`, `buildId=${check.buildId}`, ...params], { signal }));
      const logs = failedLogs(await build('timeline'));
      if (!logs.length) throw new Error(`No failed step in build ${check.buildId} has a log: o opens the build in the browser.`);
      const parts = [];
      for (const l of logs) parts.push(`##[section] ${l.name}`, ...((await build('logs', `logId=${l.id}`)).value ?? []), '');
      return parts.join('\n');
    },
    createRelease: null, // Azure DevOps has no releases made from tags
    addReviewers: (pr, names, signal) => az(['repos', 'pr', 'reviewer', 'add', '--id', String(pr.id), '--reviewers', ...names], { signal }),
    setDraft: (pr, draft, signal) => az(['repos', 'pr', 'update', '--id', String(pr.id), '--draft', String(draft)], { signal }),
    // az takes the description as one value per line, as in create.
    edit: (pr, { title, body }, signal) =>
      az(['repos', 'pr', 'update', '--id', String(pr.id), ...(title != null ? ['--title', title] : []), ...(body != null ? ['--description', ...(body ? body.split('\n') : [''])] : [])], { signal }),
    canRerun: true,
    async rerun(pr, checks, signal) {
      const evals = checks.filter((c) => c.state === 'fail' && c.evaluationId);
      if (!evals.length) throw new Error('None of the failed policies can be queued again.');
      for (const c of evals) await az(['repos', 'pr', 'policy', 'queue', '--id', String(pr.id), '--evaluation-id', c.evaluationId], { signal });
      return `Queued ${evals.length} polic${evals.length === 1 ? 'y' : 'ies'} again`;
    },
    merge: (pr, opts, signal) => az(azureMergeArgs(pr, opts), { signal }).then(() => (opts.auto ? `${pr.label} will complete once its policies pass` : `Completed ${pr.label}`)),
    comment,
    // Waiting for the author is Azure DevOps' vote for "changes needed"; the text, if any, goes as a comment.
    async requestChanges(pr, text, signal) {
      await az(['repos', 'pr', 'set-vote', '--id', String(pr.id), '--vote', 'wait-for-author'], { signal });
      if (text) await comment(pr, text, signal);
    },
    addThread: (pr, at, text, signal) => post(threadsRoute(pr), azureNewThreadBody(at, text), signal),
    resolveThread: (pr, thread, resolved, signal) => post([...threadsRoute(pr), `threadId=${thread.id}`], azureResolveBody(resolved), signal, 'PATCH'),
    async threads(pr) {
      return azureThreads((await json(az(threadsRoute(pr)))).value);
    },
    reply: (pr, thread, text, signal) =>
      post(
        ['devops', 'invoke', '--area', 'git', '--resource', 'pullRequestThreadComments', '--api-version', '7.0', '--route-parameters',
          `project=${remote.project}`, `repositoryId=${remote.repo}`, `pullRequestId=${pr.id}`, `threadId=${thread.id}`],
        { content: text, parentCommentId: thread.comments[0].id, commentType: 1 },
        signal,
      ),
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

function gitlab(root, remote, remoteName) {
  const glab = (args, opts) => cli('glab', ['api', '--hostname', remote.host, ...args], { cwd: root, ...opts });
  const project = `projects/${encodeURIComponent(remote.path)}`;
  const mr = (pr, rest = '') => `${project}/merge_requests/${pr.id}${rest}`;
  const read = async (path, { signal } = {}) => JSON.parse(await glab([path], { signal }));
  const readAll = async (path, { signal } = {}) => jsonPages(await glab(['--paginate', path], { signal }));
  // Writes send a JSON body, which `glab api` reads from a file.
  const send = (method, path, body, signal) =>
    body == null
      ? glab(['-X', method, path], { signal })
      : withJsonFile(body, (file) => glab(['-X', method, '-H', 'Content-Type: application/json', '--input', file, path], { signal }));
  const comment = (pr, text, signal) => send('POST', mr(pr, '/notes'), { body: text }, signal);
  let me;
  const whoami = async () => (me ??= (await read('user')).username);
  // GraphQL first, for the approvals and pipelines; the REST list, without them, if it won't answer.
  const openMrs = async () => {
    try {
      const out = JSON.parse(await glab(['graphql', '-f', `query=${gitlabMrsQuery(remote.path)}`]));
      if (out.errors?.length || !out.data?.project) throw new Error(out.errors?.[0]?.message ?? 'No project');
      return out.data.project.mergeRequests.nodes;
    } catch (e) {
      if (e.cancelled) throw e;
      return readAll(`${project}/merge_requests?state=opened&per_page=100&order_by=updated_at`);
    }
  };
  // The jobs of the merge request's latest pipeline.
  const checks = async (pr, signal) => {
    const [pipeline] = await read(mr(pr, '/pipelines?per_page=1'), { signal });
    if (!pipeline) return [];
    return gitlabChecks(await readAll(`${project}/pipelines/${pipeline.id}/jobs?per_page=100`, { signal }), pipeline.id);
  };
  // Rebasing on the server runs in the background: wait until it's done, and merge what it made.
  const rebase = async (pr, signal) => {
    await send('PUT', mr(pr, '/rebase'), null, signal);
    for (let i = 0; i < 120; i++) {
      await wait(1000, null, { signal }).catch(() => {
        throw Object.assign(new Error('Cancelled'), { cancelled: true });
      });
      const m = await read(mr(pr, '?include_rebase_in_progress=true'), { signal });
      if (m.rebase_in_progress) continue;
      if (m.merge_error) throw new Error(`GitLab couldn't rebase ${pr.label}: ${m.merge_error}`);
      return m.sha;
    }
    throw new Error(`GitLab is still rebasing ${pr.label}. Merge it once that's done.`);
  };
  return {
    kind: 'gitlab',
    name: 'GitLab',
    me: whoami,
    signIn: remote.host === 'gitlab.com' ? 'glab auth login' : `glab auth login --hostname ${remote.host}`,
    async list() {
      const [user, list] = await Promise.all([whoami().catch(() => ''), openMrs()]);
      return sortPrs(list.map((m) => gitlabPr(m, user, remote)));
    },
    // The latest merged merge requests, for /cleanup. A fork's branch names aren't this project's (`fork`).
    async merged(signal) {
      const page = (n) => read(`${project}/merge_requests?state=merged&order_by=updated_at&per_page=100&page=${n}`, { signal });
      const list = (await Promise.all([page(1), page(2)])).flat();
      return list.map((m) => ({ ...gitlabPr(m, '', remote), fork: m.source_project_id != null && m.source_project_id !== m.target_project_id }));
    },
    async pr(id, signal) {
      const [m, commits] = await Promise.all([read(mr({ id }), { signal }), readAll(mr({ id }, '/commits?per_page=100'), { signal }).catch((e) => {
        if (e.cancelled) throw e;
        return [];
      })]);
      return gitlabPrFull(m, commits, remote);
    },
    // merged_after needs GitLab 15.11 or later; the dates are checked here too, for older ones that ignore it.
    async mergedSince(since, signal) {
      const list = await readAll(`${project}/merge_requests?state=merged&merged_after=${encodeURIComponent(new Date(since).toISOString())}&per_page=100`, { signal });
      return mergedAfter(list.map((m) => mergedEntry(gitlabPr(m, '', remote), m.merged_at)), since);
    },
    headRef: (pr) => prHeadRef('gitlab', pr),
    async detail(pr) {
      const [notes, jobs] = await Promise.all([readAll(mr(pr, '/notes?sort=asc&order_by=created_at&per_page=100')).catch(() => []), checks(pr).catch(() => [])]);
      return { reviewers: pr.reviewers, checks: jobs, comments: gitlabComments(notes), conflicts: pr.conflicts };
    },
    // Diffed here, as on Azure DevOps: GitLab keeps every merge request's head (forks' too) at
    // refs/merge-requests/<iid>/head, fetched into a ref of Splice's own for as long as the diff takes.
    async diff(pr) {
      const ref = `refs/splice/merge-requests/${pr.id}`;
      await git(root, ['fetch', '--quiet', remoteName, `+refs/heads/${pr.target}:refs/remotes/${remoteName}/${pr.target}`, `+refs/merge-requests/${pr.id}/head:${ref}`]);
      try {
        return await git(root, ['diff', '-M', `${remoteName}/${pr.target}...${ref}`]);
      } finally {
        await git(root, ['update-ref', '-d', ref]).catch(() => {});
      }
    },
    async threads(pr) {
      const [discussions, now] = await Promise.all([readAll(mr(pr, '/discussions?per_page=100')), read(mr(pr)).catch(() => null)]);
      return gitlabThreads(discussions, now?.diff_refs?.head_sha ?? now?.sha ?? null);
    },
    reply: (pr, thread, text, signal) => send('POST', mr(pr, `/discussions/${thread.id}/notes`), { body: text }, signal),
    // On the merge request's diff as it is now, which the diff on screen was made from.
    async addThread(pr, at, text, signal) {
      const { diff_refs: refs } = await read(mr(pr), { signal });
      return send('POST', mr(pr, '/discussions'), gitlabNewThreadBody(refs, at, text), signal);
    },
    resolveThread: (pr, thread, resolved, signal) => send('PUT', mr(pr, `/discussions/${thread.id}`), { resolved }, signal),
    checkout: null, // done with plain git: fetch, then switch to a tracking branch
    approve: (pr, signal) => send('POST', mr(pr, '/approve'), null, signal),
    // GitLab has no "changes needed" vote on every plan, so this says it in a comment, and takes back
    // your approval if you had given one (GitLab refuses when there's none, which is fine).
    requestChangesNeedsText: true,
    async requestChanges(pr, text, signal) {
      await comment(pr, text, signal);
      await send('POST', mr(pr, '/unapprove'), null, signal).catch((e) => {
        if (e.cancelled) throw e;
      });
    },
    mergeMethods: MERGE_METHODS.gitlab,
    checks: (pr, signal) => checks(pr, signal),
    async checkLog(check, signal) {
      if (!check.jobId) throw new Error(`${check.name} isn't a GitLab CI job, so it has no log here.`);
      return gitlabTrace(await glab([`${project}/jobs/${check.jobId}/trace`], { signal })) || `${check.name} hasn't written anything to its log yet.`;
    },
    releaseDrafts: false, // GitLab has no draft releases
    releaseNotesBy: 'The notes list the commits since the tag before it.',
    // The notes given (/changelog's), or else the subjects of the commits since the tag before.
    async createRelease({ tag, title, notes }, signal) {
      let description = notes;
      if (description == null) {
        const since = (await git(root, ['describe', '--tags', '--abbrev=0', `${tag}^`]).catch(() => '')).trim();
        const log = await git(root, ['log', '--no-merges', '--format=%s', '-n', '200', since ? `${since}..${tag}` : tag]);
        description = gitlabReleaseNotes(log.split('\n'), since);
      }
      const made = JSON.parse(await send('POST', `${project}/releases`, { tag_name: tag, name: title || tag, description }, signal));
      return made?._links?.self ?? `${remote.url}/-/releases/${encodeURIComponent(tag)}`;
    },
    // GitLab asks reviewers by user id, and the list given replaces the one there: keep who is on it.
    async addReviewers(pr, names, signal) {
      const ids = [];
      for (const name of names) {
        const [user] = await read(`users?username=${encodeURIComponent(name.replace(/^@/, ''))}`, { signal });
        if (!user) throw new Error(`GitLab has no user called ${name}.`);
        ids.push(user.id);
      }
      const now = await read(mr(pr), { signal });
      return send('PUT', mr(pr), { reviewer_ids: [...new Set([...(now.reviewers ?? []).map((r) => r.id), ...ids])] }, signal);
    },
    // A draft is a title that starts "Draft:": taken from the server, in case it was renamed since.
    async setDraft(pr, draft, signal) {
      const now = await read(mr(pr), { signal });
      return send('PUT', mr(pr), { title: gitlabDraftTitle(now.title ?? pr.title, draft) }, signal);
    },
    edit: (pr, { title, body }, signal) => send('PUT', mr(pr), { ...(title != null ? { title } : {}), ...(body != null ? { description: body } : {}) }, signal),
    canRerun: true,
    async rerun(pr, failed, signal) {
      const pipelines = [...new Set(failed.filter((c) => c.state === 'fail' && c.pipelineId).map((c) => c.pipelineId))];
      if (!pipelines.length) throw new Error('None of the failed checks is a GitLab CI job, so there is nothing to retry from here.');
      for (const id of pipelines) await send('POST', `${project}/pipelines/${id}/retry`, null, signal);
      return `Retrying the failed jobs of ${pipelines.length} pipeline${pipelines.length === 1 ? '' : 's'}`;
    },
    async merge(pr, opts, signal) {
      const sha = opts.method === 'rebase' ? await rebase(pr, signal) : pr.head;
      await send('PUT', mr(pr, '/merge'), gitlabMergeBody(opts, sha), signal);
      return opts.auto ? `${pr.label} will merge once its pipeline succeeds` : `Merged ${pr.label}`;
    },
    comment,
    async create({ title, body = '', source, target, draft }, signal) {
      const made = JSON.parse(
        await send('POST', `${project}/merge_requests`, { source_branch: source, target_branch: target, title: draft ? gitlabDraftTitle(title, true) : title, description: body }, signal),
      );
      return made.web_url;
    },
    async defaultBranch() {
      return (await read(project)).default_branch;
    },
  };
}

/**
 * The PR host for a loaded repository: origin first, else the first remote Splice recognises. `config.hosts`
 * names self-managed GitLab servers whose name doesn't say so.
 */
export function hostFor(data, config = {}) {
  if (!data?.remoteUrls) return null;
  const names = Object.keys(data.remoteUrls).sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0));
  for (const name of names) {
    const remote = parseRemote(data.remoteUrls[name], config?.hosts);
    if (remote?.kind === 'github') return { ...github(data.root, remote), remoteName: name, remote };
    if (remote?.kind === 'azure') return { ...azure(data.root, remote, name), remoteName: name, remote };
    if (remote?.kind === 'gitlab') return { ...gitlab(data.root, remote, name), remoteName: name, remote };
  }
  return null;
}

/** Opens a URL in the default browser. */
export function openUrl(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, { windowsHide: true }, () => {});
}
