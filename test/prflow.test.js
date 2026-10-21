// The pull request flows' pure parts (prflow.js), and what the hosts give them: one PR by its number in
// Splice's shape, where its head is, and the PRs merged since a date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { changelogPrompt } from '../src/claude.js';
import { reviewBranchId } from '../src/cleanup.js';
import { azurePrFull, githubPrFull, githubReleaseArgs, gitlabPrFull, mergedAfter, prHeadRef, prIdFromUrl, releaseArgs } from '../src/hosting.js';
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
} from '../src/prflow.js';

test('pull request numbers as typed, and /ship, /backport and /changelog arguments', () => {
  assert.equal(prNumber('12'), 12);
  assert.equal(prNumber(' #12 '), 12);
  assert.equal(prNumber('!7'), 7);
  assert.equal(prNumber('feature'), null);
  assert.equal(prNumber(''), null);
  assert.deepEqual(shipArgs(''), { target: null });
  assert.deepEqual(shipArgs('--into release/2'), { target: 'release/2' });
  assert.match(shipArgs('--squash').error, /Unknown option/);
  assert.deepEqual(backportArgs(''), {});
  assert.deepEqual(backportArgs('#5 release/1.2'), { id: 5, branch: 'release/1.2' });
  assert.deepEqual(backportArgs('5 refs/heads/stable'), { id: 5, branch: 'stable' });
  assert.match(backportArgs('5').error, /\/backport <pr-number> <branch>/);
  assert.match(backportArgs('five stable').error, /\/backport/);
  assert.deepEqual(changelogArgs(''), { since: null, release: null });
  assert.deepEqual(changelogArgs('v1.0'), { since: 'v1.0', release: null });
  assert.deepEqual(changelogArgs('v1.0 --into-release v1.1'), { since: 'v1.0', release: 'v1.1' });
  assert.deepEqual(changelogArgs('--into-release v1.1'), { since: null, release: 'v1.1' });
  assert.match(changelogArgs('--into-release').error, /Say which release/);
  assert.match(changelogArgs('v1 v2').error, /One tag/);
});

test('shipped branches in the config: per repository, one entry a branch, dropped as asked', () => {
  const repo = join('/r', '.git');
  let config = { recent: [] };
  config = withShipped(config, { repo, branch: 'a', id: 1 });
  config = withShipped(config, { repo, branch: 'b', id: 2 });
  config = withShipped(config, { repo: join('/other', '.git'), branch: 'a', id: 3 });
  config = withShipped(config, { repo, branch: 'a', id: 4 });
  assert.deepEqual(shippedIn(config, repo).map((e) => [e.branch, e.id]), [['b', 2], ['a', 4]]);
  assert.equal(shippedEntry(config, repo, 'a').id, 4);
  assert.equal(shippedEntry(config, repo, 'c'), null);
  assert.deepEqual(shippedIn(config, null), []);
  const without = withoutShipped(config, repo, (e) => e.branch === 'a');
  assert.deepEqual(without.shipped.map((e) => e.id), [2, 3]);
  assert.equal(withoutShipped(config, repo, () => false), config, 'unchanged when nothing goes');
});

test("/ship's plan: what's pushed, whether a PR is opened or reused, and auto-merge", () => {
  const steps = shipSteps({ branch: 'feat', target: 'main', remote: 'origin', hostName: 'GitHub', push: { first: true }, open: null, claude: true, method: 'squash' });
  assert.match(steps[0], /^1\. Push `feat` to origin, setting its upstream/);
  assert.match(steps[1], /^2\. Open a pull request from `feat` into `main` on GitHub, with the title and description Claude drafts/);
  assert.match(steps[2], /^3\. Turn on auto-merge \(Squash and merge\)/);
  assert.match(steps.join('\n'), /offers to finish: switch to `main`, pull it, and delete `feat`/);
  const again = shipSteps({ branch: 'feat', target: 'main', remote: 'origin', hostName: 'GitLab', push: null, open: { label: '!4', title: 'Feat' }, claude: false, method: 'merge' });
  assert.match(again[0], /Nothing to push/);
  assert.match(again[1], /Use !4 "Feat", already open on GitLab/);
  assert.match(shipSteps({ branch: 'f', target: 'm', remote: 'o', hostName: 'H', push: { count: 2 }, open: null, claude: false, method: 'merge' })[0], /Push 2 new commits/);
  assert.match(shipSteps({ branch: 'f', target: 'm', remote: 'o', hostName: 'H', push: { count: 1 }, open: null, claude: false, method: 'merge' })[1], /titled after the latest commit/);
  assert.deepEqual(commitsDraft([{ subject: 'One' }, { subject: 'Two' }]), { title: 'Two', body: '- One\n- Two' });
  assert.deepEqual(commitsDraft([{ subject: 'One' }]), { title: 'One', body: '' });
  assert.deepEqual(commitsDraft([]), { title: '', body: '' });
  assert.deepEqual(parseCommitLines('a1\x1fFirst\nb2\x1fSecond\n'), [{ hash: 'a1', subject: 'First' }, { hash: 'b2', subject: 'Second' }]);
});

