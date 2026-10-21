// Review comments in a pull request's diff: placing them, both hosts' JSON, and replying through the real UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { App } from '../src/ui/App.jsx';
import {
  GITHUB_THREADS_QUERY,
  azureNewThreadBody,
  azureResolveBody,
  azureThreads,
  githubNewThreadArgs,
  githubRequestChangesArgs,
  githubResolveArgs,
  githubReviewThreads,
  githubThreads,
  githubThreadsArgs,
} from '../src/hosting.js';
import { diffPositions, lineTarget, placeThreads, withThreads } from '../src/review.js';

const DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -10,3 +10,3 @@ function main() {',
  '   const a = 1;',
  '-  const b = 2;',
  '+  const b = 3;',
  '   return a + b;',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  ' # Title',
  '+More text',
];

test('diff lines know their file and their line on each side', () => {
  const pos = diffPositions(DIFF);
  assert.equal(pos[4], null, 'the hunk header');
  assert.deepEqual(pos[5], { path: 'src/app.js', old: 10, new: 10 });
  assert.deepEqual(pos[6], { path: 'src/app.js', old: 11, new: null });
  assert.deepEqual(pos[7], { path: 'src/app.js', old: null, new: 11 });
  assert.deepEqual(pos[8], { path: 'src/app.js', old: 12, new: 12 });
  assert.deepEqual(pos[14], { path: 'README.md', old: null, new: 2 });
});

const thread = (over) => ({ id: 1, path: 'src/app.js', line: 11, side: 'new', outdated: false, resolved: null, comments: [{ id: 1, author: 'ana', body: 'Why 3?', time: 0 }], ...over });

test('threads go under their line, on the side they were written on; the rest go first', () => {
  const threads = [thread(), thread({ id: 2, side: 'old', line: 11 }), thread({ id: 3, path: 'README.md', line: 2 }), thread({ id: 4, line: null, outdated: true })];
  const { at, away } = placeThreads(DIFF, threads);
  assert.deepEqual(at.get(7).map((t) => t.id), [1]);
  assert.deepEqual(at.get(6).map((t) => t.id), [2]);
  assert.deepEqual(at.get(14).map((t) => t.id), [3]);
  assert.deepEqual(away.map((t) => t.id), [4]);

  const { lines, starts } = withThreads(DIFF, threads, 60, { now: 3600 });
  assert.deepEqual(starts.map((s) => s.thread.id), [4, 2, 1, 3]);
  const text = (l) => (typeof l === 'string' ? l : l.map((s) => s.text).join(''));
  assert.match(text(lines[0]), /no longer shows/);
  // The box right after its line: "┌ 1 comment", the author, the body.
  const after = lines.indexOf('+  const b = 3;');
  assert.match(text(lines[after + 1]), /┌ 1 comment/);
  assert.match(text(lines[after + 2]), /ana · 1h/);
  assert.match(text(lines[after + 3]), /Why 3\?/);
});

test("GitHub's review comments: replies join their thread, an outdated one has no line", () => {
  const raw = [
    { id: 11, in_reply_to_id: null, path: 'a.js', line: 4, side: 'RIGHT', body: 'First', user: { login: 'ana' }, created_at: '2026-01-01T00:00:00Z' },
    { id: 12, in_reply_to_id: 11, path: 'a.js', line: 4, side: 'RIGHT', body: 'Reply', user: { login: 'bo' }, created_at: '2026-01-02T00:00:00Z' },
    { id: 13, path: 'a.js', line: null, original_line: 9, side: 'LEFT', body: 'Old', user: { login: 'cy' }, created_at: '2026-01-03T00:00:00Z' },
  ];
  const t = githubThreads(raw);
  assert.equal(t.length, 2);
  assert.deepEqual(t[0].comments.map((c) => c.author), ['ana', 'bo']);
  assert.equal(t[0].id, 11);
  assert.deepEqual([t[1].side, t[1].line, t[1].outdated], ['old', null, true]);
});

