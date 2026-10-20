// Stashing one file from Changes and restoring single files from a stash, driven through the real UI.
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
import { parseStashFiles } from '../src/parse.js';

const KEYS = { enter: '\r', esc: '\x1b' };

let base;
let dir;
// Checks run while Splice's own git commands do: they mustn't take the index lock (git status would) from under them.
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
// On Windows, reading a file while git replaces it can fail; that's "not yet".
const read = (name) => {
  try {
    return readFileSync(join(dir, name), 'utf8');
  } catch {
    return null;
  }
};

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-stash-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
});

// On Windows a git process Splice started just before unmounting can still hold the folder for a moment.
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

function start() {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  return lastApp;
}

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("a stash's files: tracked changes, then the untracked ones from its third parent", () => {
  const tracked = ['M', 'src/app.js', 'A', 'new file.txt', 'D', 'gone.txt', ''].join('\0');
  const untracked = ['notes/todo.md', 'scratch.txt', ''].join('\0');
  assert.deepEqual(parseStashFiles(tracked, untracked), [
    { code: 'M', path: 'src/app.js', untracked: false },
    { code: 'A', path: 'new file.txt', untracked: false },
    { code: 'D', path: 'gone.txt', untracked: false },
    { code: '?', path: 'notes/todo.md', untracked: true },
    { code: '?', path: 'scratch.txt', untracked: true },
  ]);
  // No third parent (a stash made without --include-untracked), and a rename should one turn up.
  assert.deepEqual(parseStashFiles(['R087', 'old.js', 'new.js', ''].join('\0')), [
    { code: 'D', path: 'old.js', untracked: false },
    { code: 'A', path: 'new.js', untracked: false },
  ]);
  assert.deepEqual(parseStashFiles('', ''), []);
});

test('stashing one file, restoring single files from a stash, and asking before overwriting', async () => {
  writeFileSync(join(dir, 'a.txt'), 'a\nkept\n');
  writeFileSync(join(dir, 'b.txt'), 'b\nstashed\n');
  writeFileSync(join(dir, 'u.txt'), 'untracked\n');
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  // Moves the cursor down until `re` matches the frame, waiting for each move to show.
  const pick = async (re, what) => {
    while (!re.test(frame())) {
      const before = frame();
      app.stdin.write('j');
      await until(() => frame() !== before || re.test(frame()), `the cursor to move towards ${what}`);
    }
    await until(() => re.test(frame()), `the cursor on ${what}`);
  };
  try {
    await until(() => frame().includes('First commit'), 'the graph');

    // s in Changes stashes just the file under the cursor, named after it.
    app.stdin.write('2');
    await until(() => frame().includes('Unstaged (3)'), 'the Changes view');
    await pick(/❯ M b\.txt/, 'b.txt');
    app.stdin.write('s');
    // The stash shows up in the list a moment before git has put the file back.
    await until(() => git('stash', 'list', '--format=%gs') === 'On main: b.txt' && read('b.txt') === 'b\n', 'b.txt to be stashed');
    assert.equal(git('status', '--porcelain'), 'M a.txt\n?? u.txt');

    // An untracked file goes into the stash's untracked part.
    await until(() => frame().includes('Unstaged (2)'), 'the view to refresh');
    await pick(/❯ \? u\.txt/, 'u.txt');
    app.stdin.write('s');
    await until(() => git('stash', 'list', '--format=%gs').startsWith('On main: u.txt') && git('status', '--porcelain') === 'M a.txt', 'u.txt to be stashed');
    assert.equal(git('ls-tree', '-r', '--name-only', 'stash@{0}^3'), 'u.txt');

    // f in Stash lists a stash's files; ↵ restores the untracked one, untracked.
    app.stdin.write('5');
    await until(() => /❯ stash@\{0\}/.test(frame()), 'the Stash view');
    app.stdin.write('F');
    await until(() => frame().includes('Files in stash@{0}') && /❯ \? u\.txt\s+untracked/.test(frame()), 'the files of stash@{0}');
    app.stdin.write(KEYS.enter);
    await until(() => git('status', '--porcelain').includes('?? u.txt'), 'u.txt to be restored');
    assert.equal(read('u.txt'), 'untracked\n');
    // Still one stash per file: restoring takes nothing out of the stash, and f didn't fetch.
    assert.equal(git('stash', 'list').split('\n').length, 2);

    // d shows the file's diff in the stash; closing it comes back to the list.
    app.stdin.write('d');
    await until(() => frame().includes('u.txt in stash@{0}') && frame().includes('+untracked'), 'the diff of u.txt');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Files in stash@{0}'), 'the files again');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Files in stash@{0}'), 'the files to close');

    // A modified file comes back unstaged.
    await pick(/❯ stash@\{1\}/, 'stash@{1}');
    app.stdin.write('F');
    await until(() => /❯ M b\.txt\s+modified/.test(frame()), 'the files of stash@{1}');
    app.stdin.write(KEYS.enter);
    await until(() => read('b.txt') === 'b\nstashed\n', 'b.txt to be restored');
    assert.equal(git('diff', '--name-only'), 'a.txt\nb.txt');
    assert.equal(git('diff', '--cached', '--name-only'), '');

    // Over uncommitted changes, it asks first, and "No" leaves them alone.
    writeFileSync(join(dir, 'b.txt'), 'b\nmine\n');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Overwrite b.txt with the copy in stash@{1}?'), 'the confirmation');
    app.stdin.write('2');
    await until(() => !frame().includes('Overwrite b.txt'), 'the dialog to close');
    assert.equal(read('b.txt'), 'b\nmine\n');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Overwrite b.txt with the copy in stash@{1}?'), 'the confirmation again');
    app.stdin.write('1');
    await until(() => read('b.txt') === 'b\nstashed\n', 'b.txt to be overwritten');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Files in stash@{1}'), 'the files to close');

    // S stashes everything with a message typed first.
    app.stdin.write('S');
    await until(() => frame().includes('/stash'), 'the prefilled prompt');
    await type(app.stdin, 'all of it');
    await until(() => frame().includes('/stash all of it'), 'the typed message');
    app.stdin.write(KEYS.enter);
    await until(() => git('stash', 'list', '-1', '--format=%gs') === 'On main: all of it' && git('status', '--porcelain') === '', 'the stash with a message');
    await until(() => frame().includes('✓ clean'), 'the header to follow');
  } finally {
    app.unmount();
  }
});

