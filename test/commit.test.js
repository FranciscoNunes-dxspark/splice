// Commit messages of more than one line: \n in /commit, the message file for your own editor (M,
// /commit --file, /amend --file), and Claude writing a body (W), driven through the real UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { enter: '\r', esc: '\x1b' };

let base;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-commit-'));
  process.env.SPLICE_HOME = join(base, 'home');
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  let failed = null;
  while (Date.now() < end) {
    try {
      // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
      if (check()) return new Promise((r) => setTimeout(r, 100));
      failed = null;
    } catch (e) {
      failed = e;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}.${failed ? ` Last check: ${failed.message}` : ''} Last frame:\n${lastApp?.lastFrame()}`);
}

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function typeCommand(app, text) {
  app.stdin.write('/');
  await type(app.stdin, text);
  await until(() => app.lastFrame().includes(`/${text}`), `the typed command /${text}`);
}

test('\\n in /commit, then M and /amend --file write the message to a file to edit, and commit from it', async () => {
  const dir = join(base, 'files');
  mkdirSync(dir);
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@example.com');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-q', '-m', 'Start');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  g('add', '.');
  const commitFile = join(dir, '.git', 'splice-commit-message.txt');
  const amendFile = join(dir, '.git', 'splice-amend-message.txt');

  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Start'), 'the graph');
    app.stdin.write('2');
    await until(() => frame().includes('Staged (1)'), 'the Changes view');

    // \n is a line break: a subject and a body.
    await typeCommand(app, 'commit Add two\\n\\nOne was lonely.');
    app.stdin.write(KEYS.enter);
    await until(() => g('log', '-1', '--format=%B') === 'Add two\n\nOne was lonely.', 'the commit with a body');

    // M starts the file from what's typed after /commit, and lists what's staged.
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(dir, 'b.txt'), 'new\n');
    g('add', '.');
    await until(() => frame().includes('Staged (2)'), 'two files staged');
    await typeCommand(app, 'commit Count to three');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('enter run'), 'back in the view');
    app.stdin.write('M');
    await until(() => existsSync(commitFile) && frame().includes('splice-commit-message.txt') && frame().includes('Wrote the commit message'), 'the message file');
    const written = readFileSync(commitFile, 'utf8');
    assert.ok(written.startsWith('Count to three\n\n# '), written);
    assert.match(written, /^# Changes to be committed:$/m);
    assert.match(written, /^#\tmodified: {3}a\.txt$/m);
    assert.match(written, /^#\tnew file: {3}b\.txt$/m);
    // Edited in "your editor": a body under the subject; the comment lines stay and are left out.
    writeFileSync(commitFile, written.replace('Count to three\n', 'Count to three\n\nAnd add b.   \n\n\n'));
    app.stdin.write(KEYS.enter);
    await until(() => g('log', '-1', '--format=%s') === 'Count to three', 'the commit from the file');
    assert.equal(g('log', '-1', '--format=%B'), 'Count to three\n\nAnd add b.');
    await until(() => !existsSync(commitFile), 'the file removed once committed');

    // /amend --file alone starts from the commit's own message, listing everything the commit will hold.
    writeFileSync(join(dir, 'c.txt'), 'see\n');
    g('add', '.');
    await until(() => frame().includes('Staged (1)'), 'c.txt staged');
    await typeCommand(app, 'amend --file');
    app.stdin.write(KEYS.enter);
    await until(() => existsSync(amendFile) && frame().includes('splice-amend-message.txt'), 'the amend message file');
    const amend = readFileSync(amendFile, 'utf8');
    assert.ok(amend.startsWith('Count to three\n\nAnd add b.\n\n# '), amend);
    assert.match(amend, /^# In the amended commit:$/m);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) assert.match(amend, new RegExp(`^#\\t.*${f.replace('.', '\\.')}$`, 'm'));
    writeFileSync(amendFile, amend.replace('And add b.', 'And add b and c.'));
    app.stdin.write(KEYS.enter);
    await until(() => g('log', '-1', '--format=%B') === 'Count to three\n\nAnd add b and c.', 'the amended commit');
    assert.equal(g('rev-list', '--count', 'HEAD'), '3');
    assert.equal(g('show', '--name-only', '--format=', 'HEAD'), 'a.txt\nb.txt\nc.txt');

    // A file left with no message isn't committed: it says so, and the command waits in the prompt again.
    await typeCommand(app, 'commit --file');
    app.stdin.write(KEYS.enter);
    await until(() => existsSync(commitFile) && frame().includes('splice-commit-message.txt'), 'an empty message file');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('The message is empty'), 'the note that the message is empty');
    // The file from the repository's root, short enough to read in the prompt whatever the folder.
    assert.ok(frame().includes('> /commit --file .git/splice-commit-message.txt '), frame());
    assert.equal(g('rev-list', '--count', 'HEAD'), '3');
  } finally {
    app.unmount();
  }
});

test('W: a subject alone goes in the prompt; with a body, into the message file, shown in the viewer', async () => {
  const dir = join(base, 'claude');
  mkdirSync(dir);
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@example.com');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-q', '-m', 'Start the notes', '-m', 'The first of many.');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  g('add', '.');
  const commitFile = join(dir, '.git', 'splice-commit-message.txt');

  const asked = [];
  const askClaude = async (prompt, opts) => {
    asked.push({ prompt, ...opts });
    return '```\nTeach the notes to count\n\nThey only knew one number, which made\nlists short.\n```';
  };
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, askClaude }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Start the notes'), 'the graph');
    app.stdin.write('2');
    await until(() => frame().includes('Staged (1)'), 'the Changes view');
    app.stdin.write('W');
    await until(
      () => frame().includes('Commit message from Claude') && frame().includes('which made') && /> \/commit --file .*splice-commit-message\.txt/.test(frame()),
      'the message in the viewer, and the file in the prompt',
    );
    // The recent commits' bodies show Claude the style.
    assert.match(asked[0].prompt, /- Start the notes\n {2}The first of many\./);
    assert.deepEqual(asked[0].tools, []);
    assert.ok(readFileSync(commitFile, 'utf8').startsWith('Teach the notes to count\n\nThey only knew one number, which made\nlists short.\n\n# '));
    app.stdin.write(KEYS.enter);
    await until(() => g('log', '-1', '--format=%s') === 'Teach the notes to count', 'the commit');
    assert.equal(g('log', '-1', '--format=%b'), 'They only knew one number, which made\nlists short.');
  } finally {
    app.unmount();
  }
});