test("Azure DevOps threads: on code only, system notes left out, fixed ones resolved", () => {
  const value = [
    { id: 5, status: 'active', threadContext: { filePath: '/src/a.js', rightFileStart: { line: 7, offset: 1 } }, comments: [{ id: 1, content: 'Hm', author: { displayName: 'Ana' }, publishedDate: '2026-01-01T00:00:00Z', commentType: 'text' }] },
    { id: 6, status: 'fixed', threadContext: { filePath: '/src/b.js', leftFileStart: { line: 2, offset: 1 } }, comments: [{ id: 1, content: 'Gone', author: { displayName: 'Bo' }, publishedDate: '2026-01-01T00:00:00Z' }] },
    { id: 7, threadContext: null, comments: [{ id: 1, content: 'General', author: { displayName: 'Cy' } }] },
    { id: 8, threadContext: { filePath: '/x' }, comments: [{ id: 1, content: 'Ana voted 10', commentType: 'system' }] },
  ];
  const t = azureThreads(value);
  assert.deepEqual(t.map((x) => [x.id, x.path, x.line, x.side, x.resolved]), [
    [5, 'src/a.js', 7, 'new', false],
    [6, 'src/b.js', 2, 'old', true],
  ]);
});

test('a comment on a diff line: added and unchanged lines on the new side, removed ones on the old, headers none', () => {
  const pos = diffPositions(DIFF);
  assert.deepEqual(lineTarget(pos[7], DIFF[7]), { path: 'src/app.js', line: 11, side: 'new', text: '  const b = 3;' });
  assert.deepEqual(lineTarget(pos[6], DIFF[6]), { path: 'src/app.js', line: 11, side: 'old', text: '  const b = 2;' });
  assert.deepEqual(lineTarget(pos[8], DIFF[8]), { path: 'src/app.js', line: 12, side: 'new', text: '  return a + b;', old: 12 }, 'an unchanged line has both numbers');
  assert.equal(lineTarget(pos[0], DIFF[0]), null, 'diff --git');
  assert.equal(lineTarget(pos[4], DIFF[4]), null, 'the hunk header');
  assert.equal(lineTarget(undefined, undefined), null);
});

test("a diff's rows keep their keys when threads come in around them, and say which line or thread each is", () => {
  const bare = withThreads(DIFF, [], 60);
  assert.deepEqual(bare.lines, DIFF);
  assert.deepEqual(bare.rows[7], { key: 'd7', diff: 7, at: { path: 'src/app.js', old: null, new: 11 } });
  const { lines, rows, starts } = withThreads(DIFF, [thread(), thread({ id: 4, line: null, outdated: true })], 60, { now: 3600 });
  assert.equal(rows.length, lines.length);
  assert.equal(rows[0].key, 'away');
  const d7 = rows.findIndex((r) => r.key === 'd7');
  assert.equal(lines[d7], '+  const b = 3;');
  const box = starts.find((s) => s.thread.id === 1);
  assert.equal(box.at, d7 + 1);
  assert.ok(rows.slice(box.at, box.end).every((r) => r.thread.id === 1));
  assert.equal(rows[box.end].key, 'd8');
});

test("GitHub's review threads through GraphQL: resolved and outdated known, replies to the first comment", () => {
  // Shaped like `gh api graphql` with --jq '.data.repository.pullRequest.reviewThreads.nodes[]'.
  const nodes = [
    {
      id: 'PRRT_kwDOAbc123',
      isResolved: true,
      isOutdated: false,
      path: 'src/a.js',
      line: 4,
      diffSide: 'RIGHT',
      comments: { nodes: [
        { databaseId: 11, body: 'First', createdAt: '2026-01-01T00:00:00Z', author: { login: 'ana' } },
        { databaseId: 12, body: 'Reply', createdAt: '2026-01-02T00:00:00Z', author: { login: 'bo' } },
      ] },
    },
    { id: 'PRRT_2', isResolved: false, isOutdated: true, path: 'src/b.js', line: null, diffSide: 'LEFT', comments: { nodes: [{ databaseId: 13, body: 'Old', createdAt: '2026-01-03T00:00:00Z', author: null }] } },
    { id: 'PRRT_3', isResolved: false, isOutdated: false, path: 'x', line: 1, diffSide: 'RIGHT', comments: { nodes: [] } },
  ];
  assert.deepEqual(githubReviewThreads(nodes), [
    {
      id: 11,
      nodeId: 'PRRT_kwDOAbc123',
      path: 'src/a.js',
      line: 4,
      side: 'new',
      outdated: false,
      resolved: true,
      comments: [
        { id: 11, author: 'ana', body: 'First', time: Date.parse('2026-01-01T00:00:00Z') / 1000 },
        { id: 12, author: 'bo', body: 'Reply', time: Date.parse('2026-01-02T00:00:00Z') / 1000 },
      ],
    },
    { id: 13, nodeId: 'PRRT_2', path: 'src/b.js', line: null, side: 'old', outdated: true, resolved: false, comments: [{ id: 13, author: '', body: 'Old', time: Date.parse('2026-01-03T00:00:00Z') / 1000 }] },
  ]);
  assert.equal(githubThreads([{ id: 1, path: 'a', line: 1, side: 'RIGHT', body: '', created_at: '2026-01-01T00:00:00Z' }])[0].nodeId, null, 'REST has no node id');
});

