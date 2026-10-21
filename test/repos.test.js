// The Repos view: F fetches every listed repository, through the real UI against throwaway ones with bare
// remotes (one gone, one slow), plus the pure part.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { fetchError } from '../src/repos.js';
import { App } from '../src/ui/App.jsx';

test("a fetch's failure in a few words: git's first error line, without fatal:, a folder it names cut to its last part", () => {
  assert.equal(
    fetchError("fatal: '/x/gone.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights"),
    "'gone.git' does not appear to be a git repository",
  );
  assert.equal(fetchError("fatal: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\r\\nowhere.git\\' does not appear to be a git repository"), "'nowhere.git' does not appear to be a git repository");
  assert.equal(fetchError("fatal: '\\\\server\\share\\repo.git' does not appear to be a git repository"), "'repo.git' does not appear to be a git repository");
  assert.equal(fetchError("fatal: repository 'https://example.invalid/a/b.git/' not found"), "repository 'https://example.invalid/a/b.git/' not found", 'a URL stays whole');
  assert.equal(fetchError("fatal: couldn't find remote ref 'main'"), "couldn't find remote ref 'main'");
  assert.equal(fetchError('warning: redirecting\nerror: could not fetch origin'), 'could not fetch origin');
  assert.equal(fetchError(''), 'the fetch failed');
});

let base;
let lastApp = null;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A repository in `base/<name>` with one commit, cloned from a bare `<name>.git` beside it. */
function repoWithRemote(name) {
  const bare = join(base, 'remotes', `${name}.git`);
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const seed = join(base, 'seeds', name);
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.name', 'Test');
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'First');
  git(seed, 'push', '-q', bare, 'main');
  const dir = join(base, 'work', name);
  git(base, 'clone', '-q', bare, dir);
  return { dir, bare, seed };
}

let ahead;
let gone;
let slow;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-repos-'));
  process.env.SPLICE_HOME = join(base, 'home');
  // `alpha`: the remote has moved on by two commits since it was cloned.
  ahead = repoWithRemote('alpha');
  for (const n of ['2', '3']) {
    writeFileSync(join(ahead.seed, `${n}.txt`), `${n}\n`);
    git(ahead.seed, 'add', '.');
    git(ahead.seed, 'commit', '-q', '-m', `Commit ${n}`);
  }
  git(ahead.seed, 'push', '-q', ahead.bare, 'main');
  // `beta`: its remote is gone.
  gone = repoWithRemote('beta');
  git(gone.dir, 'remote', 'set-url', 'origin', join(base, 'remotes', 'nowhere.git'));
  // `gamma`: its remote answers slowly, long enough to cancel.
  slow = repoWithRemote('gamma');
});

after(() => removeTemp(base));

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

const start = () => {
  lastApp = render(React.createElement(App, { initialPath: join(base, 'work'), config: { recent: [], roots: [], history: [] } }));
  return lastApp;
};
const row = (frame, name) => frame.split('\n').find((l) => l.includes(` ${name} `)) ?? '';

test('F fetches every listed repository; each row then shows how far behind it is, or why it could not be fetched', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => ['alpha', 'beta', 'gamma'].every((n) => row(frame(), n).includes('✓')), 'the repositories and their summaries');
    assert.doesNotMatch(row(frame(), 'alpha'), /↓/, 'nothing fetched yet');
    app.stdin.write('F');
    await until(() => frame().includes('Fetched 2 of 3 repositories'), 'the fetch to finish');
    assert.match(row(frame(), 'alpha'), /↓2/);
    assert.match(row(frame(), 'beta'), /✗ .*nowhere\.git/);
    assert.doesNotMatch(row(frame(), 'gamma'), /✗/);
    assert.match(frame(), /beta: .*nowhere\.git/, 'the activity line says which failed');
  } finally {
    app.unmount();
  }
});

test('esc stops fetching them all; the repositories still being fetched go back to how they were', async () => {
  git(slow.dir, 'config', 'remote.origin.uploadpack', 'sleep 3; git-upload-pack');
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => row(frame(), 'gamma').includes('✓'), 'the repositories');
    app.stdin.write('F');
    await until(() => row(frame(), 'gamma').includes('fetching…') && frame().includes('fetched 2 of 3'), 'gamma still fetching');
    app.stdin.write('\x1b');
    await until(() => frame().includes('Cancelled') && !frame().includes('fetching…'), 'the cancel');
    assert.doesNotMatch(row(frame(), 'gamma'), /✗/);
    assert.match(row(frame(), 'alpha'), /↓2/);
  } finally {
    app.unmount();
    git(slow.dir, 'config', '--unset', 'remote.origin.uploadpack');
  }
});
