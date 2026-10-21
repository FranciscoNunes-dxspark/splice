// /update-branch (B in Branches): rebasing the current branch onto the latest default branch, through
// the real UI against throwaway repositories whose "origin" is a bare one that a second clone pushes to.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { App } from '../src/ui/App.jsx';

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-update-branch-'));
  process.env.SPLICE_HOME = join(base, 'home');
});
after(() => removeTemp(base));

const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const commitIn = (cwd, file, text, message) => {
  writeFileSync(join(cwd, file), text);
  run(cwd, 'add', '.');
  run(cwd, 'commit', '-q', '-m', message);
};
const configure = (cwd) => {
  run(cwd, 'config', 'core.autocrlf', 'false');
  run(cwd, 'config', 'user.name', 'Test');
  run(cwd, 'config', 'user.email', 'test@example.com');
  run(cwd, 'config', 'commit.gpgsign', 'false');
};

/** `name/repo` with main pushed to a bare `name/origin.git`, and `name/other`, a clone of it that pushes `file` to main. */
function world(name) {
  const root = join(base, name);
  const dir = join(root, 'repo');
  const other = join(root, 'other');
  const origin = join(root, 'origin.git');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  run(dir, 'init', '-q', '-b', 'main');
  configure(dir);
  commitIn(dir, 'a.txt', 'one\n', 'First commit');
  run(dir, 'remote', 'add', 'origin', origin);
  run(dir, 'push', '-q', '-u', 'origin', 'main');
  run(dir, 'remote', 'set-head', 'origin', 'main');
  run(root, 'clone', '-q', origin, other);
  configure(other);
  const theirs = (file, text) => {
    commitIn(other, file, text, `Theirs: ${file}`);
    run(other, 'push', '-q', 'origin', 'main');
  };
  return { dir, git: (...args) => run(dir, ...args), theirs };
}

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let ok = false;
    try {
      ok = check();
    } catch {
      // A ref being replaced mid-rebase can briefly read as broken: not yet.
    }
    if (ok) return new Promise((r) => setTimeout(r, 100));
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

const command = async (app, text) => {
  app.stdin.write('/');
  await type(app.stdin, text);
  await until(() => app.lastFrame().includes(`/${text}`), `the typed /${text}`);
  app.stdin.write('\r');
};

function start(dir) {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  return lastApp;
}

test('B rebases a pushed branch onto the latest default branch, fetching it first, then offers the force push', async () => {
  const { dir, git, theirs } = world('pushed');
  git('switch', '-q', '-c', 'feature');
  commitIn(dir, 'f.txt', 'feature\n', 'Feature work');
  git('push', '-q', '-u', 'origin', 'feature');
  theirs('m.txt', 'main\n');
  const app = start(dir);
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Feature work'), 'the graph');
    app.stdin.write('3');
    await until(() => frame().includes('Local (2)'), 'the Branches view');
    app.stdin.write('B');
    await until(() => frame().includes('Rebase feature onto origin/main?'), 'the question', 15000);
    assert.match(frame(), /feature is already pushed\. No conflicts expected/);
    assert.match(frame(), /Replays 1 commit of feature on top of origin\/main/);
    assert.match(frame(), /Already pushed: feature \(origin\/feature\)/);
    // The fetch brought origin/main's new commit.
    assert.equal(git('log', '-1', '--format=%s', 'origin/main'), 'Theirs: m.txt');
    app.stdin.write('1');
    await until(() => frame().includes('Force-push feature?'), 'the offer to force-push', 15000);
    assert.equal(git('rev-parse', 'feature~1'), git('rev-parse', 'origin/main'));
    app.stdin.write('1');
    await until(() => git('rev-parse', 'origin/feature') === git('rev-parse', 'feature'), 'feature force-pushed', 15000);
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'feature');

    // z undoes the rebase, from the branch's reflog.
    await until(() => !frame().includes('Force-push feature?'), 'the question gone');
    app.stdin.write('z');
    await until(() => frame().includes('Undo the rebase of feature?'), 'the undo question');
    app.stdin.write('2');

    // On the default branch itself, B says what to do instead.
    await command(app, 'checkout main');
    await until(() => frame().includes('⎇ main'), 'main checked out');
    await command(app, 'update-branch');
    await until(() => frame().includes('main is the default branch itself'), 'the pointer to /sync');
  } finally {
    app.unmount();
  }
});

