// /cleanup: the pure decision (what can go, and why), then the whole thing against real repositories.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { cleanupChoice, cleanupCount, cleanupOptions, cleanupText, planCleanup } from '../src/cleanup.js';
import { App } from '../src/ui/App.jsx';

const branch = (name, extra = {}) => ({ name, oid: `${name}-tip`, upstream: null, gone: false, ahead: 0, behind: 0, current: false, ...extra });
const wt = (path, extra = {}) => ({ path, head: `${path}-head`, branch: null, main: false, bare: false, locked: false, prunable: false, current: false, ...extra });

const facts = (over = {}) => ({
  branches: [
    branch('main', { current: true, upstream: 'origin/main' }),
    branch('merged'),
    branch('pushed', { upstream: 'origin/pushed' }),
    branch('gone', { upstream: 'origin/gone', gone: true }),
    branch('copied'),
    branch('wip'),
    branch('ahead', { upstream: 'origin/pushed', ahead: 1 }),
    branch('squashed', { upstream: 'origin/squashed', gone: true }),
  ],
  worktrees: [wt('/r', { main: true, current: true, branch: 'main' })],
  defaultBranch: 'main',
  merged: new Set(['main', 'merged']),
  // Tips that no remote branch has.
  localOnly: new Set(['main-tip', 'merged-tip', 'wip-tip', 'ahead-tip', 'squashed-tip']),
  changes: {},
  lostHeads: new Set(),
  ...over,
});

test('branches: merged, or with every commit on a remote, go; anything only here stays', () => {
  const plan = planCleanup(facts());
  assert.deepEqual(
    plan.branches.map((b) => [b.name, b.why]),
    [
      ['merged', 'merged into main'],
      ['pushed', 'everything is on origin/pushed'],
      ['gone', 'upstream gone, nothing unpushed'],
      ['copied', 'all its commits are on a remote'],
    ],
  );
  assert.deepEqual(
    plan.kept.map((k) => k.name),
    ['wip', 'ahead', 'squashed'],
  );
  assert.deepEqual(plan.worktrees, []);
});

test('branches: never the current or the default one, even when they qualify', () => {
  const plan = planCleanup(
    facts({
      branches: [branch('main', { upstream: 'origin/main' }), branch('dev', { current: true }), branch('merged')],
      merged: new Set(['main', 'dev', 'merged']),
      localOnly: new Set(),
    }),
  );
  assert.deepEqual(plan.branches.map((b) => b.name), ['merged']);
  assert.deepEqual(plan.kept, []);
});

test('without remotes, only merged branches go', () => {
  const plan = planCleanup(facts({ localOnly: null }));
  assert.deepEqual(plan.branches.map((b) => b.name), ['merged']);
});

test('worktrees: clean ones go and missing ones are pruned; changed, locked, main and open ones stay', () => {
  const plan = planCleanup(
    facts({
      branches: [branch('main', { current: true }), branch('a'), branch('b'), branch('c'), branch('d'), branch('e')],
      merged: new Set(['main', 'a', 'b', 'c', 'd']),
      localOnly: new Set(['main-tip', 'a-tip', 'b-tip', 'c-tip', 'd-tip', 'e-tip']),
      worktrees: [
        wt('/r', { main: true, current: true, branch: 'main' }),
        wt('/clean', { branch: 'a' }),
        wt('/dirty', { branch: 'b' }),
        wt('/locked', { branch: 'c', locked: true }),
        wt('/missing', { branch: 'd', prunable: true }),
        wt('/unpushed', { branch: 'e' }),
        wt('/detached'),
        wt('/lost'),
        wt('/unknown'),
      ],
      changes: { '/clean': 0, '/dirty': 2, '/unpushed': 0, '/detached': 0, '/lost': 0, '/unknown': null },
      lostHeads: new Set(['/lost-head']),
    }),
  );
  assert.deepEqual(
    plan.worktrees.map((w) => [w.path, w.prune, w.why]),
    [
      ['/clean', false, 'no changes'],
      ['/missing', true, "its folder is gone: prune git's record of it"],
      ['/unpushed', false, 'no changes; its branch e stays (unpushed commits)'],
      ['/detached', false, 'no changes'],
    ],
  );
  // A branch goes with its worktree; one checked out in a worktree that stays, stays.
  assert.deepEqual(
    plan.branches.map((b) => [b.name, b.worktree]),
    [
      ['a', '/clean'],
      ['d', '/missing'],
    ],
  );
  assert.deepEqual(
    plan.kept.map((k) => [k.name, k.why, k.at]),
    [
      ['/dirty', '2 uncommitted changes', undefined],
      ['/locked', 'locked', undefined],
      ['/lost', 'detached, with commits no branch has', undefined],
      ['/unknown', "couldn't read its status", undefined],
      ['b', 'merged into main', '/dirty'],
      ['c', 'merged into main', '/locked'],
      ['e', 'has commits that are only here', undefined],
    ],
  );

  // Branches only: the worktrees stay, so their branches do too.
  assert.deepEqual(cleanupChoice(plan, 'branches'), { worktrees: [], branches: [] });
  assert.deepEqual(cleanupChoice(plan, 'worktrees').branches, []);
  assert.equal(cleanupChoice(plan, 'all').branches.length, 2);
  // So there's no "only the branches" choice.
  assert.deepEqual(
    cleanupOptions(plan).map((o) => o.value),
    ['all', 'worktrees', null],
  );
});

