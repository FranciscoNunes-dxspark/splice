// GitLab as a pull request host: parsing its remotes, its REST and GraphQL JSON into Splice's shapes, and
// the host itself against a stand-in for glab on the PATH, which records what it was asked and answers
// with JSON shaped like GitLab's. Nothing goes online, and the real glab is never run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { removeTemp } from './temp.js';
import {
  gitlabChecks,
  gitlabComments,
  gitlabDraftTitle,
  gitlabMergeBody,
  gitlabNewThreadBody,
  gitlabPr,
  gitlabReleaseNotes,
  gitlabReview,
  gitlabState,
  gitlabThreads,
  gitlabTrace,
  hostFor,
  jsonPages,
  parseRemote,
  remoteParts,
} from '../src/hosting.js';
import { prNews } from '../src/notify.js';

const REMOTE = { kind: 'gitlab', host: 'gitlab.com', path: 'grp/sub/app', url: 'https://gitlab.com/grp/sub/app' };

test('GitLab remotes: gitlab.com, self-managed by name or by the config, https, ssh and nested groups', () => {
  assert.deepEqual(parseRemote('https://gitlab.com/grp/sub/app.git'), REMOTE);
  assert.deepEqual(parseRemote('git@gitlab.com:grp/sub/app.git'), REMOTE);
  assert.deepEqual(parseRemote('ssh://git@gitlab.example.com:2222/team/app.git'), {
    kind: 'gitlab',
    host: 'gitlab.example.com',
    path: 'team/app',
    url: 'https://gitlab.example.com/team/app',
  });
  assert.equal(parseRemote('https://me@GitLab.Corp.example/team/app').host, 'gitlab.corp.example');
  assert.equal(parseRemote('https://git.example.com/team/app.git'), null, 'nothing says it is GitLab');
  assert.equal(parseRemote('https://git.example.com/team/app.git', { 'git.example.com': 'gitlab' }).path, 'team/app');
  assert.equal(parseRemote('git@git.example.com:team/app.git', { 'Git.Example.com': 'GitLab' }).kind, 'gitlab');
  assert.equal(parseRemote('https://gitlab.example.com/a/b.git', { 'gitlab.example.com': 'none' }), null, 'the config can say it is not');
  assert.equal(parseRemote('https://gitlab.com/just-a-group'), null, 'a project is in a group');
  assert.equal(parseRemote('https://bitbucket.org/team/app.git'), null);
  assert.equal(parseRemote('git@github.com:o/r.git').kind, 'github', 'GitHub still first');
  assert.equal(remoteParts('C:\\repos\\gitlab\\app'), null, 'a Windows path');
  assert.equal(remoteParts('/home/me/gitlab/app'), null, 'a local path');
  assert.equal(remoteParts('file:///srv/gitlab/app.git'), null);
});

test('hostFor picks GitLab, with every operation the GitHub host has', () => {
  const data = { root: '/r', remoteUrls: { origin: 'git@gitlab.com:grp/sub/app.git' } };
  const host = hostFor(data);
  assert.equal(host.kind, 'gitlab');
  assert.equal(host.name, 'GitLab');
  assert.equal(host.signIn, 'glab auth login');
  assert.equal(host.remoteName, 'origin');
  const github = hostFor({ root: '/r', remoteUrls: { origin: 'git@github.com:o/r.git' } });
  const missing = Object.keys(github).filter((k) => typeof github[k] === 'function' && typeof host[k] !== 'function');
  assert.deepEqual(missing, ['checkout'], 'only checkout, which is done with plain git as on Azure DevOps');
  assert.equal(host.checkout, null);
  assert.equal(hostFor({ root: '/r', remoteUrls: { origin: 'https://code.corp/a/b.git' } }), null);
  const named = hostFor({ root: '/r', remoteUrls: { origin: 'https://code.corp/a/b.git' } }, { hosts: { 'code.corp': 'gitlab' } });
  assert.equal(named.kind, 'gitlab');
  assert.equal(named.signIn, 'glab auth login --hostname code.corp');
});

