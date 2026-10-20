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
import { azureThreads, githubThreads } from '../src/hosting.js';
import { diffPositions, placeThreads, withThreads } from '../src/review.js';

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