test('a stack of branches is rebased from its top with --update-refs, uncommitted changes kept, then back to the branch you were on', async () => {
  const { dir, git, theirs } = world('stack');
  git('switch', '-q', '-c', 's1');
  commitIn(dir, 's1.txt', '1\n', 'Stack one');
  git('switch', '-q', '-c', 's2');
  commitIn(dir, 's2.txt', '2\n', 'Stack two');
  git('switch', '-q', '-c', 's3');
  commitIn(dir, 's3.txt', '3\n', 'Stack three');
  git('switch', '-q', 's1');
  writeFileSync(join(dir, 'a.txt'), 'one\nwork in progress\n');
  theirs('m.txt', 'main\n');
  const app = start(dir);
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Stack three'), 'the graph');
    await command(app, 'update-branch');
    await until(() => frame().includes('Rebase the stack under s3 onto origin/main?'), 'the question', 15000);
    assert.match(frame(), /Replays 3 commits of s3, the top of the stack, on top of origin\/main/);
    assert.match(frame(), /Moves with it \(--update-refs\):/);
    assert.match(frame(), /│ {2}s1 /);
    assert.match(frame(), /│ {2}s2 /);
    assert.match(frame(), /Then switches back to s1\./);
    app.stdin.write('1');
    await until(() => git('rev-parse', '--abbrev-ref', 'HEAD') === 's1' && git('rev-parse', 's1~1') === git('rev-parse', 'origin/main'), 'the stack rebased, back on s1', 30000);
    assert.equal(git('rev-parse', 's2~1'), git('rev-parse', 's1'));
    assert.equal(git('rev-parse', 's3~1'), git('rev-parse', 's2'));
    await until(() => git('status', '--porcelain') === 'M a.txt', 'the uncommitted change back', 15000);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\nwork in progress\n');
  } finally {
    app.unmount();
  }
});

test('a branch under the current one stays unless --stack; a rebase that conflicts stops with the banner, and /abort puts it back', async () => {
  const { dir, git, theirs } = world('clash');
  git('switch', '-q', '-c', 'low');
  commitIn(dir, 'low.txt', 'low\n', 'Low work');
  git('switch', '-q', '-c', 'clash');
  commitIn(dir, 'a.txt', 'clash\n', 'Clashing work');
  theirs('a.txt', 'theirs\n');
  const was = git('rev-parse', 'clash');
  const app = start(dir);
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Clashing work'), 'the graph');
    await command(app, 'update-branch');
    await until(() => frame().includes('Rebase clash onto origin/main?'), 'the question', 15000);
    assert.match(frame(), /Expect conflicts in a\.txt/);
    assert.match(frame(), /low sits under clash and stays where it is: \/update-branch --stack moves it too\./);
    app.stdin.write('2');
    await until(() => !frame().includes('Rebase clash onto origin/main?'), 'the question gone');

    await command(app, 'update-branch --stack');
    await until(() => frame().includes('Rebase clash onto origin/main?'), 'the question with --stack', 15000);
    assert.match(frame(), /Moves with it \(--update-refs\):/);
    app.stdin.write('1');
    await until(() => frame().includes('Stopped with conflicts while rebasing') && existsSync(join(dir, '.git', 'rebase-merge')), 'the rebase stopped on conflicts', 15000);
    await command(app, 'abort');
    await until(() => frame().includes('Abort the rebase?'), 'the abort question');
    app.stdin.write('1');
    await until(() => !existsSync(join(dir, '.git', 'rebase-merge')) && git('rev-parse', 'clash') === was, 'clash back as it was', 15000);
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'clash');
  } finally {
    app.unmount();
  }
});