// A merge request from the GraphQL list (gitlabMrsQuery's aliases make it look like REST's).
const GQL_MR = {
  iid: '12',
  title: 'Draft: Faster search',
  description: 'Makes it **fast**.',
  draft: true,
  approved: false,
  web_url: 'https://gitlab.com/grp/sub/app/-/merge_requests/12',
  updated_at: '2026-10-01T10:00:00Z',
  source_branch: 'feature/search',
  target_branch: 'main',
  sha: 'abc123',
  has_conflicts: true,
  detailed_merge_status: 'NOT_APPROVED',
  author: { username: 'ana', name: 'Ana Lima' },
  approved_by: { nodes: [{ username: 'bo', name: 'Bo' }] },
  reviewers: {
    nodes: [
      { username: 'bo', name: 'Bo', mergeRequestInteraction: { review_state: 'APPROVED' } },
      { username: 'me', name: 'Me Myself', mergeRequestInteraction: { review_state: 'UNREVIEWED' } },
      { username: 'cy', name: 'Cy', mergeRequestInteraction: { review_state: 'REVIEWED' } },
    ],
  },
  head_pipeline: { status: 'RUNNING' },
};

// The same from REST v4's merge_requests list, which has no approvals or pipeline.
const REST_MR = {
  id: 9001,
  iid: 13,
  project_id: 5,
  title: 'Fix the login',
  description: null,
  state: 'opened',
  draft: false,
  work_in_progress: false,
  web_url: 'https://gitlab.com/grp/sub/app/-/merge_requests/13',
  updated_at: '2026-10-02T10:00:00.000Z',
  source_branch: 'fix/login',
  target_branch: 'main',
  source_project_id: 5,
  target_project_id: 5,
  sha: 'def456',
  has_conflicts: false,
  detailed_merge_status: 'not_approved',
  author: { id: 1, username: 'me', name: 'Me Myself' },
  reviewers: [{ id: 2, username: 'bo', name: 'Bo' }],
};

test('GitLab merge requests in Splice shape: !12, draft, approvals, reviewer states, pipeline, conflicts', () => {
  const pr = gitlabPr(GQL_MR, 'me', REMOTE);
  assert.equal(pr.id, 12);
  assert.equal(pr.label, '!12');
  assert.equal(pr.author, 'Ana Lima');
  assert.equal(pr.mine, false);
  assert.equal(pr.reviewMe, true, 'asked to review and not reviewed yet');
  assert.equal(pr.source, 'feature/search');
  assert.equal(pr.head, 'abc123');
  assert.equal(pr.draft, true);
  assert.equal(pr.conflicts, true);
  assert.deepEqual(pr.review, { text: '1 approved', tone: 'wait' });
  assert.deepEqual(pr.checks, { passed: 0, failed: 0, pending: 1 });
  assert.deepEqual(pr.reviewers.map((r) => [r.name, r.vote]), [['Bo', 'approved'], ['Me Myself', 'none'], ['Cy', 'commented']]);
  assert.deepEqual(pr.reviews, [{ by: 'Bo', state: 'approved', at: '' }, { by: 'Cy', state: 'COMMENTED', at: '' }]);

  const rest = gitlabPr(REST_MR, 'me', REMOTE);
  assert.equal(rest.id, 13);
  assert.equal(rest.mine, true);
  assert.equal(rest.reviewMe, false);
  assert.equal(rest.checks, null, 'no pipeline in the REST list');
  assert.equal(rest.description, '');
  assert.deepEqual(rest.review, { text: 'Approval required', tone: 'wait' });
  assert.equal(gitlabPr({ ...REST_MR, web_url: undefined }, '', REMOTE).url, 'https://gitlab.com/grp/sub/app/-/merge_requests/13');
});