test('the confirmation choices and counts', () => {
  const plan = planCleanup(
    facts({
      worktrees: [wt('/r', { main: true, current: true, branch: 'main' }), wt('/x', { branch: 'wip' })],
      changes: { '/x': 0 },
    }),
  );
  assert.equal(cleanupCount(plan), '4 branches and 1 worktree');
  assert.deepEqual(
    cleanupOptions(plan).map((o) => o.label),
    ['Yes, all 4 branches and 1 worktree', 'Only the 4 branches', 'Only the 1 worktree', 'No'],
  );
  assert.deepEqual(
    cleanupOptions({ worktrees: [], branches: [{ name: 'x' }], kept: [] }).map((o) => o.label),
    ['Yes, 1 branch', 'No'],
  );
});

test('the list says what goes, why, and what stays, with paths relative to the repository', () => {
  const root = resolve('/work/repo');
  const plan = planCleanup(
    facts({
      branches: [branch('main', { current: true }), branch('feat'), branch('wip')],
      merged: new Set(['main', 'feat']),
      localOnly: new Set(['wip-tip']),
      worktrees: [wt(root, { main: true, current: true, branch: 'main' }), wt(resolve('/work/repo-feat'), { branch: 'feat' })],
      changes: { [resolve('/work/repo-feat')]: 0 },
    }),
  );
  const sep = process.platform === 'win32' ? '\\' : '/';
  assert.equal(
    cleanupText(plan, root),
    [
      'Worktrees to remove (1)',
      `  ..${sep}repo-feat  no changes`,
      '',
      'Branches to delete (1)',
      `  feat  merged into main, after its worktree ..${sep}repo-feat`,
      '',
      'Staying (1)',
      '  wip  has commits that are only here',
    ].join('\n'),
  );
});

// End to end: a repository with a bare "origin", branches and worktrees of every kind, cleaned up through the UI.

const KEYS = { enter: '\r', esc: '\x1b' };
const base = mkdtempSync(join(tmpdir(), 'tiller-cleanup-'));
// On Windows a git still finishing for an unmounted app keeps the folder busy for a moment.
after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
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

