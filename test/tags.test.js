// Tags in the Branches view: pushing one, a GitHub or GitLab release (a stub stands in for gh and glab), and deleting one here
// and on the remote, against a throwaway repository with a bare one as its origin.
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
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-tags-'));
  dir = join(base, 'repo');
  origin = join(base, 'origin.git');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  git('tag', 'v1.0');
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

const remoteTags = () => execFileSync('git', ['ls-remote', '--tags', origin], { encoding: 'utf8' });

test('a tag in Branches: u pushes it, R makes a release, d deletes it here and on origin', async () => {
  const releases = [];
  const makeHost = () => ({
    kind: 'github',
    name: 'GitHub',
    signIn: 'gh auth login',
    remoteName: 'origin',
    list: async () => [],
    createRelease: async (opts) => {
      releases.push(opts);
      return 'https://example.invalid/releases/v1.0';
    },
  });
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, makeHost }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    app.stdin.write('3');
    await until(() => frame().includes('Tags (1)'), 'the Branches view with its tags');
    app.stdin.write('G');
    await until(() => /❯\s+v1\.0/.test(frame()) && frame().includes('u push · R release'), 'the cursor on the tag');
    app.stdin.write('u');
    await until(() => remoteTags().includes('refs/tags/v1.0'), 'the tag on origin');

    app.stdin.write('R');
    await until(() => frame().includes('Create a GitHub release for v1.0?'), 'the release question');
    app.stdin.write('2');
    await until(() => releases.length === 1, 'the release');
    assert.deepEqual(releases[0], { tag: 'v1.0', title: '', draft: true });

    app.stdin.write('d');
    await until(() => frame().includes('Delete the tag v1.0?') && frame().includes('Delete it here and on origin'), 'the delete question');
    app.stdin.write('2');
    await until(() => !remoteTags().includes('v1.0') && git('tag', '--list') === '', 'the tag gone in both places');
    await until(() => !frame().includes('Tags ('), 'the Tags section gone');
  } finally {
    app.unmount();
  }
});

test('a GitLab release: published, as GitLab has no drafts, with notes Splice writes', async () => {
  git('tag', 'v2.0');
  const releases = [];
  const makeHost = () => ({
    kind: 'gitlab',
    name: 'GitLab',
    signIn: 'glab auth login',
    remoteName: 'origin',
    list: async () => [],
    releaseDrafts: false,
    releaseNotesBy: 'The notes list the commits since the tag before it.',
    createRelease: async (opts) => {
      releases.push(opts);
      return 'https://example.invalid/-/releases/v2.0';
    },
  });
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, makeHost }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    const command = async (text) => {
      app.stdin.write('/');
      await until(() => frame().includes('> /'), 'the prompt');
      for (const ch of text) {
        app.stdin.write(ch);
        await new Promise((r) => setTimeout(r, 5));
      }
      await until(() => frame().includes(`> /${text}`), text);
      app.stdin.write('\r');
    };
    await command('release v2.0 --draft');
    await until(() => frame().includes('GitLab has no draft releases'), 'drafts refused');
    await command('release v2.0 Two');
    await until(() => frame().includes('Create a GitLab release for v2.0 called "Two"?') && frame().includes('the commits since the tag before it'), 'the release question');
    assert.ok(!frame().includes('Save it as a draft'), 'no draft to offer');
    app.stdin.write('1');
    await until(() => releases.length === 1 && remoteTags().includes('refs/tags/v2.0'), 'the release, after pushing the tag');
    assert.deepEqual(releases[0], { tag: 'v2.0', title: 'Two', draft: false });
  } finally {
    app.unmount();
  }
});
