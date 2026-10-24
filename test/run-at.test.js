// w in the graph (/run-at): an old commit in a detached worktree of its own, Bosun's /move copied, and
// /cleanup offering to remove it. The pure parts, then through the real UI against a throwaway repository.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { planCleanup, runAtHash } from '../src/cleanup.js';
import { shareLine } from '../src/family.js';
import { runAtPath } from '../src/prflow.js';
import { App } from '../src/ui/App.jsx';

const H = 'abcdef1234567890abcdef1234567890abcdef12';

test('run-at worktrees: where they go, and how /cleanup knows them', () => {
  const main = join('/', 'w', 'shop');
  const path = runAtPath(main, H);
  assert.equal(path, join('/', 'w', 'shop-at-abcdef1'));
  assert.equal(runAtHash({ path, head: H, branch: null }, main), 'abcdef1');
  assert.equal(runAtHash({ path, head: H, branch: 'x' }, main), null, 'on a branch: not one of them');
  assert.equal(runAtHash({ path, head: 'f'.repeat(40), branch: null }, main), null, 'moved to another commit');
  assert.equal(runAtHash({ path: join('/', 'w', 'other-at-abcdef1'), head: H, branch: null }, main), null);
  const worktrees = [
    { path: main, main: true, head: H, branch: 'main' },
    { path, head: H, branch: null },
    { path: runAtPath(main, 'f'.repeat(40)), head: 'f'.repeat(40), branch: null },
  ];
  const plan = planCleanup({ branches: [], worktrees, changes: { [path]: 0, [worktrees[2].path]: 2 } });
  assert.deepEqual(plan.worktrees.map((w) => w.why), ['made by /run-at for abcdef1, no changes']);
  assert.match(plan.kept[0].why, /made by \/run-at for fffffff, but has 2 uncommitted changes/);
});

let base;
let dir;
let lastApp = null;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const git = (...args) => run(dir, ...args);

before(() => {
  // Its long name: Windows' temp folder is a short (8.3) one, which git, and so Splice, gives in full.
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'splice-runat-')));
  dir = join(base, 'shop');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'package.json'), '{"scripts":{"dev":"node server.js"}}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'The old way');
  writeFileSync(join(dir, 'server.js'), 'new\n');
  git('add', '.');
  git('commit', '-q', '-m', 'The new way');
});

after(() => removeTemp(base));

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let ok = false;
    try {
      ok = check();
    } catch {
      // not yet
    }
    if (ok) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

test('w on an old commit: its own worktree, Bosun\'s /move copied; /cleanup removes it', async () => {
  const copied = [];
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, copy: (t) => copied.push(t) }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const old = git('rev-parse', 'HEAD~1');
  const wt = join(base, `shop-at-${old.slice(0, 7)}`);
  try {
    await until(() => /❯.*The new way/.test(frame()), 'the graph');
    app.stdin.write('j');
    await until(() => /❯.*The old way/.test(frame()), 'the old commit');
    app.stdin.write('w');
    await until(() => existsSync(wt) && copied.length === 1, 'the worktree and the copy');
    assert.equal(copied[0], shareLine('move', [wt]));
    assert.equal(run(wt, 'rev-parse', 'HEAD'), old);
    await until(() => frame().replace(/\s+/g, ' ').includes("Copied for Bosun: paste it into Bosun's prompt"), 'what was copied');
    assert.equal(git('status', '--porcelain'), '', 'the repository as it was');

    // Again: the same worktree, and the line copied again.
    app.stdin.write('w');
    await until(() => copied.length === 2, 'copied again');

    app.stdin.write('/');
    await until(() => frame().includes('> /'), 'the prompt');
    app.stdin.write('cleanup');
    await until(() => frame().includes('> /cleanup'), 'typed');
    app.stdin.write('\r');
    await until(() => frame().includes('Delete 1 worktree with nothing of yours on them?'), 'the cleanup question');
    assert.match(frame(), new RegExp(`made by /run-at for ${old.slice(0, 7)}, no changes`));
    app.stdin.write('1');
    await until(() => !existsSync(wt), 'the worktree gone');
  } finally {
    app.unmount();
  }
});
