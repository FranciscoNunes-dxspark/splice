// Remotes and upstreams: adding, renaming and removing a remote, pushing to a chosen one, and setting what a
// branch tracks, through the real UI against a throwaway repository with bare ones as its remotes.
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
let backup;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-remotes-'));
  dir = join(base, 'repo');
  origin = join(base, 'origin.git');
  backup = join(base, 'backup.git');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '--bare', backup]);
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
  git('branch', 'topic');
  git('push', '-q', 'origin', 'topic');
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

// Whether the prompt holds `text`: all of it, or its end, when a long path has scrolled the start out of the box.
const typed = (frame, text) => [...frame.matchAll(/│ > (.*?) *│/g)].some(([, shown]) => shown && text.endsWith(shown));

const command = async (app, text) => {
  app.stdin.write('/');
  await type(app.stdin, text);
  await until(() => typed(app.lastFrame(), `/${text}`), `the typed /${text}`);
  app.stdin.write('\r');
};

const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};

test('remotes: add one, push to it, rename and remove it; set and unset an upstream', async () => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    await command(app, `remote add backup ${backup}`);
    await until(() => git('remote') === 'backup\norigin', 'the remote added');

    app.stdin.write('3');
    await until(() => frame().includes('Local (2)'), 'the Branches view');
    app.stdin.write('M');
    await until(() => frame().includes('Remotes') && /❯ backup/.test(frame()), 'the remotes, backup first');
    app.stdin.write('p');
    await until(() => execFileSync('git', ['ls-remote', '--heads', backup], { encoding: 'utf8' }).includes('refs/heads/main'), 'main pushed to backup');
    assert.equal(git('rev-parse', '--abbrev-ref', 'main@{upstream}'), 'origin/main', 'a branch with an upstream keeps it');

    app.stdin.write('R');
    await until(() => frame().includes('> /remote rename backup'), 'the rename in the prompt');
    await type(app.stdin, 'mirror');
    app.stdin.write('\r');
    await until(() => git('remote') === 'mirror\norigin' && /❯ mirror/.test(frame()), 'the rename, shown in the list');

    app.stdin.write('x');
    await until(() => frame().includes('Remove the remote mirror?'), 'the remove question');
    app.stdin.write('1');
    await until(() => git('remote') === 'origin', 'the remote removed');
    app.stdin.write('\x1b');
    await until(() => frame().includes('Local (2)'), 'back in Branches');

    app.stdin.write('U');
    await until(() => frame().includes('> /upstream main origin/main'), 'U to start from the upstream as it is');
    app.stdin.write('\x15');
    await type(app.stdin, '/upstream topic origin/topic');
    app.stdin.write('\r');
    await until(() => tryGit('rev-parse', '--abbrev-ref', 'topic@{upstream}') === 'origin/topic', 'topic tracking origin/topic');
    await command(app, 'upstream --unset topic');
    await until(() => tryGit('rev-parse', '--abbrev-ref', 'topic@{upstream}') === null, 'the upstream unset');
  } finally {
    app.unmount();
  }
});