test("/review-pr's worktree beside the repository, and the branch /cleanup knows it by", () => {
  assert.equal(reviewPath(join('/work', 'keel'), 12), join('/work', 'keel-pr-12'));
  assert.equal(reviewBranch(12), 'pr-12');
  assert.equal(reviewBranchId('pr-12'), 12);
  assert.equal(reviewBranchId('pr-12x'), null);
  assert.equal(reviewBranchId('feature'), null);
  assert.equal(prHeadRef('github', { id: 3, source: 'x' }), 'refs/pull/3/head');
  assert.equal(prHeadRef('gitlab', { id: 3, source: 'x' }), 'refs/merge-requests/3/head');
  assert.equal(prHeadRef('azure', { id: 3, source: 'feature/x' }), 'refs/heads/feature/x');
});

test("a backport's commits: a merge commit as what it brought in, a squash as itself, a rebase merge commit by commit", () => {
  const commits = [{ hash: 'c1', subject: 'One' }, { hash: 'c2', subject: 'Two' }];
  assert.deepEqual(backportPicks({ mergeCommit: 'm', parents: ['p1', 'p2'], commits }), { how: 'merge', picks: ['m'], mainline: true });
  assert.deepEqual(backportPicks({ mergeCommit: 's', parents: ['p1'], commits, landed: [{ hash: 'x', subject: 'Other' }, { hash: 's', subject: 'Feature (#5)' }] }), {
    how: 'squash',
    picks: ['s'],
    mainline: false,
  });
  assert.deepEqual(backportPicks({ mergeCommit: 'r2', parents: ['r1'], commits, landed: [{ hash: 'r1', subject: 'One' }, { hash: 'r2', subject: 'Two' }] }), {
    how: 'rebase',
    picks: ['r1', 'r2'],
    mainline: false,
  });
  assert.deepEqual(backportPicks({ mergeCommit: 'x', parents: ['p'], commits: [commits[0]] }), { how: 'squash', picks: ['x'], mainline: false }, 'one commit is the same either way');
  assert.equal(backportBranch(5, 'release/1.2'), 'backport/5-to-release/1.2');
  assert.equal(backportTitle('release/1.2', 'Add search'), '[release/1.2] Add search');
  const pr = { label: '#5', title: 'Add search', url: 'https://example.invalid/pull/5', target: 'main' };
  assert.match(backportBody(pr, 'release/1.2'), /^Backport of #5 \(https:\/\/example\.invalid\/pull\/5\) to `release\/1\.2`/);
  const steps = backportSteps({ pr, branch: 'release/1.2', name: 'backport/5-to-release/1.2', remote: 'origin', how: 'merge', picks: [{ hash: 'abcdef123', subject: 'Merge #5' }], hostName: 'GitHub' }).join('\n');
  assert.match(steps, /1\. Make `backport\/5-to-release\/1\.2` from `origin\/release\/1\.2`/);
  assert.match(steps, /its merge commit, as what it brought in \(-m 1\)/);
  assert.match(steps, /- `abcdef1` Merge #5/);
  assert.match(steps, /"\[release\/1\.2\] Add search"/);
});

test("release notes: what Claude is asked, and the commits and pull requests it's given", () => {
  const log = 'a1\x1fAdd search\x1fIt finds things.\n\x1e\nb2\x1fFix the crash\x1f\x1e\n';
  assert.equal(changelogCount(log), 2);
  assert.equal(changelogCount(''), 0);
  const input = changelogInput({ since: 'v1.0', until: 'main', log, prs: [{ label: '#4', title: 'Search', author: 'ana' }] });
  assert.match(input, /^Commits from v1\.0 to main, newest first \(2\):\n- a1 Add search\n {4}It finds things\.\n- b2 Fix the crash/);
  assert.match(input, /Pull requests merged since then \(1\):\n- #4 Search \(ana\)/);
  assert.doesNotMatch(changelogInput({ since: null, until: 'HEAD', log, prs: null }), /Pull requests/);
  const prompt = changelogPrompt('v1.0', 'v1.1');
  assert.match(prompt, /since v1\.0 up to v1\.1/);
  assert.match(prompt, /## Features.*## Fixes.*## Other/s);
  assert.match(changelogPrompt(null, 'HEAD'), /from the start/);
});

test('/release --notes-file, and gh release create with notes on stdin', () => {
  assert.deepEqual(releaseArgs('v1.2 --notes-file notes.md The big one'), { tag: 'v1.2', title: 'The big one', draft: false, notesFile: 'notes.md' });
  assert.deepEqual(releaseArgs('v1.2 --notes-file "C:\\My Notes\\n.md" --draft'), { tag: 'v1.2', title: '', draft: true, notesFile: 'C:\\My Notes\\n.md' });
  assert.deepEqual(githubReleaseArgs('o/r', { tag: 'v1', title: '', draft: false, notes: '## Fixes' }), ['release', 'create', 'v1', '-R', 'o/r', '--verify-tag', '--notes-file', '-']);
});

test('one pull request by its number, from each host, in one shape: state, merge commit, its commits', () => {
  const gh = githubPrFull({
    number: 5,
    title: 'Add search',
    author: { login: 'ana' },
    headRefName: 'search',
    baseRefName: 'main',
    headRefOid: 'h5',
    url: 'https://github.com/o/r/pull/5',
    updatedAt: '2026-10-01T10:00:00Z',
    state: 'MERGED',
    mergeCommit: { oid: 'm5' },
    mergedAt: '2026-10-02T10:00:00Z',
    isCrossRepository: true,
    commits: [{ oid: 'c1', messageHeadline: 'One' }, { oid: 'c2', messageHeadline: 'Two' }],
  });
  assert.deepEqual([gh.id, gh.label, gh.source, gh.target, gh.head, gh.state, gh.mergeCommit, gh.fork], [5, '#5', 'search', 'main', 'h5', 'merged', 'm5', true]);
  assert.deepEqual(gh.commits, [{ hash: 'c1', subject: 'One' }, { hash: 'c2', subject: 'Two' }]);
  assert.equal(githubPrFull({ number: 6, title: 't', state: 'OPEN', mergeCommit: null }).state, 'open');

  const remote = { orgUrl: 'https://dev.azure.com/org', project: 'P', repo: 'R' };
  const az = azurePrFull(
    { pullRequestId: 9, title: 'Fix', status: 'completed', sourceRefName: 'refs/heads/fix', targetRefName: 'refs/heads/main', lastMergeCommit: { commitId: 'm9' }, lastMergeSourceCommit: { commitId: 'h9' }, closedDate: '2026-10-03T00:00:00Z', createdBy: {} },
    [{ commitId: 'n2', comment: 'Second\n\nbody' }, { commitId: 'n1', comment: 'First' }],
    remote,
  );
  assert.deepEqual([az.label, az.source, az.state, az.mergeCommit, az.head, az.fork], ['!9', 'fix', 'merged', 'm9', 'h9', false]);
  assert.deepEqual(az.commits, [{ hash: 'n1', subject: 'First' }, { hash: 'n2', subject: 'Second' }]);
  assert.equal(azurePrFull({ pullRequestId: 1, status: 'abandoned', lastMergeCommit: { commitId: 'x' }, createdBy: {} }, [], remote).mergeCommit, null);

  const glRemote = { url: 'https://gitlab.com/g/a' };
  const mr = (over) => ({ iid: 3, title: 'MR', state: 'merged', source_branch: 'f', target_branch: 'main', sha: 'h3', author: {}, source_project_id: 1, target_project_id: 1, ...over });
  assert.equal(gitlabPrFull(mr({ merge_commit_sha: 'm3', squash_commit_sha: 's3' }), [], glRemote).mergeCommit, 'm3', 'the merge commit, when there is one');
  assert.equal(gitlabPrFull(mr({ merge_commit_sha: null, squash_commit_sha: 's3' }), [], glRemote).mergeCommit, 's3', 'else the squashed one');
  assert.equal(gitlabPrFull(mr({ merge_commit_sha: null }), [], glRemote).mergeCommit, 'h3', 'a fast-forward leaves the head itself');
  assert.equal(gitlabPrFull(mr({ state: 'opened' }), [], glRemote).state, 'open');
  assert.equal(gitlabPrFull(mr({ source_project_id: 2 }), [], glRemote).fork, true);
  assert.deepEqual(gitlabPrFull(mr({}), [{ id: 'g2', title: 'Two' }, { id: 'g1', title: 'One' }], glRemote).commits.map((c) => c.hash), ['g1', 'g2']);

  assert.equal(prIdFromUrl('https://github.com/o/r/pull/12\n'), 12);
  assert.equal(prIdFromUrl('https://gitlab.com/g/a/-/merge_requests/7'), 7);
  assert.equal(prIdFromUrl('https://dev.azure.com/org/P/_git/R/pullrequest/31'), 31);
  assert.equal(prIdFromUrl('Created'), null);
  const list = [{ id: 1, mergedAt: '2026-01-01T00:00:00Z' }, { id: 2, mergedAt: '2026-03-01T00:00:00Z' }, { id: 3, mergedAt: null }, { id: 4, mergedAt: '2026-02-01T00:00:00Z' }];
  assert.deepEqual(mergedAfter(list, '2026-02-01T00:00:00Z').map((p) => p.id), [2, 4]);
});