test('arguments for review threads: the GraphQL query, resolving, a new comment on a line, requesting changes', () => {
  const args = githubThreadsArgs({ owner: 'o', repo: 'r' }, { id: 7 });
  assert.deepEqual(args.slice(0, 3), ['api', 'graphql', '--paginate']);
  assert.ok(args.includes(`query=${GITHUB_THREADS_QUERY}`));
  assert.match(GITHUB_THREADS_QUERY, /\$endCursor: String/, '--paginate needs $endCursor');
  assert.match(GITHUB_THREADS_QUERY, /pageInfo \{ hasNextPage endCursor \}/);
  // The number goes as -F, so GraphQL gets an Int; the names as -f, strings as they are.
  assert.deepEqual(args.slice(5), ['-f', 'owner=o', '-f', 'repo=r', '-F', 'number=7', '--jq', '.data.repository.pullRequest.reviewThreads.nodes[]']);

  const resolve = githubResolveArgs('PRRT_1', true);
  assert.match(resolve[3], /resolveReviewThread\(input: \{ threadId: \$id \}\)/);
  assert.deepEqual(resolve.slice(4), ['-f', 'id=PRRT_1']);
  assert.match(githubResolveArgs('PRRT_1', false)[3], /unresolveReviewThread/);

  assert.deepEqual(githubNewThreadArgs('o/r', { id: 7 }, 'abc123', { path: 'src/a.js', line: 11, side: 'new' }, '@ana why?'), [
    'api', '-X', 'POST', 'repos/o/r/pulls/7/comments', '-f', 'body=@ana why?', '-f', 'commit_id=abc123', '-f', 'path=src/a.js', '-F', 'line=11', '-f', 'side=RIGHT',
  ]);
  assert.equal(githubNewThreadArgs('o/r', { id: 7 }, 'abc', { path: 'a', line: 2, side: 'old' }, 'x').at(-1), 'side=LEFT');
  assert.deepEqual(githubRequestChangesArgs({ id: 7 }, 'o/r', 'Tests, please'), ['pr', 'review', '7', '-R', 'o/r', '--request-changes', '--body', 'Tests, please']);

  assert.deepEqual(azureNewThreadBody({ path: 'src/a.js', line: 11, side: 'new', text: '  const b = 3;' }, 'Why 3?'), {
    comments: [{ parentCommentId: 0, content: 'Why 3?', commentType: 1 }],
    status: 1,
    threadContext: { filePath: '/src/a.js', rightFileStart: { line: 11, offset: 1 }, rightFileEnd: { line: 11, offset: 15 } },
  });
  const old = azureNewThreadBody({ path: 'a', line: 2, side: 'old', text: 'x' }, 'Gone').threadContext;
  assert.deepEqual(old, { filePath: '/a', leftFileStart: { line: 2, offset: 1 }, leftFileEnd: { line: 2, offset: 2 } });
  assert.deepEqual(azureResolveBody(true), { status: 2 });
  assert.deepEqual(azureResolveBody(false), { status: 1 });
});

let base;
let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-review-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

test("a PR's diff shows its review comments; t picks one and r replies to it", async () => {
  const pr = { id: 7, label: '#7', title: 'Bump b', author: 'ana', mine: false, reviewMe: true, source: 'b', target: 'main', draft: false, url: 'https://example.com/7', time: 0, review: { text: 'Review required', tone: 'wait' }, checks: null, reviewers: [], description: '' };
  let threads = [thread()];
  const replies = [];
  const makeHost = () => ({
    kind: 'github',
    name: 'GitHub',
    signIn: 'gh auth login',
    remoteName: 'origin',
    list: async () => [pr],
    detail: async () => ({ reviewers: [], checks: [], comments: [], conflicts: false }),
    diff: async () => DIFF.join('\n'),
    threads: async () => threads,
    reply: async (p, t, text) => {
      replies.push([p.id, t.id, text]);
      threads = [{ ...t, comments: [...t.comments, { id: 2, author: 'me', body: text, time: Date.now() / 1000 }] }];
    },
  });
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, makeHost }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    app.stdin.write('6');
    await until(() => /❯.*Bump b/.test(frame()), 'the PR');
    app.stdin.write('\r');
    await until(() => frame().includes('Why 3?') && frame().includes('1 comment · t/T · r reply'), 'the diff with its comment');
    app.stdin.write('t');
    await until(() => frame().includes('┏ 1 comment'), 'the comment picked');
    app.stdin.write('r');
    await until(() => frame().includes('> /reply'), 'the reply in the prompt');
    for (const ch of 'Because 2 was wrong') app.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 100));
    app.stdin.write('\r');
    await until(() => replies.length === 1 && frame().includes('2 comments') && frame().includes('Because 2 was wrong'), 'the reply posted and shown');
    assert.deepEqual(replies, [[7, 1, 'Because 2 was wrong']]);
  } finally {
    app.unmount();
  }
});