test('GitLab review state: changes requested, approved, approvals still needed, none', () => {
  const r = (state) => ({ username: 'x', mergeRequestInteraction: { review_state: state } });
  assert.equal(gitlabReview({ reviewers: { nodes: [r('REQUESTED_CHANGES')] }, approved_by: { nodes: [{ username: 'y' }] } }).text, 'Changes requested');
  assert.equal(gitlabReview({ approved: true, approved_by: { nodes: [{ username: 'y' }] } }).text, 'Approved');
  assert.equal(gitlabReview({ approved_by: [{ user: { username: 'y' } }] }).text, 'Approved', "REST approvals' shape");
  assert.equal(gitlabReview({ approved: false, approved_by: { nodes: [] } }).text, 'Approval required');
  assert.equal(gitlabReview({ approved: true, approved_by: { nodes: [] } }).text, 'No reviews', 'nothing required, nobody approved');
  assert.equal(gitlabReview({ detailed_merge_status: 'mergeable' }).text, 'No reviews');
});

test('GitLab pipelines tell notify.js when your merge request has finished its checks', () => {
  const mine = { ...GQL_MR, author: { username: 'me', name: 'Me' } };
  const was = [gitlabPr(mine, 'me', REMOTE)];
  const now = [gitlabPr({ ...mine, head_pipeline: { status: 'FAILED' }, reviewers: { nodes: [{ username: 'zé', name: 'Zé', mergeRequestInteraction: { review_state: 'REQUESTED_CHANGES' } }] } }, 'me', REMOTE)];
  assert.deepEqual(prNews(was, now), [
    { title: '!12 Draft: Faster search', body: '1 of 1 checks failed' },
    { title: '!12 Draft: Faster search', body: 'Zé asked for changes' },
  ]);
});

