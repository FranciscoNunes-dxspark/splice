// Where Tiller opens when started outside a repository.
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
let repo;
let elsewhere;
let lastApp = null;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'tiller-start-'));
  process.env.TILLER_HOME = join(base, 'home');
  repo = join(base, 'last-one');
  elsewhere = join(base, 'not-a-repo');
  mkdirSync(repo);
  mkdirSync(elsewhere);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'The only commit');
});

after(() => removeTemp(base));

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

const start = (props) => {
  lastApp = render(React.createElement(App, { initialPath: elsewhere, config: { recent: [], roots: [], history: [] }, ...props }));
  return lastApp;
};

test('started outside a repository with no path, it reopens the last repository still there', async () => {
  const gone = join(base, 'deleted-since');
  const app = start({ reopenLast: true, config: { recent: [gone, repo], roots: [], history: [] } });
  try {
    await until(() => app.lastFrame().includes('The only commit'), 'the last repository to open');
    assert.match(app.lastFrame(), /Opened last-one, the repository you had open last/);
  } finally {
    app.unmount();
  }
});

test('given a path, or with nothing to reopen, it shows the repositories instead', async () => {
  for (const props of [{ reopenLast: false, config: { recent: [repo], roots: [], history: [] } }, { reopenLast: true }]) {
    const app = start(props);
    try {
      await until(() => app.lastFrame().includes("isn't inside a git repository"), 'the repo picker');
      assert.doesNotMatch(app.lastFrame(), /The only commit/);
    } finally {
      app.unmount();
    }
  }
});
