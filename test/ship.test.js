// /ship: push, open the pull request (Claude drafting it) and turn on auto-merge in one go; then, once the
// stub host says it's merged, finishing it: switch to main, pull, delete the branch. A real bare repository
// is the remote; a stub stands in for the PR host and one for Claude, so nothing goes online.
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

let base;
let dir;
let origin;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const git = (...args) => run(dir, ...args);
const server = (...args) => run(origin, ...args);

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-ship-'));
  dir = join(base, 'repo');
  origin = join(base, 'origin.git');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  run(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let ok = false;
    try {
      ok = check();
    } catch {
      // git read mid-change: not yet
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

async function command(app, text) {
  app.stdin.write('/');
  await until(() => app.lastFrame().includes('> /'), 'the prompt');
  await type(app.stdin, text);
  await until(() => app.lastFrame().includes(`> /${text}`), `/${text} typed`);
  app.stdin.write('\r');
}

const config = () => JSON.parse(readFileSync(join(base, 'home', 'config.json'), 'utf8'));

// The PR host: open and merged PRs by number, recording what Splice asks of it.
function stubHost(calls, prs) {
  return () => ({
    kind: 'github',
    name: 'GitHub',
    signIn: 'gh auth login',
    remoteName: 'origin',
    mergeMethods: ['squash', 'merge', 'rebase'],
    list: async () => [...prs.values()].filter((p) => p.state === 'open'),
    merged: async () => [...prs.values()].filter((p) => p.state === 'merged'),
    detail: async () => ({ reviewers: [], checks: [], comments: [], conflicts: false }),
    pr: async (id) => {
      calls.push(['pr', id]);
      if (!prs.has(id)) throw new Error('Not Found');
      return prs.get(id);
    },
    create: async (opts) => {
      calls.push(['create', opts]);
      const id = 10 + prs.size;
      prs.set(id, { id, label: `#${id}`, title: opts.title, source: opts.source, target: opts.target, head: run(dir, 'rev-parse', opts.source), url: `https://example.invalid/pull/${id}`, state: 'open', author: 'me', mine: true, reviewMe: false, draft: false, time: 0, review: { text: 'No reviews', tone: 'none' }, checks: null, reviewers: [], description: opts.body, commits: [] });
      return `https://example.invalid/pull/${id}\n`;
    },
    merge: async (pr, opts) => calls.push(['merge', pr.id, opts]),
    defaultBranch: async () => 'main',
  });
}

// The server merges a PR: main moves to `to` (the branch itself, or a squashed commit), and the branch goes.
function mergeOnServer(pr, to) {
  server('update-ref', 'refs/heads/main', to);
  server('update-ref', '-d', `refs/heads/${pr.source}`);
  pr.state = 'merged';
  pr.mergeCommit = to;
}

test('/ship pushes, opens the PR Claude drafts and turns on auto-merge; once merged, the PR list offers to finish', async () => {
  git('switch', '-q', '-c', 'feature');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Add b');
  const calls = [];
  const prs = new Map();
  const asked = [];
  const askClaude = async (prompt, opts) => {
    asked.push({ prompt, ...opts });
    return 'Add the b file\n\nIt adds **b**.';
  };
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, makeHost: stubHost(calls, prs), askClaude }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Add b'), 'the graph');
    await command(app, 'ship');
    await until(() => frame().includes('How should GitHub merge feature into main?'), 'the merge method question');
    app.stdin.write('1');
    await until(() => frame().includes('Ship feature into main?') && frame().includes('Merge another way than squash'), 'the plan');
    // Wrapped, as Markdown.
    const plan = frame().replace(/[│\s]+/g, ' ');
    assert.match(plan, /1\. Push feature to origin, setting its upstream/);
    assert.match(plan, /2\. Open a pull request from feature into main on GitHub, with the title and description Claude drafts/);
    assert.match(plan, /3\. Turn on auto-merge \(Squash and merge\)/);
    app.stdin.write('1');
    await until(() => calls.some((c) => c[0] === 'merge'), 'auto-merge');
    await until(() => frame().includes('Shipped feature: #10 merges into main'), 'the note');
    assert.equal(server('rev-parse', 'refs/heads/feature'), git('rev-parse', 'feature'), 'pushed');
    assert.equal(git('rev-parse', '--abbrev-ref', 'feature@{upstream}'), 'origin/feature');
    const created = calls.find((c) => c[0] === 'create')[1];
    assert.deepEqual(created, { title: 'Add the b file', body: 'It adds **b**.', source: 'feature', target: 'main' });
    assert.match(asked[0].prompt, /merges the branch feature into main/);
    assert.match(asked[0].input, /Add b[\s\S]*\+b/);
    assert.deepEqual(calls.find((c) => c[0] === 'merge'), ['merge', 10, { method: 'squash', deleteBranch: true, auto: true }]);
    const saved = config();
    assert.deepEqual(saved.shipped.map((e) => [e.branch, e.id, e.target]), [['feature', 10, 'main']]);
    assert.deepEqual(Object.values(saved.shipMethods), ['squash']);

    // Merged on the server (fast-forward here); the PRs view's list no longer has it.
    mergeOnServer(prs.get(10), git('rev-parse', 'feature'));
    app.stdin.write('6');
    await until(() => frame().includes('#10 "Add the b file" was merged into main. Finish feature?'), 'the offer to finish');
    assert.match(frame(), /Switch to main, pull main, delete feature, as \/cleanup would/);
    app.stdin.write('1');
    await until(() => git('branch', '--show-current') === 'main' && !git('branch', '--list', 'feature'), 'on main, feature deleted');
    await until(() => frame().includes('Deleted feature'), 'the report');
    assert.equal(git('rev-parse', 'main'), server('rev-parse', 'main'), 'main pulled');
    assert.deepEqual(config().shipped, []);
  } finally {
    app.unmount();
  }
});

