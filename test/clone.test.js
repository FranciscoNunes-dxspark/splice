// /clone and c in Repos, against throwaway repositories: a local folder stands in for the server (temp.js allows that).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { App } from '../src/ui/App.jsx';

let base;
let dir;
let server;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const init = (path) => {
  mkdirSync(path);
  run(path, 'init', '-q', '-b', 'main');
  run(path, 'config', 'core.autocrlf', 'false');
  run(path, 'config', 'user.name', 'Test');
  run(path, 'config', 'user.email', 'test@example.com');
  run(path, 'config', 'commit.gpgsign', 'false');
};

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-clone-'));
  process.env.SPLICE_HOME = join(base, 'home');
  server = join(base, 'upstream', 'tools.git');
  mkdirSync(join(base, 'upstream'));
  init(server);
  writeFileSync(join(server, 'tool.txt'), 'tool\n');
  run(server, 'add', '.');
  run(server, 'commit', '-q', '-m', 'The first tool');
  dir = join(base, 'app');
  init(dir);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  run(dir, 'add', '.');
  run(dir, 'commit', '-q', '-m', 'First commit');
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

async function type(app, text) {
  for (const ch of text) {
    app.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('/clone <url> clones next to the open repository, named after it, and opens the clone', async () => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    await type(app, `/clone ${server}`);
    app.stdin.write('\r');
    await until(() => frame().includes('The first tool'), "the clone's graph");
    assert.match(frame().split('\n')[0], /[\\/]tools\s*$/);
    assert.equal(run(join(base, 'tools'), 'log', '-1', '--format=%s'), 'The first tool');
  } finally {
    app.unmount();
  }
});

test('c in Repos fills in /clone; a folder given is used, and an existing one is left alone', async () => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    app.stdin.write('7');
    await until(() => frame().includes('Repositories'), 'the Repos view');
    app.stdin.write('c');
    await until(() => frame().includes('/clone '), '/clone in the prompt');
    await type(app, `${server} "my tools"`);
    app.stdin.write('\r');
    await until(() => frame().includes('The first tool'), "the clone's graph");
    assert.ok(existsSync(join(base, 'my tools', 'tool.txt')));

    // Git refuses a folder that's already there with something in it, and Splice stays where it was.
    await type(app, `/clone ${server} app`);
    app.stdin.write('\r');
    await until(() => /fatal: destination path .*app' already/.test(frame()), "git's refusal");
    assert.ok(existsSync(join(base, 'app', 'a.txt')));
    assert.match(frame().split('\n')[0], /my tools\s*$/);
  } finally {
    app.unmount();
  }
});
