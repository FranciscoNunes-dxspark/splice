// Branches compared with the default branch, and their pull requests: the pure parts, then the real UI
// against a throwaway repository (a stub stands in for GitHub, so nothing goes online).
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
import { prsByBranch } from '../src/hosting.js';
import { defaultBranch, isDefaultBranch, parseAheadBehind, parseCommits, parseRefs } from '../src/parse.js';
import { compareRefs } from '../src/repo.js';

const refs = (local, remote = [], remoteHeads = {}) => ({
  local: local.map((b) => (typeof b === 'string' ? { name: b, upstream: null } : b)),
  remote: remote.map((name) => ({ name, remote: name.split('/')[0] })),
  tags: [],
  remoteHeads,
});

test("refs: a remote's HEAD is kept as its default branch, not listed", () => {
  const line = (...f) => f.join('\x1f');
  const raw = [
    line('refs/heads/main', 'a1', 'origin/main', '', '*', '100', 'Top', ''),
    line('refs/remotes/origin/HEAD', 'a1', '', '', ' ', '100', 'Top', 'refs/remotes/origin/trunk'),
    line('refs/remotes/origin/trunk', 'a1', '', '', ' ', '100', 'Top', ''),
  ].join('\n');
  const parsed = parseRefs(raw);
  assert.deepEqual(parsed.remote.map((b) => b.name), ['origin/trunk']);
  assert.deepEqual(parsed.remoteHeads, { origin: 'origin/trunk' });
  assert.equal(parsed.local[0].subject, 'Top');
});

test('default branch: remote HEAD (origin first), then main or master on a remote, then locally', () => {
  assert.deepEqual(defaultBranch(refs(['main'], ['up/dev', 'origin/trunk'], { up: 'up/dev', origin: 'origin/trunk' }), ['up', 'origin']), {
    name: 'trunk',
    ref: 'origin/trunk',
  });
  // A HEAD pointing at a branch that's gone doesn't count.
  assert.deepEqual(defaultBranch(refs(['main'], ['origin/master'], { origin: 'origin/gone' }), ['origin']), { name: 'master', ref: 'origin/master' });
  assert.deepEqual(defaultBranch(refs(['dev', 'master']), []), { name: 'master', ref: 'master' });
  assert.equal(defaultBranch(refs(['dev']), []), null);

  const def = { name: 'main', ref: 'origin/main' };
  assert.equal(isDefaultBranch(def, { name: 'main' }, 'local'), true);
  assert.equal(isDefaultBranch(def, { name: 'origin/main' }, 'remote'), true);
  assert.equal(isDefaultBranch(def, { name: 'up/main' }, 'remote'), false);
  assert.equal(isDefaultBranch(def, { name: 'main' }, 'tag'), false);
  assert.equal(isDefaultBranch(null, { name: 'main' }, 'local'), false);
});

test('ahead/behind counts and commit lines', () => {
  assert.deepEqual(parseAheadBehind('3\t2\n'), { ahead: 2, behind: 3 });
  assert.deepEqual(parseAheadBehind(''), { ahead: 0, behind: 0 });
  assert.deepEqual(parseCommits('f00ba12345\x1ff00ba12\x1f100\x1fFix it\n'), [{ full: 'f00ba12345', hash: 'f00ba12', time: 100, subject: 'Fix it' }]);
});

test('pull requests match branches by their source: remote branches, tracking and same-named local ones', () => {
  const pr = (id, source) => ({ id, label: `#${id}`, source });
  const prs = [pr(1, 'feature'), pr(2, 'feature'), pr(3, 'renamed-on-server'), pr(4, 'elsewhere')];
  const r = refs(
    ['feature', { name: 'local-name', upstream: 'origin/renamed-on-server' }, { name: 'elsewhere', upstream: 'fork/elsewhere' }, 'nothing'],
    ['origin/feature', 'fork/feature', 'origin/renamed-on-server'],
  );
  const map = prsByBranch(prs, r, 'origin');
  assert.deepEqual(
    [...map].map(([k, p]) => [k, p.id]).sort(),
    [
      ['local:feature', 1],
      ['local:local-name', 3],
      ['remote:origin/feature', 1],
      ['remote:origin/renamed-on-server', 3],
    ],
  );
  assert.equal(prsByBranch([], r, 'origin').size, 0);
  assert.equal(prsByBranch(null, r, 'origin').size, 0);
});