test('/ship again after a squash merge finishes it; and /cleanup does so for a shipped branch you are on', async () => {
  const calls = [];
  const prs = new Map();
  // Remembered from the test before: no question about how to merge.
  const saved = config();
  lastApp = render(React.createElement(App, { initialPath: dir, config: saved, makeHost: stubHost(calls, prs) }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  // Squash-merges `branch` on the server: a new commit on main with its tree.
  const squash = (pr) => {
    const tree = git('rev-parse', `${pr.source}^{tree}`);
    const commit = run(origin, 'commit-tree', tree, '-p', server('rev-parse', 'main'), '-m', `${pr.title} (${pr.label})`);
    mergeOnServer(pr, commit);
  };
  try {
    await until(() => frame().includes('Add b'), 'the graph');
    for (const [name, how] of [['two', 'ship'], ['three', 'cleanup']]) {
      git('switch', '-q', '-c', name, 'main');
      writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
      git('add', '.');
      git('commit', '-q', '-m', `Add ${name}`);
      await until(() => frame().includes(`⎇ ${name}`), `on ${name}`);
      await command(app, 'ship');
      await until(() => frame().includes(`Ship ${name} into main?`), 'the plan');
      // Claude isn't here: the title comes from the commits.
      assert.match(frame().replace(/[│\s]+/g, ' '), /titled after the latest commit/);
      app.stdin.write('1');
      await until(() => calls.filter((c) => c[0] === 'merge').length === (name === 'two' ? 1 : 2), 'auto-merge');
      const pr = [...prs.values()].find((p) => p.source === name);
      assert.equal(pr.title, `Add ${name}`);
      if (name === 'two') {
        // Still open: /ship again keeps the pull request, with nothing new to push.
        await command(app, 'ship');
        await until(() => frame().includes('Ship two into main?'), 'the plan again');
        const plan = frame().replace(/[│\s]+/g, ' ');
        assert.match(plan, /Nothing to push: origin has every commit of two/);
        assert.match(plan, new RegExp(`Use ${pr.label} "Add two", already open on GitHub`));
        app.stdin.write('3');
        await until(() => !frame().includes('Ship two into main?'), 'the question gone');
      }
      squash(pr);
      await command(app, how);
      await until(() => frame().includes(`${pr.label} "Add ${name}" was merged into main. Finish ${name}?`), 'the offer to finish');
      app.stdin.write('1');
      await until(() => git('branch', '--show-current') === 'main' && !git('branch', '--list', name), `${name} deleted`);
      assert.equal(git('rev-parse', 'main'), server('rev-parse', 'main'));
      if (how === 'cleanup') await until(() => frame().includes('Nothing to clean up'), 'the rest of the cleanup');
    }
    assert.deepEqual(config().shipped, []);
    assert.ok(!calls.some((c) => c[0] === 'merge' && c[2].method !== 'squash'));
  } finally {
    app.unmount();
  }
});
