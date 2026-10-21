import { test } from 'node:test';
import assert from 'node:assert/strict';
import { azurePr, azureReview, checkSummary, githubPr, parseRemote, sortPrs } from '../src/hosting.js';
import { parseRemotes } from '../src/repo.js';
import { wrap } from '../src/text.js';

test('remote URLs: GitHub and Azure DevOps, https and ssh', () => {
  assert.deepEqual(parseRemote('https://github.com/FranciscoNunes-dxspark/keel.git'), { kind: 'github', owner: 'FranciscoNunes-dxspark', repo: 'keel' });
  assert.deepEqual(parseRemote('git@github.com:owner/repo.git'), { kind: 'github', owner: 'owner', repo: 'repo' });
  assert.deepEqual(parseRemote('https://fabrikam@dev.azure.com/fabrikam/Fabrikam%20-%20WebChat/_git/WebChat'), {
    kind: 'azure',
    org: 'fabrikam',
    orgUrl: 'https://dev.azure.com/fabrikam',
    project: 'Fabrikam - WebChat',
    repo: 'WebChat',
  });
  assert.deepEqual(
    parseRemote('https://contoso.visualstudio.com/DefaultCollection/Contoso%20-%20MVC%20-%20Store/_git/Contoso%20-%20WEB%20-%20Store'),
    { kind: 'azure', org: 'contoso', orgUrl: 'https://contoso.visualstudio.com', project: 'Contoso - MVC - Store', repo: 'Contoso - WEB - Store' },
  );
  assert.equal(parseRemote('git@ssh.dev.azure.com:v3/org/Proj/Repo').repo, 'Repo');
  assert.equal(parseRemote('org@vs-ssh.visualstudio.com:v3/org/Proj/Repo').orgUrl, 'https://org.visualstudio.com');
  assert.equal(parseRemote('https://bitbucket.org/a/b.git'), null);
});

test('git remote -v keeps one URL per remote', () => {
  const { remotes, remoteUrls } = parseRemotes('origin\thttps://x/a.git (fetch)\norigin\thttps://x/a.git (push)\nfork\tgit@y:b.git (fetch)\n');
  assert.deepEqual(remotes, ['origin', 'fork']);
  assert.equal(remoteUrls.fork, 'git@y:b.git');
});

test('Azure DevOps: votes, required reviewers, and your own PR is not a review request', () => {
  const remote = { orgUrl: 'https://dev.azure.com/o', project: 'P 1', repo: 'R' };
  const raw = (reviewers, by = 'ana@x.com') => ({
    pullRequestId: 7,
    title: 'T',
    createdBy: { displayName: 'Ana', uniqueName: by },
    sourceRefName: 'refs/heads/feature/a',
    targetRefName: 'refs/heads/Develop',
    creationDate: '2026-10-01T00:00:00Z',
    reviewers,
  });
  const pr = azurePr(raw([{ displayName: 'Me', uniqueName: 'ME@x.com', vote: 0 }]), 'me@x.com', remote);
  assert.equal(pr.reviewMe, true);
  assert.equal(pr.source, 'feature/a');
  assert.equal(pr.url, 'https://dev.azure.com/o/P%201/_git/R/pullrequest/7');
  const own = azurePr(raw([{ displayName: 'Me', uniqueName: 'me@x.com', vote: 0 }], 'me@x.com'), 'me@x.com', remote);
  assert.equal(own.mine, true);
  assert.equal(own.reviewMe, false);

  const r = (vote, required = false) => ({ vote, required, group: false });
  assert.equal(azureReview([r('approved'), r('rejected')]).text, 'Rejected');
  assert.equal(azureReview([r('waiting')]).text, 'Waiting for author');
  assert.equal(azureReview([r('approved', true), r('suggestions', true)]).text, 'Approved');
  assert.equal(azureReview([r('approved'), r('none', true)]).text, '1 approved');
  assert.equal(azureReview([]).text, 'No votes yet');
});

test('GitHub: review decision, checks, and sorting', () => {
  const base = { number: 1, title: 'A', author: { login: 'bo' }, headRefName: 'x', baseRefName: 'main', updatedAt: '2026-10-01T00:00:00Z' };
  const asked = githubPr({ ...base, reviewRequests: [{ login: 'Me' }], reviewDecision: 'REVIEW_REQUIRED' }, 'me');
  assert.equal(asked.reviewMe, true);
  assert.equal(asked.review.text, 'Review required');
  const mine = githubPr({ ...base, number: 2, author: { login: 'me' }, updatedAt: '2026-10-05T00:00:00Z' }, 'me');
  const other = githubPr({ ...base, number: 3, updatedAt: '2026-10-09T00:00:00Z' }, 'me');
  assert.deepEqual(sortPrs([other, mine, asked]).map((p) => p.id), [1, 2, 3]);
  assert.deepEqual(checkSummary([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }, { state: 'SUCCESS' }]), { passed: 2, failed: 1, pending: 1 });
});

test('wrap keeps paragraphs apart', () => {
  assert.deepEqual(wrap('one two three\r\n\r\nfour', 8), ['one two', 'three', '', 'four']);
});