const KEYS = { down: '\x1b[B', enter: '\r', esc: '\x1b' };

let base;
let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-branches-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
  git('switch', '-q', '-c', 'feature');
  writeFileSync(join(dir, 'b.txt'), 'feature line\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Feature work');
  git('switch', '-q', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  git('commit', '-q', '-am', 'Main moves on');
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

function start(props = {}) {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, ...props }));
  return lastApp;
}

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('comparing reads the counts, the commits only the branch has, and the rest of its history', async () => {
  const c = await compareRefs(dir, 'feature', 'main');
  assert.equal(c.ahead, 1);
  assert.equal(c.behind, 1);
  assert.deepEqual(c.commits.map((x) => x.subject), ['Feature work']);
  assert.deepEqual(c.history.map((x) => x.subject), ['First commit']);
});

test('Branches compares the selected branch with the default branch, and D shows what it adds', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Main moves on'), 'the graph');
    app.stdin.write('3');
    await until(() => frame().includes('Local (2)'), 'the Branches view');
    // The cursor starts on feature (branches are listed by name).
    await until(() => frame().includes('↑1 ahead · ↓1 behind main'), 'feature compared with main');
    assert.match(frame(), /Feature work/);
    assert.match(frame(), /Before that/);
    // No remote: no PR column, and no errors about one.
    assert.doesNotMatch(frame(), /#\d/);

    app.stdin.write('D');
    await until(() => frame().includes('main...feature') && frame().includes('+feature line'), 'the diff of what feature adds');
    assert.doesNotMatch(frame(), /^\+two/m);
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Local (2)'), 'back in Branches');

    app.stdin.write('j');
    await until(() => /❯ ● main/.test(frame()), 'the cursor on main');
    await until(() => !frame().includes('ahead ·') && frame().includes('Main moves on'), "main's own history");
    app.stdin.write('D');
    await until(() => frame().includes('main is the default branch itself'), 'D on the default branch to explain itself');
    app.stdin.write('o');
    await until(() => frame().includes("remote isn't on GitHub or Azure DevOps"), 'o without a host');

    app.stdin.write('/');
    await type(app.stdin, 'compare main feature');
    await until(() => frame().includes('/compare main feature'), 'the typed command');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('feature...main') && frame().includes('+two'), 'the diff of what main adds to feature');
    app.stdin.write(KEYS.esc);
  } finally {
    app.unmount();
  }
});

test("a branch's pull request shows next to it, from the same list the PRs view uses", async () => {
  const pr = {
    id: 12,
    label: '#12',
    title: 'Add the feature',
    author: 'someone',
    mine: false,
    reviewMe: false,
    source: 'feature',
    target: 'main',
    draft: false,
    url: 'https://example.invalid/pr/12',
    time: Date.now() / 1000,
    review: { text: 'Approved', tone: 'good' },
    checks: { passed: 2, failed: 0, pending: 0 },
    reviewers: [],
    description: '',
  };
  let lists = 0;
  const makeHost = () => ({
    kind: 'github',
    name: 'GitHub',
    signIn: 'gh auth login',
    remoteName: 'origin',
    list: async () => {
      lists++;
      return [pr];
    },
    detail: async () => ({ reviewers: [], checks: [], comments: [], conflicts: false }),
  });
  // The list is fetched again each new minute (usePrList), so a run that crosses one may see a second fetch.
  const minute = () => Math.floor(Date.now() / 60000);
  const firstMinute = minute();
  const app = start({ makeHost });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Main moves on'), 'the graph');
    app.stdin.write('3');
    await until(() => /feature\s+#12\s+✓/.test(frame()), 'the PR column');
    await until(() => frame().includes('#12 Approved') && frame().includes('Add the feature'), 'the PR in the right-hand pane');
    assert.match(frame(), /o open PR/);

    app.stdin.write('6');
    await until(() => frame().includes('Add the feature') && frame().includes('Pull requests'), 'the PRs view');
    app.stdin.write('3');
    await until(() => frame().includes('#12 Approved'), 'Branches again');
    assert.ok(lists === 1 || (lists === 2 && minute() !== firstMinute), `the PR list is fetched once for both views (it was fetched ${lists} times)`);
  } finally {
    app.unmount();
  }
});
