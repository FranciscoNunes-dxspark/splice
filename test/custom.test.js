// Your own commands and keys, and the command palette, end to end against a throwaway repository.
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

const KEYS = { down: '\x1b[B', enter: '\r', esc: '\x1b', ctrlP: '\x10', f5: '\x1b[15~' };

let base;
let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-custom-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
});

after(() => removeTemp(base));

let lastApp = null;
async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (check()) return new Promise((r) => setTimeout(r, 100));
    } catch {
      // git mid-change: not yet.
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

function start(extra = {}) {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [], ...extra } }));
  return lastApp;
}

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const frame = () => lastApp.lastFrame() ?? '';
const branches = () => git('branch', '--format=%(refname:short)').split('\n');

test('your own commands: in the menu with their descriptions, $1 filled in, a list stops at the first that fails, a built-in name is left out', async () => {
  const app = start({
    commands: {
      mk: '/branch $1',
      st: { run: '!status --short', desc: 'Short status' },
      two: ['/branch two-a', '/no-such-command', '/branch two-b'],
      commit: '/quit',
    },
  });
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    assert.match(frame(), /left out/);
    assert.match(frame(), /\/commit is built in/);
    app.stdin.write('/');
    await type(app.stdin, 'st');
    await until(() => /\/st\s+Short status/.test(frame()), 'the menu');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('enter run'), 'out of the prompt');
    app.stdin.write('/');
    await type(app.stdin, 'mk topic');
    app.stdin.write(KEYS.enter);
    await until(() => branches().includes('topic') && git('branch', '--show-current') === 'topic', 'the branch made from $1');
    app.stdin.write('/');
    await type(app.stdin, 'two');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('/two stopped at /no-such-command'), 'the list stopping');
    assert.ok(branches().includes('two-a'));
    assert.ok(!branches().includes('two-b'));
    // The ? window lists them with the slash commands.
    app.stdin.write('?');
    await until(() => frame().includes('Keyboard shortcuts'), 'the help');
    app.stdin.write('/');
    await type(app.stdin, 'short status');
    await until(() => /\/st\s+Short status/.test(frame()), 'in the help');
  } finally {
    app.unmount();
  }
});

test('your own keys: another key in a view, a command anywhere, never while typing, and mistakes said at start-up', async () => {
  git('switch', '-q', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  const app = start({ keys: { global: { F5: '/branch from-f5' }, changes: { x: 'a' }, bogus: { a: 'b' }, graph: { 'ctrl+i': 'x' } } });
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    assert.match(frame(), /"bogus" isn't a view/);
    assert.match(frame(), /"ctrl\+i" is the same as tab/);
    // x does what a does in Changes: stage everything.
    app.stdin.write('2');
    await until(() => frame().includes('a.txt'), 'Changes');
    app.stdin.write('x');
    await until(() => git('diff', '--cached', '--name-only') === 'a.txt', 'a.txt staged');
    app.stdin.write(KEYS.f5);
    await until(() => branches().includes('from-f5'), 'F5 running its command');
    // In the prompt x is just x.
    app.stdin.write('/');
    await type(app.stdin, 'x');
    await until(() => frame().includes('> /x'), 'x typed');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('enter run'), 'out of the prompt');
    app.stdin.write('?');
    await until(() => frame().includes('Keyboard shortcuts'), 'the help');
    app.stdin.write('/');
    await type(app.stdin, 'does what a');
    await until(() => frame().includes('Your keys'), 'Your keys in the help');
  } finally {
    app.unmount();
    git('reset', '-q');
    git('checkout', '-q', '--', 'a.txt');
    git('switch', '-q', 'main');
  }
});

test('ctrl+p: the palette lists the view’s keys and the commands, filters as you type, and runs what’s picked', async () => {
  const app = start({ commands: { st: { run: '!status --short --branch', desc: 'Short status' } } });
  try {
    await until(() => frame().includes('First commit'), 'the graph');
    app.stdin.write(KEYS.ctrlP);
    await until(() => frame().includes('Command palette'), 'the palette');
    // ctrl+p is the palette's alone now: nothing pulled.
    assert.doesNotMatch(frame(), /git pull/);
    assert.match(frame(), /Full diff of the commit\s+Graph/);
    // The Graph's b, a key of its own from "b  t".
    await type(app.stdin, 'new branch here');
    await until(() => /❯ b\s+New branch here/.test(frame()), 'b picked');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('> /branch ') && !frame().includes('Command palette'), 'b run in the graph');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('enter run'), 'out of the prompt');
    // Your command runs.
    app.stdin.write(KEYS.ctrlP);
    await until(() => frame().includes('Command palette'), 'the palette again');
    await type(app.stdin, 'short stat');
    await until(() => /❯ \/st\b/.test(frame()), 'yours picked');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('## main'), 'the status');
    // A command that takes more goes into the prompt, from what was typed there.
    app.stdin.write('/');
    await type(app.stdin, 'checko');
    app.stdin.write(KEYS.ctrlP);
    await until(() => frame().includes('Command palette') && /❯ \/checkout/.test(frame()), 'the palette from the prompt');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('> /checkout ') && !frame().includes('Command palette'), '/checkout waiting in the prompt');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('enter run'), 'out of the prompt');
    // esc closes it, and nothing else happens: q was text.
    app.stdin.write(KEYS.ctrlP);
    await until(() => frame().includes('Command palette'), 'the palette once more');
    await type(app.stdin, 'q');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Command palette') && frame().includes('First commit'), 'closed, still running');
  } finally {
    app.unmount();
  }
});
