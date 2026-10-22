// /changelog: Claude's release notes from the commits and merged pull requests since a tag, in the viewer
// (y copies them), and with --into-release the notes of the release /release makes. Stubs stand in for
// Claude and the PR host; a bare repository takes the tag.
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

let base;
let dir;
let origin;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (...args) => run(dir, ...args);
const commit = (file, message) => {
  writeFileSync(join(dir, file), `${message}\n`);
  git('add', file);
  git('commit', '-q', '-m', message);
};

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-changelog-'));
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
  commit('a.txt', 'First commit');
  git('tag', 'v1.0');
  commit('s.txt', 'Add search');
  commit('c.txt', 'Fix the crash on start');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main', 'v1.0');
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

async function command(app, text) {
  app.stdin.write('/');
  await until(() => app.lastFrame().includes('> /'), 'the prompt');
  for (const ch of text) {
    app.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
  await until(() => app.lastFrame().includes(`> /${text}`), `/${text} typed`);
  app.stdin.write('\r');
}

const NOTES = '## Features\n\n- Search (#4)\n\n## Fixes\n\n- No more crash on start';

test('/changelog writes notes since the latest tag, y copies them, and --into-release makes the release with them', async () => {
  const asked = [];
  const since = [];
  const releases = [];
  const copied = [];
  const askClaude = async (prompt, opts) => {
    asked.push({ prompt, ...opts });
    return NOTES;
  };
  const makeHost = () => ({
    kind: 'github',
    name: 'GitHub',
    signIn: 'gh auth login',
    remoteName: 'origin',
    list: async () => [],
    mergedSince: async (date) => {
      since.push(date);
      return [
        { id: 4, label: '#4', title: 'Search', author: 'ana', target: 'main', mergedAt: date },
        { id: 3, label: '#3', title: 'Into another branch', author: 'bo', target: 'release/1', mergedAt: date },
      ];
    },
    createRelease: async (opts) => {
      releases.push(opts);
      return 'https://example.invalid/releases/v1.1';
    },
  });
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, makeHost, askClaude, copy: (t) => copied.push(t) }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Fix the crash'), 'the graph');
    await command(app, 'changelog');
    await until(() => frame().includes('Release notes, since v1.0') && frame().includes('No more crash on start'), 'the notes');
    assert.match(frame(), /y copy/);
    assert.match(asked[0].prompt, /since v1\.0 up to main/);
    assert.match(asked[0].input, /Commits from v1\.0 to main, newest first \(2\):\n- \w+ Fix the crash on start\n- \w+ Add search/);
    assert.match(asked[0].input, /- #4 Search \(ana\)/);
    assert.doesNotMatch(asked[0].input, /Into another branch/, 'only the ones merged into this branch');
    assert.equal(since[0], git('log', '-1', '--format=%cI', 'v1.0'));
    app.stdin.write('y');
    await until(() => copied.length === 1, 'the copy');
    assert.equal(copied[0], NOTES);
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Release notes'), 'the viewer closed');

    git('tag', 'v1.1');
    await until(() => frame().includes('v1.1'), 'the new tag');
    await command(app, 'changelog --into-release v1.1');
    await until(() => frame().includes('Create a GitHub release for v1.1?') && frame().includes('The notes are'), 'the release question');
    assert.match(asked[1].input, /Commits from v1\.0 to v1\.1/, 'from the tag before the release');
    app.stdin.write('1');
    await until(() => releases.length === 1, 'the release');
    assert.deepEqual(releases[0], { tag: 'v1.1', title: '', draft: false, notes: NOTES });
    assert.match(run(origin, 'tag', '--list'), /v1\.1/, 'the tag pushed first');
  } finally {
    app.unmount();
  }
});

test('/changelog --into-release on Azure DevOps says it has no releases, before asking Claude', async () => {
  const asked = [];
  const makeHost = () => ({ kind: 'azure', name: 'Azure DevOps', signIn: 'az login', remoteName: 'origin', list: async () => [], createRelease: null });
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, makeHost, askClaude: async (p) => asked.push(p) }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Fix the crash'), 'the graph');
    await command(app, 'changelog --into-release v1.1');
    await until(() => frame().includes('Azure DevOps has no releases made from tags'), 'the refusal');
    assert.equal(asked.length, 0);
  } finally {
    app.unmount();
  }
});