test('/cleanup removes clean worktrees and deletes branches with nothing only here, and nothing else', async () => {
  const dir = join(base, 'repo');
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');

  // Starting git is slow on Windows, so the history is built in one `git fast-import`, and "origin"
  // is just its remote-tracking refs: what a push and a fetch would have left, without a server.
  const stream = [];
  let marks = 0;
  const data = (s) => `data ${Buffer.byteLength(s)}\n${s}`;
  const commit = (ref, name, parents = []) => {
    const mark = `:${++marks}`;
    stream.push(`commit ${ref}`, `mark ${mark}`, `committer T <t@example.com> ${1700000000 + marks} +0000`, data(name));
    if (parents[0]) stream.push(`from ${parents[0]}`, ...parents.slice(1).map((p) => `merge ${p}`));
    stream.push(`M 644 inline ${name.replace(/\W+/g, '-')}.txt`, data(`${name}\n`), '');
    return mark;
  };
  const ref = (name, mark) => stream.push(`reset ${name}`, `from ${mark}`, '');
  const first = commit('refs/heads/main', 'base');
  const off = (name, from = first) => commit(`refs/heads/${name}`, name, [from]);
  // merged: merged into main.
  let main = commit('refs/heads/main', "Merge branch 'merged'", [first, off('merged')]);
  // wtclean and wtdirty: merged too, and checked out in worktrees below.
  main = commit('refs/heads/main', 'Merge the worktree branches', [main, off('wtclean'), off('wtdirty')]);
  ref('refs/remotes/origin/main', main);
  // pushed: on its upstream, not merged anywhere.
  const pushed = off('pushed');
  ref('refs/remotes/origin/pushed', pushed);
  // ahead: tracks origin/pushed, with a commit of its own.
  off('ahead', pushed);
  // gone: its upstream was deleted, but its commits are still on another remote branch.
  ref('refs/remotes/origin/keep', off('gone'));
  // squashed: its upstream was deleted and its commits are nowhere else, as after a squash merge.
  off('squashed');
  // wip, wtwip and wtlost: never pushed.
  for (const b of ['wip', 'wtwip', 'wtlost']) off(b);
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input: `${stream.join('\n')}\n` });
  const upstream = (b) => `[branch "${b}"]\n\tremote = origin\n\tmerge = refs/heads/${b === 'ahead' ? 'pushed' : b}\n`;
  appendFileSync(
    join(dir, '.git', 'config'),
    '[core]\n\tautocrlf = false\n[user]\n\tname = T\n\temail = t@example.com\n' +
      '[remote "origin"]\n\turl = ../origin.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' +
      ['main', 'pushed', 'ahead', 'gone', 'squashed'].map(upstream).join(''),
  );
  git('reset', '-q', '--hard');
  git('worktree', 'add', '-q', '../repo-clean', 'wtclean');
  git('worktree', 'add', '-q', '../repo-dirty', 'wtdirty');
  git('worktree', 'add', '-q', '../repo-wip', 'wtwip');
  git('worktree', 'add', '-q', '../repo-missing', 'wtlost');
  writeFileSync(join(base, 'repo-dirty', 'notes.txt'), 'not committed\n');
  rmSync(join(base, 'repo-missing'), { recursive: true, force: true });

  const branches = () => git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();
  const worktrees = () => {
    try {
      return git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).split('/').pop()).sort();
    } catch {
      return null; // read while Tiller is deleting files: "not yet"
    }
  };
  const all = branches();

  process.env.TILLER_HOME = join(base, 'home');
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Merge the worktree branches'), 'the graph');

    // C in Branches lists what would go, and "No" leaves everything alone.
    app.stdin.write('3');
    await until(() => frame().includes('Local ('), 'the Branches view');
    app.stdin.write('C');
    await until(() => frame().includes('Delete 4 branches and 3 worktrees with nothing of yours on them?'), 'the confirmation');
    const list = frame();
    assert.match(list, /Worktrees to remove \(3\)/);
    assert.match(list, /repo-clean\s+no changes/);
    assert.match(list, /repo-wip\s+no changes; its branch wtwip stays \(unpushed commits\)/);
    assert.match(list, /repo-missing\s+its folder is gone: prune git's record of it; its branch wtlost stays/);
    assert.match(list, /Branches to delete \(4\)/);
    assert.match(list, /merged\s+merged into main/);
    assert.match(list, /4\. No/);
    app.stdin.write('4');
    await until(() => !frame().includes('Delete 4 branches'), 'the dialog to close');
    await until(() => !frame().includes('Worktrees to remove'), 'the list to close');
    assert.deepEqual(branches(), all);
    assert.equal(worktrees().length, 5);

    // /cleanup, all of it.
    app.stdin.write('/');
    await type(app.stdin, 'cleanup');
    await until(() => frame().includes('/cleanup'), 'the typed command');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Delete 4 branches and 3 worktrees'), 'the confirmation again');
    app.stdin.write('1');
    await until(() => frame().includes('Cleaned up 4 branches and 3 worktrees'), 'the report');
    assert.deepEqual(branches(), ['ahead', 'main', 'squashed', 'wip', 'wtdirty', 'wtlost', 'wtwip']);
    assert.deepEqual(worktrees(), ['repo', 'repo-dirty']);
    assert.match(frame(), /Deleted gone, merged, pushed, wtclean/);

    // Nothing left that could go.
    app.stdin.write('/');
    await type(app.stdin, 'cleanup');
    await until(() => frame().includes('/cleanup'), 'the typed command');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Nothing to clean up'), 'the note that nothing is left');
  } finally {
    app.unmount();
  }
});
