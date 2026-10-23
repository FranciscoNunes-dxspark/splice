// Git LFS: the pure parts (lfs.js) always; the end-to-end part against throwaway repositories, only where
// git lfs is installed (a clone made with LFS's downloads skipped has pointers for /lfs pull to fill in).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { App } from '../src/ui/App.jsx';
import { LFS_MISSING, isPointer, lfsCommand, lfsError, lfsMissing, lfsSummary, lfsText, parseLfsFiles, parseLfsLocks, usesLfs } from '../src/lfs.js';
import { checkPointers } from '../src/repo.js';

test('usesLfs looks for filter=lfs on a line that is not a comment', () => {
  assert.equal(usesLfs('*.psd filter=lfs diff=lfs merge=lfs -text\n'), true);
  assert.equal(usesLfs('# *.psd filter=lfs diff=lfs\n*.txt text eol=lf\n'), false);
  assert.equal(usesLfs('*.bin filter=lfsx\n'), false);
  assert.equal(usesLfs(''), false);
  assert.equal(usesLfs(undefined), false);
});

test('parseLfsFiles tells content (*) from pointers (-), paths with spaces included', () => {
  const raw = '5891b5b522 * art/logo.psd\r\n0123456789 - video/intro clip.mp4\nnot a line\n';
  const files = parseLfsFiles(raw);
  assert.deepEqual(files, {
    'art/logo.psd': { oid: '5891b5b522', content: true },
    'video/intro clip.mp4': { oid: '0123456789', content: false },
  });
  assert.deepEqual(lfsSummary(files), { total: 2, pointers: 1, paths: ['video/intro clip.mp4'] });
  const text = lfsText(files, 'On branch main\n');
  assert.match(text, /^2 files in LFS: 1 downloaded, 1 only a pointer \(\/lfs pull downloads it\)\./);
  assert.match(text, /Only a pointer here:\n {2}video\/intro clip\.mp4/);
  assert.match(text, /git lfs status\n\nOn branch main$/);
  assert.match(lfsText({}, ''), /^No files are in LFS/);
});

test('parseLfsLocks reads a plain list and the --verify form, skipping hints around the JSON', () => {
  const plain = 'hint: something\n[{"id":"2","path":"b.psd","owner":{"name":"Ana"},"locked_at":"2026-10-01T10:00:00Z"},{"id":"1","path":"a.psd","owner":{"name":"Bo"},"locked_at":""}]\n';
  assert.deepEqual(parseLfsLocks(plain), [
    { id: '1', path: 'a.psd', owner: 'Bo', lockedAt: '' },
    { id: '2', path: 'b.psd', owner: 'Ana', lockedAt: '2026-10-01T10:00:00Z' },
  ]);
  const verify = '{"ours":[{"id":"7","path":"mine.bin","owner":{"name":"Me"},"locked_at":"x"}],"theirs":[{"id":8,"path":"theirs.bin","owner":{"name":"You"},"locked_at":"y"}]}';
  assert.deepEqual(parseLfsLocks(verify).map((l) => [l.id, l.path, l.mine]), [['7', 'mine.bin', true], ['8', 'theirs.bin', false]]);
  assert.deepEqual(parseLfsLocks(''), []);
  assert.deepEqual(parseLfsLocks('[]'), []);
});

