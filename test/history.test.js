// File history and blame through the real UI, against a throwaway repository with a rename and a deleted file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.jsx';

const KEYS = { enter: '\r', esc: '\x1b' };

let base;
let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const commit = (message) => git('commit', '-q', '-m', message);

before(() => {
  base = mkdtempSync(join(tmpdir(), 'tiller-history-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.TILLER_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'old.txt'), 'alpha\nbeta\n');
  git('add', '.');
  commit('Add notes');
  writeFileSync(join(dir, 'old.txt'), 'alpha\nbeta\ngamma\n');
  git('add', '.');
  commit('Grow notes');
  git('mv', 'old.txt', 'notes.txt');
  commit('Rename notes');
  writeFileSync(join(dir, 'notes.txt'), 'alpha\nBETA\ngamma\n');
  git('add', '.');
  commit('Edit notes');
  writeFileSync(join(dir, 'gone.txt'), 'short-lived\n');
  git('add', '.');
  commit('Add gone');
  git('rm', '-q', 'gone.txt');
  commit('Remove gone');
  // Uncommitted, so blame has a line to call not committed yet.
  writeFileSync(join(dir, 'notes.txt'), 'alpha\nBETA\ngamma\ndelta\n');
});

// On Windows a git still finishing (a poll, say) keeps the folder busy for a moment.
after(() => rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Once it shows, give the new overlay's key handlers a moment to subscribe, as a person would.
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

test('history of a file in Changes follows the rename, opens diffs and blames an old version', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  const hash = (subject) => git('log', '--all', '-1', `--grep=^${subject}$`, '--format=%h');
  try {
    await until(() => frame().includes('Remove gone'), 'the graph');
    app.stdin.write('2');
    await until(() => /❯ M notes\.txt/.test(frame()) && frame().includes('Unstaged (1)'), 'notes.txt in Changes');

    app.stdin.write('H');
    await until(() => frame().includes('History of notes.txt') && frame().includes('Add notes'), 'the history');
    const f = frame();
    for (const s of ['Edit notes', 'Rename notes', 'Grow notes', 'Add notes']) assert.ok(f.includes(s), `${s} is listed`);
    assert.doesNotMatch(f, /gone/);
    // The rename names the old path; older commits show the name the file had then.
    assert.match(f, /← old\.txt\s+Rename notes/);
    assert.match(f, /old\.txt\s+Grow notes/);
    assert.match(f, new RegExp(`❯ ${hash('Edit notes')}`));

    app.stdin.write('j');
    await until(() => /❯ .*Rename notes/.test(frame()), 'the cursor on Rename notes');
    app.stdin.write('j');
    await until(() => /❯ .*Grow notes/.test(frame()), 'the cursor on Grow notes');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes(`${hash('Grow notes')} Grow notes · old.txt`) && frame().includes('old.txt | 1 +'), 'the diff of the file in that commit');

    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('History of notes.txt') && /❯ .*Grow notes/.test(frame()), 'the history again, cursor kept');

    app.stdin.write('B');
    await until(() => frame().includes(`Blame old.txt at ${hash('Grow notes')}`) && frame().includes('gamma'), 'the blame as of Grow notes');
    assert.doesNotMatch(frame(), /BETA|delta/);
    assert.match(frame(), new RegExp(`${hash('Add notes')} Test\\s+\\d{4}-\\d\\d-\\d\\d 1 │ alpha`));

    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('History of notes.txt'), 'back to the history');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('History of') && /❯ M notes\.txt/.test(frame()), 'back to Changes');
  } finally {
    app.unmount();
  }
});

test('blame of the working-tree file: uncommitted lines, ↵ to the commit and back, H to the history', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Remove gone'), 'the graph');
    app.stdin.write('2');
    await until(() => /❯ M notes\.txt/.test(frame()) && frame().includes('Unstaged (1)'), 'notes.txt in Changes');

    app.stdin.write('B');
    await until(() => frame().includes('Blame notes.txt') && frame().includes('delta'), 'the blame');
    assert.match(frame(), /Not committed yet\s+4 │ delta/);
    // Lines 1 and 3 come from one commit, line 2 from another, so each starts its own run.
    const edit = git('log', '-1', '--format=%h', '--grep=Edit notes');
    const add = git('log', '-1', '--format=%h', '--grep=Add notes');
    const grow = git('log', '-1', '--format=%h', '--grep=Grow notes');
    assert.match(frame(), new RegExp(`${add} Test .*1 │ alpha`));
    assert.match(frame(), new RegExp(`${edit} Test .*2 │ BETA`));
    assert.match(frame(), new RegExp(`${grow} Test .*3 │ gamma`));

    app.stdin.write('j');
    await until(() => /❯ .*2 │ BETA/.test(frame()), 'the cursor on line 2');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes(`${edit} Edit notes · notes.txt`) && frame().includes('notes.txt | 2 +-'), 'the commit behind the line');

    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Blame notes.txt') && /❯ .*2 │ BETA/.test(frame()), 'the blame again');

    app.stdin.write('H');
    await until(() => frame().includes('History of notes.txt') && frame().includes('Add notes'), 'the history from the blame');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Blame notes.txt'), 'back to the blame');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Blame notes.txt'), 'the blame to close');
  } finally {
    app.unmount();
  }
});

test('/history of a deleted file, and /blame with a completed path', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Remove gone'), 'the graph');
    app.stdin.write('/');
    await type(app.stdin, 'history gone.txt');
    await until(() => frame().includes('/history gone.txt'), 'the typed command');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('History of gone.txt') && frame().includes('Add gone'), 'the deleted file history');
    assert.match(frame(), /deleted\s+Remove gone/);
    // Blaming it as of the commit that deleted it blames the version just before.
    app.stdin.write('B');
    await until(() => frame().includes('Blame gone.txt at') && frame().includes('short-lived'), 'the blame of the deleted file');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('History of gone.txt'), 'back to the history');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('History of gone.txt'), 'the history to close');

    app.stdin.write('/');
    await type(app.stdin, 'blame note');
    await until(() => /^\s+notes\.txt\s*$/m.test(frame()), 'the path completion');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Blame notes.txt') && frame().includes('delta'), 'the blame from the command');
  } finally {
    app.unmount();
  }
});