test('GitLab states, comments, checks, job logs, draft titles, merge bodies, release notes, paginated JSON', () => {
  assert.deepEqual(['success', 'SKIPPED', 'failed', 'canceled', 'running', 'manual', 'created', undefined].map(gitlabState), ['pass', 'pass', 'fail', 'fail', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(
    gitlabComments([
      { id: 3, body: 'Later', author: { username: 'bo', name: 'Bo' }, created_at: '2026-10-02T00:00:00Z', system: false, type: null },
      { id: 1, body: 'added 2 commits', author: { username: 'ana' }, created_at: '2026-10-01T00:00:00Z', system: true },
      { id: 2, body: 'On a line', author: { username: 'bo' }, created_at: '2026-10-01T00:00:00Z', system: false, type: 'DiffNote' },
      { id: 4, body: 'First', author: { username: 'ana' }, created_at: '2026-10-01T00:00:00Z', system: false, type: 'DiscussionNote' },
    ]).map((c) => [c.author, c.text]),
    [['ana', 'First'], ['Bo', 'Later']],
  );
  assert.deepEqual(
    gitlabChecks(
      [
        { id: 71, name: 'lint', stage: 'test', status: 'failed', allow_failure: true, web_url: 'https://gitlab.com/j/71', pipeline: { id: 7 } },
        { id: 72, name: 'unit', stage: 'test', status: 'failed', allow_failure: false, web_url: 'https://gitlab.com/j/72', pipeline: { id: 7 } },
        { id: 73, name: 'deploy', stage: 'deploy', status: 'manual', allow_failure: true },
      ],
      7,
    ),
    [
      { name: 'lint (allowed to fail)', workflow: 'test', state: 'pass', url: 'https://gitlab.com/j/71', jobId: 71, pipelineId: 7 },
      { name: 'unit', workflow: 'test', state: 'fail', url: 'https://gitlab.com/j/72', jobId: 72, pipelineId: 7 },
      { name: 'deploy', workflow: 'deploy', state: 'pending', url: null, jobId: 73, pipelineId: 7 },
    ],
  );
  const trace = 'section_start:1700000000:step_script\r\x1b[0K\x1b[0;m\x1b[32;1m$ npm test\x1b[0;m\r\nDownloading 10%\rDownloading 100%\r\nnot ok 1\r\nsection_end:1700000001:step_script\r\x1b[0K\r\n';
  assert.equal(gitlabTrace(trace), '$ npm test\nDownloading 100%\nnot ok 1');
  assert.equal(gitlabDraftTitle('Faster search', true), 'Draft: Faster search');
  assert.equal(gitlabDraftTitle('Draft: Faster search', true), 'Draft: Faster search');
  assert.equal(gitlabDraftTitle('[Draft] Faster search', false), 'Faster search');
  assert.equal(gitlabDraftTitle('(draft) Faster search', false), 'Faster search');
  assert.equal(gitlabDraftTitle('Drafting rules', false), 'Drafting rules');
  assert.deepEqual(gitlabMergeBody({ method: 'squash', deleteBranch: true, auto: false }, 'abc'), { squash: true, should_remove_source_branch: true, sha: 'abc' });
  assert.deepEqual(gitlabMergeBody({ method: 'merge', deleteBranch: false, auto: true }, null), { squash: false, should_remove_source_branch: false, merge_when_pipeline_succeeds: true, auto_merge: true });
  assert.equal(gitlabReleaseNotes(['Faster search', 'Fix login', ''], 'v1.0'), 'Changes since v1.0:\n\n- Faster search\n- Fix login');
  assert.equal(gitlabReleaseNotes([''], ''), '');
  assert.deepEqual(jsonPages('[{"a":1},{"a":2}][{"a":"]["}]\n'), [{ a: 1 }, { a: 2 }, { a: '][' }]);
  assert.deepEqual(jsonPages('{"id":1}'), [{ id: 1 }]);
  assert.deepEqual(jsonPages(''), []);
});

// Merge request discussions as REST v4 gives them.
const DISCUSSIONS = [
  {
    id: 'd1',
    individual_note: false,
    notes: [
      {
        id: 101, type: 'DiffNote', body: 'Why 3?', author: { username: 'bo', name: 'Bo' }, created_at: '2026-10-01T00:00:00Z', system: false, resolvable: true, resolved: true,
        position: { base_sha: 'b', start_sha: 's', head_sha: 'h2', position_type: 'text', old_path: 'src/app.js', new_path: 'src/app.js', old_line: null, new_line: 11 },
      },
      { id: 102, type: 'DiffNote', body: 'Because.', author: { username: 'ana', name: 'Ana' }, created_at: '2026-10-01T01:00:00Z', system: false, resolvable: true, resolved: true },
    ],
  },
  {
    id: 'd2',
    notes: [
      {
        id: 201, type: 'DiffNote', body: 'Gone?', author: { username: 'bo' }, created_at: '2026-10-01T00:00:00Z', system: false, resolvable: true, resolved: false,
        position: { head_sha: 'h2', position_type: 'text', old_path: 'old.js', new_path: 'new.js', old_line: 4, new_line: null },
      },
    ],
  },
  { id: 'd3', notes: [{ id: 301, type: 'DiffNote', body: 'Old code', author: { username: 'bo' }, created_at: '2026-09-01T00:00:00Z', resolvable: true, resolved: false, position: { head_sha: 'h1', position_type: 'text', new_path: 'a.js', new_line: 2 } }] },
  { id: 'd4', individual_note: true, notes: [{ id: 401, type: null, body: 'LGTM', author: { username: 'bo' }, created_at: '2026-10-01T00:00:00Z', system: false }] },
  { id: 'd5', notes: [{ id: 501, type: 'DiffNote', body: 'On the image', position: { position_type: 'image', new_path: 'logo.png' } }] },
  { id: 'd6', notes: [{ id: 601, body: 'changed this line', system: true, type: 'DiffNote', position: { position_type: 'text', new_path: 'a.js', new_line: 1 } }] },
];

test('GitLab discussions as threads: placed by side, resolved, outdated on an older head, general ones left out', () => {
  const t = gitlabThreads(DISCUSSIONS, 'h2');
  assert.deepEqual(t.map((x) => [x.id, x.path, x.line, x.side, x.resolved, x.outdated]), [
    ['d1', 'src/app.js', 11, 'new', true, false],
    ['d2', 'old.js', 4, 'old', false, false],
    ['d3', 'a.js', null, 'new', false, true],
  ]);
  assert.deepEqual(t[0].comments.map((c) => [c.id, c.author, c.body]), [[101, 'Bo', 'Why 3?'], [102, 'Ana', 'Because.']]);
  assert.equal(gitlabThreads(DISCUSSIONS)[2].line, 2, 'without the head, nothing is outdated');
});

test('a new GitLab thread: the position with the diff refs, both line numbers on an unchanged line', () => {
  const refs = { base_sha: 'b', start_sha: 's', head_sha: 'h' };
  const common = { position_type: 'text', base_sha: 'b', start_sha: 's', head_sha: 'h', old_path: 'a.js', new_path: 'a.js' };
  assert.deepEqual(gitlabNewThreadBody(refs, { path: 'a.js', line: 5, side: 'new' }, 'Hm'), { body: 'Hm', position: { ...common, new_line: 5 } });
  assert.deepEqual(gitlabNewThreadBody(refs, { path: 'a.js', line: 5, side: 'old' }, 'Hm'), { body: 'Hm', position: { ...common, old_line: 5 } });
  assert.deepEqual(gitlabNewThreadBody(refs, { path: 'a.js', line: 6, side: 'new', old: 4 }, 'Hm'), { body: 'Hm', position: { ...common, new_line: 6, old_line: 4 } });
  assert.deepEqual(gitlabNewThreadBody(refs, { path: 'a.js', line: 4, side: 'old', new: 6 }, 'Hm'), { body: 'Hm', position: { ...common, old_line: 4, new_line: 6 } });
});

// The host against a fake glab: a script on the PATH that logs each call (its arguments, and the JSON body
// of --input) and answers from a list of [pattern, answer] routes, the first pattern the arguments match.
let base;
let calls;
const skip = process.platform === 'win32' ? 'the fake glab is a script, which Windows would need a .exe for' : false;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-gitlab-'));
  const bin = join(base, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'glab');
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const i = args.indexOf('--input');
const body = i >= 0 ? JSON.parse(fs.readFileSync(args[i + 1], 'utf8')) : null;
fs.appendFileSync(process.env.FAKE_GLAB_LOG, JSON.stringify({ args, body }) + '\\n');
const routes = JSON.parse(fs.readFileSync(process.env.FAKE_GLAB_ROUTES, 'utf8'));
const line = args.join(' ');
const hit = routes.find(([pattern]) => new RegExp(pattern).test(line));
if (!hit || hit[1] === 'fail') { process.stderr.write('glab: 404 Not Found (HTTP 404)\\n'); process.exit(1); }
process.stdout.write(typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]));
`,
  );
  chmodSync(fake, 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  process.env.FAKE_GLAB_LOG = join(base, 'log.jsonl');
  process.env.FAKE_GLAB_ROUTES = join(base, 'routes.json');
});

after(() => removeTemp(base));

function routes(list) {
  writeFileSync(process.env.FAKE_GLAB_ROUTES, JSON.stringify(list));
  writeFileSync(process.env.FAKE_GLAB_LOG, '');
  calls = () => readFileSync(process.env.FAKE_GLAB_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const host = (root = base) => hostFor({ root, remoteUrls: { origin: 'git@gitlab.example.com:grp/sub/app.git' } });
const P = 'projects/grp%2Fsub%2Fapp';

test('the GitLab host lists merge requests through GraphQL, and through REST when GraphQL fails', { skip }, async () => {
  routes([
    ['api --hostname gitlab.example.com user$', { username: 'me' }],
    ['graphql', { data: { project: { mergeRequests: { nodes: [GQL_MR] } } } }],
  ]);
  const prs = await host().list();
  assert.deepEqual(prs.map((p) => [p.label, p.reviewMe]), [['!12', true]]);
  const gql = calls().find((c) => c.args.includes('graphql'));
  assert.deepEqual(gql.args.slice(0, 5), ['api', '--hostname', 'gitlab.example.com', 'graphql', '-f']);
  assert.match(gql.args[5], /^query=query \{\n {2}project\(fullPath: "grp\/sub\/app"\)/);

  routes([
    ['user$', { username: 'me' }],
    ['graphql', { errors: [{ message: "Field 'approved' doesn't exist" }] }],
    [`--paginate ${P}/merge_requests\\?state=opened`, [REST_MR]],
  ]);
  assert.deepEqual((await host().list()).map((p) => [p.label, p.mine]), [['!13', true]]);
});

test('the GitLab host: comments, replies, resolving, approving, asking for changes, merging, checks', { skip }, async () => {
  const pr = gitlabPr(REST_MR, 'me', REMOTE);
  const refs = { base_sha: 'b1', start_sha: 's1', head_sha: 'h1' };
  routes([
    [`${P}/merge_requests/13/unapprove`, 'fail'],
    [`${P}/merge_requests/13/rebase`, { rebase_in_progress: true }],
    [`${P}/merge_requests/13\\?include_rebase_in_progress=true`, { rebase_in_progress: false, merge_error: null, sha: 'rebased1' }],
    [`${P}/merge_requests/13/pipelines`, [{ id: 7, status: 'failed' }]],
    [`${P}/pipelines/7/jobs`, [{ id: 72, name: 'unit', stage: 'test', status: 'failed', pipeline: { id: 7 } }]],
    [`${P}/jobs/72/trace`, 'section_start:1:x\r\x1b[0Kboom\n'],
    [`${P}/merge_requests/13/discussions`, [DISCUSSIONS[0]]],
    [`users\\?username=bo`, [{ id: 2, username: 'bo' }]],
    [`users\\?username=cy`, [{ id: 3, username: 'cy' }]],
    [`${P}/merge_requests/13$`, { iid: 13, title: 'Fix the login', diff_refs: refs, sha: 'h1', reviewers: [{ id: 2 }] }],
    ['.', {}],
  ]);
  const h = host();
  await h.comment(pr, 'Nice');
  await h.reply(pr, { id: 'd1' }, 'Thanks');
  await h.resolveThread(pr, { id: 'd1' }, true);
  await h.addThread(pr, { path: 'a.js', line: 6, side: 'new', old: 4 }, 'Hm');
  await h.approve(pr);
  await h.requestChanges(pr, 'Rename it');
  await h.merge(pr, { method: 'squash', deleteBranch: true, auto: true });
  await h.addReviewers(pr, ['@bo', 'cy']);
  await h.setDraft(pr, true);
  await h.edit(pr, { body: 'New\nbody' });
  const sent = calls()
    .filter((c) => c.args.includes('-X'))
    .map((c) => [c.args[c.args.indexOf('-X') + 1], c.args.at(-1).replace(`${P}/merge_requests/13`, '!13'), c.body]);
  assert.deepEqual(sent, [
    ['POST', '!13/notes', { body: 'Nice' }],
    ['POST', '!13/discussions/d1/notes', { body: 'Thanks' }],
    ['PUT', '!13/discussions/d1', { resolved: true }],
    ['POST', '!13/discussions', gitlabNewThreadBody(refs, { path: 'a.js', line: 6, side: 'new', old: 4 }, 'Hm')],
    ['POST', '!13/approve', null],
    ['POST', '!13/notes', { body: 'Rename it' }],
    ['POST', '!13/unapprove', null],
    ['PUT', '!13/merge', { squash: true, should_remove_source_branch: true, merge_when_pipeline_succeeds: true, auto_merge: true, sha: 'def456' }],
    ['PUT', '!13', { reviewer_ids: [2, 3] }],
    ['PUT', '!13', { title: 'Draft: Fix the login' }],
    ['PUT', '!13', { description: 'New\nbody' }],
  ]);
  const json = calls().find((c) => c.body);
  assert.ok(json.args.includes('Content-Type: application/json'));

  routes([
    [`${P}/merge_requests/13/rebase`, { rebase_in_progress: true }],
    [`${P}/merge_requests/13\\?include_rebase_in_progress=true`, { rebase_in_progress: false, merge_error: null, sha: 'rebased1' }],
    ['.', {}],
  ]);
  assert.equal(await h.merge(pr, { method: 'rebase', deleteBranch: false, auto: false }), 'Merged !13');
  assert.deepEqual(calls().filter((c) => c.args.includes('-X')).map((c) => [c.args.at(-1).replace(`${P}/merge_requests/13`, '!13'), c.body]), [
    ['!13/rebase', null],
    ['!13/merge', { squash: false, should_remove_source_branch: false, sha: 'rebased1' }],
  ]);

  routes([
    [`${P}/merge_requests/13/pipelines`, [{ id: 7, status: 'failed' }]],
    [`${P}/pipelines/7/jobs`, [{ id: 72, name: 'unit', stage: 'test', status: 'failed', pipeline: { id: 7 } }]],
    [`${P}/jobs/72/trace`, 'section_start:1:x\r\x1b[0Kboom\n'],
    [`${P}/merge_requests/13/discussions`, [DISCUSSIONS[0]]],
    [`${P}/merge_requests/13$`, { iid: 13, diff_refs: refs, sha: 'h1' }],
    ['.', {}],
  ]);
  const checks = await h.checks(pr);
  assert.deepEqual(checks.map((c) => [c.name, c.state, c.jobId]), [['unit', 'fail', 72]]);
  assert.equal(await h.checkLog(checks[0]), 'boom');
  assert.equal(await h.rerun(pr, checks), 'Retrying the failed jobs of 1 pipeline');
  assert.ok(calls().some((c) => c.args.join(' ').endsWith(`-X POST ${P}/pipelines/7/retry`)));
  const threads = await h.threads(pr);
  assert.deepEqual(threads.map((t) => [t.id, t.outdated, t.line]), [['d1', true, null]], 'made on h2, the head is h1 now');
  assert.ok(calls().some((c) => c.args.includes('--paginate') && c.args.at(-1).startsWith(`${P}/merge_requests/13/discussions`)));
});

test("the GitLab host diffs a merge request from GitLab's refs/merge-requests/<iid>/head, and makes releases", { skip }, async () => {
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const server = join(base, 'server.git');
  const work = join(base, 'work');
  const clone = join(base, 'clone');
  mkdirSync(work);
  sh(base, 'init', '-q', '--bare', '-b', 'main', server);
  sh(work, 'init', '-q', '-b', 'main');
  sh(work, 'config', 'user.name', 'T');
  sh(work, 'config', 'user.email', 't@example.com');
  sh(work, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(work, 'a.txt'), 'one\n');
  sh(work, 'add', '.');
  sh(work, 'commit', '-q', '-m', 'First');
  sh(work, 'tag', 'v1.0');
  writeFileSync(join(work, 'a.txt'), 'two\n');
  sh(work, 'commit', '-q', '-am', 'Second');
  sh(work, 'tag', 'v1.1');
  sh(work, 'push', '-q', server, 'HEAD~1:refs/heads/main', 'HEAD:refs/merge-requests/4/head', '--tags');
  sh(base, 'clone', '-q', server, clone);

  const h = hostFor({ root: clone, remoteUrls: { origin: 'https://gitlab.com/grp/sub/app.git' } });
  const diff = await h.diff({ id: 4, target: 'main', source: 'from-a-fork' });
  assert.match(diff, /^diff --git a\/a.txt b\/a.txt/);
  assert.match(diff, /-one\n\+two/);
  assert.equal(sh(clone, 'for-each-ref', 'refs/splice'), '', "Splice's ref is gone afterwards");

  routes([[`${P}/releases$`, { tag_name: 'v1.1', _links: { self: 'https://gitlab.com/grp/sub/app/-/releases/v1.1' } }]]);
  assert.equal(await h.createRelease({ tag: 'v1.1', title: 'One one' }), 'https://gitlab.com/grp/sub/app/-/releases/v1.1');
  assert.deepEqual(calls()[0].body, { tag_name: 'v1.1', name: 'One one', description: 'Changes since v1.0:\n\n- Second' });
});
