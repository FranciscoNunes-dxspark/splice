// Folders and files dropped on the terminal: reading the paths it types (pure), then through the real UI
// against throwaway repositories.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { droppedPaths, insideRepo } from '../src/drop.js';
import { App } from '../src/ui/App.jsx';

test('dropped paths: absolute, quoted, escaped or as file:// URLs; anything else is typing', () => {
  const win = { windows: true };
  const posix = { windows: false };
  assert.deepEqual(droppedPaths('C:\\Team\\Keel', win), ['C:\\Team\\Keel']);
  assert.deepEqual(droppedPaths('"C:\\My Repos\\Keel\\" ', win), ['C:\\My Repos\\Keel'], 'quoted, and the separator at the end goes');
  assert.deepEqual(droppedPaths('C:/Team/Keel/src/app.js', win), ['C:/Team/Keel/src/app.js']);
  assert.deepEqual(droppedPaths('\\\\server\\share\\keel', win), ['\\\\server\\share\\keel']);
  assert.deepEqual(droppedPaths('file:///C:/My%20Repos/Keel', win), ['C:\\My Repos\\Keel']);
  assert.deepEqual(droppedPaths('/home/ana/My\\ Repos/keel', posix), ['/home/ana/My Repos/keel']);
  assert.deepEqual(droppedPaths("'/home/ana/my repo/' ", posix), ['/home/ana/my repo']);
  assert.deepEqual(droppedPaths('file:///home/ana/a%20b', posix), ['/home/ana/a b']);
  assert.deepEqual(droppedPaths('/a /b', posix), ['/a', '/b']);
  assert.equal(droppedPaths('keel', posix), null, 'not absolute');
  assert.equal(droppedPaths('/a keel', posix), null, 'all of them or none');
  assert.equal(droppedPaths('//', posix), null, 'two slashes typed fast');
  assert.equal(droppedPaths('C:\\', win), null, 'a drive alone');
  assert.equal(droppedPaths('jj', posix), null);
  assert.equal(droppedPaths('/a\n/b', posix), null, 'a paste of lines');
});

test('a path inside a repository, relative to its root with / between folders; null outside it', () => {
  assert.equal(insideRepo('/home/ana/keel', '/home/ana/keel/src/app.js', { windows: false }), 'src/app.js');
  assert.equal(insideRepo('/home/ana/keel', '/home/ana/keel-2/a.js', { windows: false }), null);
  assert.equal(insideRepo('/home/ana/keel', '/home/ana/keel', { windows: false }), null);
  assert.equal(insideRepo('C:\\Team\\Keel', 'c:\\team\\keel\\src\\App.js', { windows: true }), 'src/App.js');
  assert.equal(insideRepo('C:\\Team\\Keel', 'D:\\Keel\\a.js', { windows: true }), null);
});

let base;
let one;
let many;
let lastApp = null;

/** A repository in `dir` with one commit adding a.txt. */
function makeRepo(dir, subject) {
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), `${subject}\n`);
  git('add', '.');
  git('commit', '-q', '-m', subject);
}

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-drop-'));
  process.env.SPLICE_HOME = join(base, 'home');
  one = join(base, 'one');
  makeRepo(one, 'Commit in one');
  many = join(base, 'many repos');
  makeRepo(join(many, 'two'), 'Commit in two');
  makeRepo(join(many, 'three'), 'Commit in three');
  writeFileSync(join(base, 'loose.txt'), 'x\n');
});

after(() => removeTemp(base));

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

// Quoted as a terminal types a dropped path with a space in it.
const quote = (p) => (process.platform === 'win32' ? `"${p}"` : `'${p}'`);

test('a dropped file of the open repository shows its history; a dropped folder opens, or lists the repositories in it', async () => {
  lastApp = render(React.createElement(App, { initialPath: one, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Commit in one'), 'the graph');

    app.stdin.write(`${join(one, 'a.txt')} `);
    await until(() => frame().includes('History of a.txt'), "the file's history");
    app.stdin.write('\x1b');
    await until(() => !frame().includes('History of a.txt'), 'the history to close');

    // A file from elsewhere says so; a path that isn't there is just typing.
    app.stdin.write(join(base, 'loose.txt'));
    await until(() => frame().includes("loose.txt isn't in one"), 'the complaint');
    app.stdin.write(join(base, 'nowhere'));
    await new Promise((r) => setTimeout(r, 200));
    assert.match(frame(), /Commit in one/);

    // A folder that isn't a repository: the ones inside it.
    app.stdin.write(quote(many));
    await until(() => frame().includes("isn't a git repository. Repos lists the ones inside it") && frame().includes('three') && frame().includes('two'), 'the repositories inside');

    // A repository's folder opens it.
    app.stdin.write(quote(join(many, 'two')));
    await until(() => frame().includes('Commit in two'), 'the dropped repository');
  } finally {
    app.unmount();
  }
});
