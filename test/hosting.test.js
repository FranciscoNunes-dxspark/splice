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
  assert.equal(parseRemote('https://gitlab.com/a/b.git'), null);
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
