// Ignoring untracked files from Changes (i, /ignore): the lines it offers and writes, and the real UI.
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
import { escapeIgnore, ignoreChoices, withIgnoreLine } from '../src/ignore.js';

const KEYS = { enter: '\r', esc: '\x1b' };

let base;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-ignore-'));
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

async function command(app, text) {
  app.stdin.write('/');
  await type(app.stdin, text);
  await until(() => app.lastFrame().includes(`/${text}`), `the typed command /${text}`);
  app.stdin.write(KEYS.enter);
}

test('paths are escaped so .gitignore matches them literally', () => {
  assert.equal(escapeIgnore('src/a.txt'), 'src/a.txt');
  assert.equal(escapeIgnore('weird[1]*?.txt'), 'weird\\[1]\\*\\?.txt');
  assert.equal(escapeIgnore('#notes'), '\\#notes');
  assert.equal(escapeIgnore('!keep'), '\\!keep');
  assert.equal(escapeIgnore('back\\slash'), 'back\\\\slash');
  assert.equal(escapeIgnore('trailing  '), 'trailing\\ \\ ');
});

test('what i offers: the file, its folder, its extension, its folder\'s own .gitignore', () => {
  assert.deepEqual(ignoreChoices('logs/app/debug.log'), [
    { label: 'This file: /logs/app/debug.log', file: '.gitignore', pattern: '/logs/app/debug.log' },
    { label: 'Its folder: /logs/app/', file: '.gitignore', pattern: '/logs/app/' },
    { label: 'Every *.log file, in any folder', file: '.gitignore', pattern: '*.log' },
    { label: 'This file, in logs/app/.gitignore: /debug.log', file: 'logs/app/.gitignore', pattern: '/debug.log' },
  ]);
  // At the top: no folder to offer; a dot file has no extension.
  assert.deepEqual(ignoreChoices('notes.tmp').map((c) => c.pattern), ['/notes.tmp', '*.tmp']);
  assert.deepEqual(ignoreChoices('.env').map((c) => c.pattern), ['/.env']);
  // A nested repository shows as a folder.
  assert.deepEqual(ignoreChoices('vendor/lib/').map((c) => [c.file, c.pattern]), [
    ['.gitignore', '/vendor/lib/'],
    ['.gitignore', '/vendor/'],
    ['vendor/.gitignore', '/lib/'],
  ]);
});

test('a line goes at the end, in the file\'s own line endings, ending in one', () => {
  assert.deepEqual(withIgnoreLine('', '/a'), { text: '/a\n', added: true });
  assert.deepEqual(withIgnoreLine('x\n', '/a'), { text: 'x\n/a\n', added: true });
  assert.deepEqual(withIgnoreLine('x', '/a'), { text: 'x\n/a\n', added: true });
  assert.deepEqual(withIgnoreLine('x\r\ny', '/a'), { text: 'x\r\ny\r\n/a\r\n', added: true });
  assert.deepEqual(withIgnoreLine('x\r\n/a\r\n', '/a'), { text: 'x\r\n/a\r\n', added: false });
});

test('i on an untracked file adds what was picked to .gitignore; tracked files are explained; /ignore takes a pattern', async () => {
  const dir = join(base, 'repo');
  mkdirSync(dir);
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@example.com');
  g('config', 'commit.gpgsign', 'false');
  // CRLF, and no newline at the end.
  writeFileSync(join(dir, '.gitignore'), 'node_modules\r\n*.bak');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  g('add', '.');
  g('commit', '-q', '-m', 'First commit');
  for (const p of ['logs', 'cache']) mkdirSync(join(dir, p));
  writeFileSync(join(dir, 'logs', 'debug.log'), 'log\n');
  writeFileSync(join(dir, 'cache', 'x.dat'), 'x\n');
  writeFileSync(join(dir, 'notes.tmp'), 'n\n');
  writeFileSync(join(dir, 'secret.env'), 's\n');
  writeFileSync(join(dir, 'a.txt'), 'a, changed\n');

  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const pick = async (re, what) => {
    while (!re.test(frame())) {
      const before = frame();
      app.stdin.write('j');
      await until(() => frame() !== before || re.test(frame()), `the cursor to move towards ${what}`);
    }
    await until(() => re.test(frame()), `the cursor on ${what}`);
  };
  const untracked = () => g('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    app.stdin.write('2');
    await until(() => frame().includes('Unstaged (5)'), 'the Changes view');

    // A tracked file: .gitignore wouldn't do anything, so it says what would.
    await pick(/❯ M a\.txt/, 'a.txt');
    app.stdin.write('i');
    await until(() => frame().includes('a.txt is tracked') && frame().includes('rm --cached a.txt'), 'the explanation');

    await pick(/❯ \? logs\/debug\.log/, 'logs/debug.log');
    app.stdin.write('i');
    await until(() => frame().includes('Ignore logs/debug.log?') && frame().includes('4. This file, in logs/.gitignore'), 'the question');
    app.stdin.write('2');
    await until(() => readFileSync(join(dir, '.gitignore'), 'utf8') === 'node_modules\r\n*.bak\r\n/logs/\r\n', 'the folder in .gitignore, CRLF kept');
    await until(() => frame().includes('Added /logs/ to .gitignore') && /M \.gitignore/.test(frame()) && !frame().includes('debug.log'), 'the .gitignore as a change, debug.log gone');
    assert.deepEqual(untracked().sort(), ['cache/x.dat', 'notes.tmp', 'secret.env']);

    // Its own folder's .gitignore, made new.
    await pick(/❯ \? cache\/x\.dat/, 'cache/x.dat');
    app.stdin.write('i');
    await until(() => frame().includes('Ignore cache/x.dat?'), 'the question');
    app.stdin.write('4');
    await until(() => frame().includes('Added /x.dat to cache/.gitignore, a new file'), 'the new .gitignore');
    assert.equal(readFileSync(join(dir, 'cache', '.gitignore'), 'utf8'), '/x.dat\n');

    await pick(/❯ \? notes\.tmp/, 'notes.tmp');
    app.stdin.write('i');
    await until(() => frame().includes('Ignore notes.tmp?') && frame().includes('2. Every *.tmp file'), 'the question');
    app.stdin.write('2');
    await until(() => !untracked().includes('notes.tmp'), 'notes.tmp ignored');

    await command(app, 'ignore secret.env');
    await until(() => frame().includes('Added secret.env to .gitignore'), 'the pattern added');
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules\r\n*.bak\r\n/logs/\r\n*.tmp\r\nsecret.env\r\n');
    assert.deepEqual(untracked(), ['cache/.gitignore']);
    await command(app, 'ignore secret.env');
    await until(() => frame().includes('.gitignore has secret.env already'), 'the line there already');
  } finally {
    app.unmount();
  }
});