test('lfsCommand reads /lfs and its actions', () => {
  assert.deepEqual(lfsCommand(''), { action: 'status' });
  assert.deepEqual(lfsCommand('pull'), { action: 'pull', args: [] });
  assert.deepEqual(lfsCommand('fetch --all'), { action: 'fetch', args: ['--all'] });
  assert.deepEqual(lfsCommand('locks'), { action: 'locks' });
  assert.deepEqual(lfsCommand('lock art\\logo.psd'), { action: 'lock', path: 'art/logo.psd' });
  assert.deepEqual(lfsCommand('unlock --force my file.bin'), { action: 'unlock', path: 'my file.bin', force: true });
  assert.deepEqual(lfsCommand('unlock a.bin'), { action: 'unlock', path: 'a.bin', force: false });
  assert.match(lfsCommand('lock').error, /Use: \/lfs lock <path>/);
  assert.match(lfsCommand('lock --force a').error, /Only unlocking/);
  assert.match(lfsCommand('prune').error, /doesn't know "prune"/);
});

test('lfsError drops hints and says clearly when git lfs is missing', () => {
  assert.equal(lfsMissing("git: 'lfs' is not a git command. See 'git --help'."), true);
  assert.equal(lfsMissing('Locking failed'), false);
  assert.equal(lfsError("git: 'lfs' is not a git command. See 'git --help'."), LFS_MISSING);
  assert.equal(lfsError('\nhint: The remote resolves to a file:// URL\nhint: more\nLocking x.bin failed: missing protocol\n'), 'Locking x.bin failed: missing protocol');
});

test('isPointer and checkPointers tell a pointer on disk from content', async () => {
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 6\n';
  assert.equal(isPointer(pointer), true);
  assert.equal(isPointer('hello'), false);
  const folder = mkdtempSync(join(tmpdir(), 'splice-lfs-ptr-'));
  try {
    writeFileSync(join(folder, 'p.bin'), pointer);
    writeFileSync(join(folder, 'c.bin'), 'content\n');
    const files = { 'p.bin': { oid: 'a', content: true }, 'c.bin': { oid: 'b', content: false }, 'gone.bin': { oid: 'c', content: false }, 'same.bin': { oid: 'd', content: true } };
    const out = await checkPointers(folder, files, ['p.bin', 'c.bin', 'gone.bin', 'other.txt']);
    assert.deepEqual(out, { 'p.bin': { oid: 'a', content: false }, 'c.bin': { oid: 'b', content: true }, 'gone.bin': { oid: 'c', content: false }, 'same.bin': { oid: 'd', content: true } });
  } finally {
    await removeTemp(folder);
  }
});

// The end-to-end part.
const hasLfs = (() => {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let base;
let dir;
let plain;
const run = (cwd, args, env) => execFileSync('git', args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env }).trim();
const git = (...args) => run(dir, args);

const init = (path) => {
  mkdirSync(path);
  run(path, ['init', '-q', '-b', 'main']);
  for (const [k, v] of [['core.autocrlf', 'false'], ['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false']]) run(path, ['config', k, v]);
};

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-lfs-'));
  process.env.SPLICE_HOME = join(base, 'home');
  plain = join(base, 'plain');
  init(plain);
  writeFileSync(join(plain, 'a.txt'), 'a\n');
  run(plain, ['add', '.']);
  run(plain, ['commit', '-q', '-m', 'Plain start']);
  if (!hasLfs) return;
  const origin = join(base, 'origin');
  init(origin);
  run(origin, ['lfs', 'install', '--local']);
  run(origin, ['lfs', 'track', '*.bin']);
  writeFileSync(join(origin, 'x.bin'), 'hello\n');
  writeFileSync(join(origin, 'y.bin'), 'why\n');
  run(origin, ['add', '.']);
  run(origin, ['commit', '-q', '-m', 'Big files']);
  dir = join(base, 'app');
  run(base, ['clone', '-q', origin, dir], { GIT_LFS_SKIP_SMUDGE: '1' });
  for (const [k, v] of [['core.autocrlf', 'false'], ['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false']]) git('config', k, v);
  git('lfs', 'install', '--local');
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

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

const start = (path) => {
  lastApp = render(React.createElement(App, { initialPath: path, config: { recent: [], roots: [], history: [] } }));
  return lastApp;
};

test('/lfs in a repository without LFS says so', async () => {
  const app = start(plain);
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Plain start'), 'the graph');
    await type(app.stdin, '/lfs');
    app.stdin.write('\r');
    await until(() => frame().includes(hasLfs ? "doesn't use Git LFS" : "Git LFS isn't installed"), 'the answer');
  } finally {
    app.unmount();
  }
});

test('Changes marks LFS files; /lfs, /lfs pull, /lfs locks and L', { skip: !hasLfs && 'git lfs is not installed' }, async () => {
  assert.match(readFileSync(join(dir, 'x.bin'), 'utf8'), /^version https:\/\/git-lfs/);
  writeFileSync(join(dir, 'y.bin'), 'changed\n');
  const app = start(dir);
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Big files'), 'the graph');
    app.stdin.write('2');
    // y.bin has content of its own now.
    await until(() => /M y\.bin\s+LFS(?! pointer)/.test(frame()), 'the LFS file marked');

    await type(app.stdin, '/lfs');
    app.stdin.write('\r');
    await until(() => frame().includes('2 files in LFS: 1 downloaded, 1 only a pointer (/lfs pull downloads it)'), 'the summary');
    assert.match(frame(), /Only a pointer here:/);
    app.stdin.write('\x1b');
    await until(() => !frame().includes('2 files in LFS'), 'the viewer to close');

    await type(app.stdin, '/lfs pull');
    app.stdin.write('\r');
    await until(() => readFileSync(join(dir, 'x.bin'), 'utf8') === 'hello\n', 'the content in place of the pointer');
    await new Promise((r) => setTimeout(r, 200));
    await type(app.stdin, '/lfs');
    app.stdin.write('\r');
    await until(() => frame().includes('2 files in LFS: 2 downloaded.'), 'the summary after pulling');
    // Changed files are left alone, but their object is downloaded too.
    assert.equal(readFileSync(join(dir, 'y.bin'), 'utf8'), 'changed\n');
    app.stdin.write('\x1b');
    await until(() => !frame().includes('2 files in LFS'), 'the viewer to close');

    // A local remote has no lock server: the list is empty, and locking says why it failed.
    await type(app.stdin, '/lfs locks');
    app.stdin.write('\r');
    await until(() => frame().includes('Nothing is locked.'), 'the empty lock list');
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Nothing is locked.'), 'the list to close');
    app.stdin.write('L');
    await until(() => /git lfs lock y\.bin/.test(frame()) && /failed/i.test(frame()), 'the lock to fail with git lfs\'s reason');

    // Forcing a lock open asks first; no leaves it.
    await type(app.stdin, '/lfs unlock y.bin --force');
    app.stdin.write('\r');
    await until(() => frame().includes('Force the lock on y.bin open?'), 'the question');
    app.stdin.write('2');
    await until(() => !frame().includes('Force the lock on y.bin open?'), 'the question answered no');
    assert.doesNotMatch(frame(), /git lfs unlock/);

    // A changed file that holds a pointer (x.bin's) is marked as one.
    writeFileSync(join(dir, 'y.bin'), git('show', 'HEAD:x.bin') + '\n');
    app.stdin.write('r');
    await until(() => /M y\.bin\s+LFS pointer/.test(frame()), 'the pointer marked');
  } finally {
    app.unmount();
  }
});