const PR = { id: 7, label: '#7', title: 'Bump b', author: 'ana', mine: false, reviewMe: true, source: 'b', target: 'main', draft: false, url: 'https://example.com/7', time: 0, review: { text: 'Review required', tone: 'wait' }, checks: null, reviewers: [], description: '' };

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** Opens PR #7's diff in the PRs view, with `host` standing in for GitHub. */
async function openDiff(host) {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, makeHost: () => ({ kind: 'github', name: 'GitHub', signIn: 'gh auth login', remoteName: 'origin', list: async () => [PR], detail: async () => ({ reviewers: [], checks: [], comments: [], conflicts: false }), diff: async () => DIFF.join('\n'), ...host }) }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  await until(() => frame().includes('First commit'), 'the graph');
  app.stdin.write('6');
  await until(() => /❯.*Bump b/.test(frame()), 'the PR');
  app.stdin.write('\r');
  await until(() => frame().includes('+  const b = 3;') && frame().includes('c comment'), 'the diff');
  return { app, frame };
}

test("c comments on the line under the cursor in a PR's diff; a header can't take one", async () => {
  let threads = [];
  const posted = [];
  const { app, frame } = await openDiff({
    threads: async () => threads,
    addThread: async (p, at, text) => {
      posted.push([p.id, at, text]);
      threads = [...threads, { id: 100 + posted.length, nodeId: null, path: at.path, line: at.line, side: at.side, outdated: false, resolved: false, comments: [{ id: 1, author: 'me', body: text, time: Date.now() / 1000 }] }];
    },
  });
  try {
    // The cursor starts on "diff --git".
    app.stdin.write('c');
    await until(() => frame().includes('Only changed lines and those shown around them can be commented on.'), 'the refusal on a header');
    await type(app.stdin, 'jjjjjjj');
    app.stdin.write('c');
    await until(() => frame().includes('> /review-comment'), 'the comment in the prompt');
    await type(app.stdin, 'Why not 4?');
    app.stdin.write('\r');
    await until(() => posted.length === 1 && frame().includes('Why not 4?') && frame().includes('1 comment · t/T'), 'the comment posted and shown under its line');
    assert.deepEqual(posted[0], [7, { path: 'src/app.js', line: 11, side: 'new', text: '  const b = 3;' }, 'Why not 4?']);
    assert.match(frame(), /\+  const b = 3;\s*│?\n.*┌ 1 comment/);

    // The cursor stayed on its line as the thread came in under it; one up is the removed line.
    app.stdin.write('k');
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write('c');
    await until(() => frame().includes('> /review-comment'), 'the second comment in the prompt');
    await type(app.stdin, 'It was 2');
    app.stdin.write('\r');
    await until(() => posted.length === 2 && frame().includes('2 comments · t/T'), 'the second comment posted');
    assert.deepEqual(posted[1], [7, { path: 'src/app.js', line: 11, side: 'old', text: '  const b = 2;' }, 'It was 2']);
  } finally {
    app.unmount();
  }
});

test('x resolves the picked thread and opens it again', async () => {
  let threads = [thread({ nodeId: 'PRRT_1', resolved: false })];
  const calls = [];
  const { app, frame } = await openDiff({
    threads: async () => threads,
    resolveThread: async (p, t, resolved) => {
      calls.push([p.id, t.nodeId, resolved]);
      threads = [{ ...t, resolved }];
    },
  });
  try {
    await until(() => frame().includes('Why 3?') && frame().includes('x resolve'), 'the comment');
    app.stdin.write('t');
    await until(() => frame().includes('┏ 1 comment'), 'the comment picked');
    app.stdin.write('x');
    await until(() => calls.length === 1 && frame().includes('┏ 1 comment  resolved'), 'the thread resolved');
    app.stdin.write('x');
    await until(() => calls.length === 2 && /┏ 1 comment *│/.test(frame()), 'the thread opened again');
    assert.deepEqual(calls, [[7, 'PRRT_1', true], [7, 'PRRT_1', false]]);
  } finally {
    app.unmount();
  }
});