test('/stash arguments: -u and --no-untracked over the setting, and the message', async () => {
  const { stashArgs } = await import('../src/parse.js');
  assert.deepEqual(stashArgs('', { untracked: true }).args, ['stash', 'push', '--include-untracked']);
  assert.deepEqual(stashArgs('wip', { untracked: false }).args, ['stash', 'push', '-m', 'wip']);
  assert.deepEqual(stashArgs('-u wip on it', { untracked: false }).args, ['stash', 'push', '--include-untracked', '-m', 'wip on it']);
  assert.deepEqual(stashArgs('half --no-untracked done', { untracked: true }), { args: ['stash', 'push', '-m', 'half done'], untracked: false, message: 'half done' });
});

test('stashing several files at once, just one hunk of a file, and leaving untracked files out', async () => {
  git('stash', 'clear');
  const lines = (edit) => `${Array.from({ length: 30 }, (_, i) => edit[i] ?? `l${i + 1}`).join('\n')}\n`;
  writeFileSync(join(dir, 'long.txt'), lines({}));
  git('add', 'long.txt');
  git('commit', '-q', '-m', 'Long file');
  writeFileSync(join(dir, 'a.txt'), 'a\nfirst\n');
  writeFileSync(join(dir, 'b.txt'), 'b\nsecond\n');
  writeFileSync(join(dir, 'long.txt'), lines({ 1: 'TOP', 27: 'BOTTOM' }));
  writeFileSync(join(dir, 'new.txt'), 'new\n');
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  const pick = async (re, what) => {
    while (!re.test(frame())) {
      const before = frame();
      app.stdin.write('j');
      await until(() => frame() !== before || re.test(frame()), `the cursor to move towards ${what}`);
    }
    await until(() => re.test(frame()), `the cursor on ${what}`);
  };
  try {
    await until(() => frame().includes('Long file'), 'the graph');
    app.stdin.write('2');
    await until(() => frame().includes('Unstaged (4)') && /❯ M a\.txt/.test(frame()), 'the Changes view');
    app.stdin.write('v');
    await until(() => frame().includes('1 selected'), 'the selection started');
    app.stdin.write('j');
    await until(() => frame().includes('2 selected'), 'two files selected');
    app.stdin.write('s');
    await until(() => git('stash', 'list', '--format=%gs') === 'On main: a.txt and 1 more' && read('a.txt') === 'a\n' && read('b.txt') === 'b\n', 'both files stashed');
    assert.equal(git('stash', 'show', '--name-only', 'stash@{0}'), 'a.txt\nb.txt');

    await until(() => frame().includes('Unstaged (2)'), 'the view to refresh');
    app.stdin.write('g');
    await until(() => /❯ M long\.txt/.test(frame()), 'the cursor on long.txt');
    app.stdin.write('\r');
    await until(() => frame().includes('▌@@ -1,'), 'the diff pane');
    app.stdin.write('s');
    await until(() => git('stash', 'list').split('\n').length === 2 && !read('long.txt').includes('TOP'), 'the first hunk stashed');
    assert.match(read('long.txt'), /BOTTOM/, 'the other hunk stays');
    const shown = git('stash', 'show', '-p', 'stash@{0}');
    assert.match(shown, /^\+TOP$/m);
    assert.doesNotMatch(shown, /BOTTOM/);
    assert.equal(git('stash', 'list', '-1', '--format=%gs'), 'On main: long.txt (some lines)');
    // Popping it (o in Stash) brings back just that hunk, next to the one that stayed, which git's own
    // stash pop refuses to do.
    app.stdin.write('\x1b');
    app.stdin.write('5');
    await until(() => /❯ stash@\{0\}\s+\S+\s+On main: long\.txt/.test(frame()), 'the Stash view');
    app.stdin.write('o');
    await until(() => read('long.txt') === lines({ 1: 'TOP', 27: 'BOTTOM' }) && git('stash', 'list').split('\n').length === 1, 'the hunk popped back');
    app.stdin.write('2');
    app.stdin.write('/');
    await type(app.stdin, 'stash --no-untracked tracked only');
    await until(() => frame().includes('/stash --no-untracked tracked only'), 'the typed command');
    app.stdin.write(KEYS.enter);
    await until(() => git('stash', 'list', '-1', '--format=%gs') === 'On main: tracked only' && git('status', '--porcelain') === '?? new.txt', 'the stash without the untracked file');
  } finally {
    app.unmount();
  }
});
