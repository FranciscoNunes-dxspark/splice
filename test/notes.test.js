// Git notes: /note's arguments (pure), then through the UI against a throwaway repository: a note in the
// commit pane, added, edited from the prompt, removed (asking, keeping a copy), put back, and pushed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { noteArgs, notePrefill, notesArgs, withKeptNote } from '../src/notes.js';
import { commitDetail, notesRef } from '../src/repo.js';
import { App } from '../src/ui/App.jsx';

test("/note's and /notes' arguments, the prompt line, and the kept notes", () => {
  assert.deepEqual(noteArgs(''), {});
  assert.deepEqual(noteArgs(' -d '), { remove: true });
  assert.deepEqual(noteArgs('--undo'), { undo: true });
  assert.deepEqual(noteArgs('Deployed\\nto prod'), { text: 'Deployed\nto prod' });
  assert.equal(notePrefill('Deployed\r\nto prod\n'), '/note Deployed\\nto prod');
  assert.deepEqual(notesArgs('push'), { push: true, remote: null });
  assert.deepEqual(notesArgs('push upstream'), { push: true, remote: 'upstream' });
  assert.match(notesArgs('pull').error, /\/notes push/);
  const list = Array.from({ length: 12 }, (_, i) => ({ hash: `h${i}` })).reduce((l, e) => withKeptNote(l, e), []);
  assert.deepEqual(list.map((e) => e.hash), ['h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8', 'h9', 'h10', 'h11'], 'the newest ten');
  assert.equal(notesRef(`refs/heads/main\x1f${'a'.repeat(40)}\nrefs/notes/commits\x1f${'b'.repeat(40)}\x1f\x1f`), 'b'.repeat(40));
  assert.equal(notesRef('refs/heads/main\x1fabc'), null);
});

let base;
let dir;
let origin;
let lastApp = null;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const git = (...args) => run(dir, ...args);
const noteOf = (rev) => {
  try {
    return git('notes', 'show', rev);
  } catch {
    return null;
  }
};

before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'splice-notes-')));
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
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Second commit');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  git('notes', 'add', '-m', 'Reviewed by Ana', 'HEAD~1');
});

after(() => removeTemp(base));

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let ok = false;
    try {
      ok = check();
    } catch {
      // not yet
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

test("a commit's detail carries its note", async () => {
  assert.equal((await commitDetail(dir, git('rev-parse', 'HEAD~1'))).note, 'Reviewed by Ana');
  const head = await commitDetail(dir, git('rev-parse', 'HEAD'));
  assert.equal(head.note, '');
  assert.equal(head.message, 'Second commit');
});

test('/note: shown in the commit pane, added, edited from the prompt, removed and put back; /notes push', async () => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const first = git('rev-parse', 'HEAD~1');
  const second = git('rev-parse', 'HEAD');
  try {
    await until(() => /❯.*Second commit/.test(frame()), 'the graph');
    assert.doesNotMatch(frame(), /Notes added by/, "the notes' own commits are no branch's, so not in the graph");
    app.stdin.write('j');
    await until(() => /❯.*First commit/.test(frame()) && frame().includes('Reviewed by Ana'), "the first commit's note in its pane");

    // Alone: the note goes in the prompt to edit.
    await command(app, 'note');
    await until(() => frame().includes('> /note Reviewed by Ana'), 'the note in the prompt');
    await type(app.stdin, '\\nand Bo');
    app.stdin.write('\r');
    await until(() => noteOf(first) === 'Reviewed by Ana\nand Bo', 'the note changed');
    await until(() => frame().includes('and Bo'), 'the pane shows it');
    assert.match(frame(), /The old note on .{7} is kept: \/note --undo puts it back/);

    // -d asks, and keeps a copy that --undo puts back.
    await command(app, 'note -d');
    await until(() => frame().includes(`Remove the note on ${first.slice(0, 7)} First commit?`), 'the question');
    app.stdin.write('1');
    await until(() => noteOf(first) === null, 'removed');
    await until(() => !frame().includes('and Bo'), 'gone from the pane');
    await command(app, 'note --undo');
    await until(() => frame().includes(`Put back the note on ${first.slice(0, 7)}?`), 'the undo question');
    app.stdin.write('1');
    await until(() => noteOf(first) === 'Reviewed by Ana\nand Bo', 'put back');

    // A new note on the commit under the cursor.
    app.stdin.write('k');
    await until(() => /❯.*Second commit/.test(frame()), 'the second commit');
    await command(app, 'note Deployed');
    await until(() => noteOf(second) === 'Deployed', 'a note added');
    await until(() => frame().includes('Deployed'), 'shown');

    await command(app, 'notes push');
    await until(() => run(origin, 'rev-parse', 'refs/notes/commits') === git('rev-parse', 'refs/notes/commits'), 'the notes pushed');
  } finally {
    app.unmount();
  }
});