test('merging a pull request: the arguments for /merge-pr, gh and az', async () => {
  const { mergePrArgs, githubMergeArgs, azureMergeArgs } = await import('../src/hosting.js');
  assert.deepEqual(mergePrArgs(''), { method: null, deleteBranch: null, auto: null });
  assert.deepEqual(mergePrArgs('squash -d --auto'), { method: 'squash', deleteBranch: true, auto: true });
  assert.deepEqual(mergePrArgs('--rebase --keep-branch'), { method: 'rebase', deleteBranch: false, auto: null });
  assert.match(mergePrArgs('octopus').error, /Unknown option: octopus/);
  const pr = { id: 12 };
  assert.deepEqual(githubMergeArgs(pr, 'o/r', { method: 'squash', deleteBranch: true, auto: false }), ['pr', 'merge', '12', '-R', 'o/r', '--squash', '--delete-branch']);
  assert.deepEqual(githubMergeArgs(pr, 'o/r', { method: 'merge', deleteBranch: false, auto: true }), ['pr', 'merge', '12', '-R', 'o/r', '--merge', '--auto']);
  assert.deepEqual(azureMergeArgs(pr, { method: 'squash', deleteBranch: true, auto: false }), [
    'repos', 'pr', 'update', '--id', '12', '--status', 'completed', '--squash', 'true', '--delete-source-branch', 'true',
  ]);
  assert.deepEqual(azureMergeArgs(pr, { method: 'merge', deleteBranch: false, auto: true }), [
    'repos', 'pr', 'update', '--id', '12', '--auto-complete', 'true', '--squash', 'false', '--delete-source-branch', 'false',
  ]);
});

test("checks: GitHub's rollup with Actions run and job ids, Azure DevOps policies, a build's failed logs", async () => {
  const { githubChecks, azureChecks, failedLogs } = await import('../src/hosting.js');
  assert.deepEqual(
    githubChecks([
      { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/111/job/222' },
      { __typename: 'StatusContext', context: 'ci/ext', state: 'PENDING', targetUrl: 'https://ci.example/9' },
    ]),
    [
      { name: 'test', workflow: 'CI', state: 'fail', url: 'https://github.com/o/r/actions/runs/111/job/222', runId: '111', jobId: '222' },
      { name: 'ci/ext', workflow: '', state: 'pending', url: 'https://ci.example/9', runId: null, jobId: null },
    ],
  );
  const remote = { orgUrl: 'https://dev.azure.com/o', project: 'P 1', repo: 'R' };
  assert.deepEqual(
    azureChecks(
      [
        { status: 'rejected', evaluationId: 'e1', context: { buildId: 55 }, configuration: { settings: { displayName: 'PR build' } } },
        { status: 'approved', evaluationId: 'e2', configuration: { type: { displayName: 'Minimum reviewers' } } },
        { status: 'notApplicable', evaluationId: 'e3' },
      ],
      remote,
    ),
    [
      { name: 'PR build', workflow: 'Build', state: 'fail', url: 'https://dev.azure.com/o/P%201/_build/results?buildId=55', evaluationId: 'e1', buildId: 55 },
      { name: 'Minimum reviewers', workflow: '', state: 'pass', url: null, evaluationId: 'e2', buildId: null },
    ],
  );
  assert.deepEqual(
    failedLogs({ records: [{ name: 'b', result: 'failed', order: 2, log: { id: 9 } }, { name: 'a', result: 'failed', order: 1, log: { id: 4 } }, { name: 'ok', result: 'succeeded', log: { id: 1 } }, { name: 'job', result: 'failed' }] }),
    [{ id: 4, name: 'a' }, { id: 9, name: 'b' }],
  );
});

test('/body: a file, text with \\n for line breaks, or nothing', async () => {
  const { bodyArgs } = await import('../src/hosting.js');
  assert.deepEqual(bodyArgs(''), {});
  assert.deepEqual(bodyArgs('--file'), { file: null });
  assert.deepEqual(bodyArgs('--file "C:\\My Docs\\pr.md"'), { file: 'C:\\My Docs\\pr.md' });
  assert.deepEqual(bodyArgs('--file /tmp/a b.md'), { file: '/tmp/a b.md' });
  assert.deepEqual(bodyArgs('Fixes it.\\nAlso tests.'), { text: 'Fixes it.\nAlso tests.' });
});

test('/release: the tag, --draft and a title; and the gh release arguments', async () => {
  const { releaseArgs, githubReleaseArgs } = await import('../src/hosting.js');
  assert.deepEqual(releaseArgs('v1.2 --draft The big one'), { tag: 'v1.2', title: 'The big one', draft: true });
  assert.deepEqual(releaseArgs('v1.2'), { tag: 'v1.2', title: '', draft: false });
  assert.deepEqual(releaseArgs(''), { tag: null, title: '', draft: false });
  assert.deepEqual(githubReleaseArgs('o/r', { tag: 'v1', title: 'One', draft: true }), ['release', 'create', 'v1', '-R', 'o/r', '--verify-tag', '--generate-notes', '--title', 'One', '--draft']);
  assert.deepEqual(githubReleaseArgs('o/r', { tag: 'v1', title: '', draft: false }), ['release', 'create', 'v1', '-R', 'o/r', '--verify-tag', '--generate-notes']);
});
