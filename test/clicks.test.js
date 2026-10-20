// Clicks and the wheel, driven through the real UI with a stand-in for the terminal's mouse.
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
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-clicks-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  for (let i = 1; i <= 40; i++) {
    writeFileSync(join(dir, 'a.txt'), `${i}\n`);
    git('add', '.');
    git('commit', '-q', '-m', `Commit number ${i}`);
  }
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Once it shows, give the new view's handlers a moment to subscribe, as a person would.
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

/** mouse.js's terminalMouse() without a terminal: records `enable` and sends made-up events. */
function fakeMouse() {
  const listeners = new Set();
  const send = (e) => listeners.forEach((fn) => fn({ button: 'left', release: false, drag: false, ...e }));
  return {
    enabled: [],
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    enable(on) {
      this.enabled.push(on);
    },
    click: (x, y) => send({ x, y }),
    wheel: (x, y, wheel) => send({ x, y, button: 'wheel', wheel }),
    copy: (text) => listeners.forEach((fn) => fn({ type: 'copy', text })),
  };
}

// Where the frame shows `text`: { x, y } of its first character, so clicks land where things were drawn.
// The test frames are ASCII up to these labels, so a string index is a column.
const at = (frame, text) => {
  const lines = frame.split('\n');
  const y = lines.findIndex((l) => l.includes(text));
  assert.ok(y >= 0, `"${text}" isn't on screen:\n${frame}`);
  return { x: lines[y].indexOf(text), y };
};

test('clicks pick rows and tabs, double-clicks do what ↵ does, the wheel scrolls, and the prompt takes the focus', async () => {
  const mouse = fakeMouse();
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, mouse }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Commit number 40'), 'the graph');
    assert.deepEqual(mouse.enabled, [true]);

    // A click puts the cursor on the row, and only moves it.
    let p = at(frame(), 'Commit number 38');
    mouse.click(p.x, p.y);
    await until(() => /❯.*Commit number 38/.test(frame()), 'the cursor on the clicked commit');
    assert.doesNotMatch(frame(), /esc close/);

    // Clicking it again quickly is a double-click: its diff, as ↵ shows it.
    mouse.click(p.x, p.y);
    await until(() => /─ [0-9a-f]{7} Commit number 38 ─.*esc close/.test(frame()), 'the diff of the double-clicked commit');

    // A tab closes what's open over the view and switches to it.
    p = at(frame(), '3 Branches');
    mouse.click(p.x + 2, p.y);
    await until(() => frame().includes('Branches') && frame().includes('1 local'), 'the Branches view');
    assert.doesNotMatch(frame(), /esc close/);
    p = at(frame(), '1 Graph');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('Commit number 40'), 'the graph again');

    // The wheel scrolls the list three rows a notch and leaves the cursor where it was, out of sight.
    p = at(frame(), 'Commit number 40');
    mouse.click(p.x, p.y);
    await until(() => /❯.*Commit number 40/.test(frame()), 'the cursor on top');
    const topRow = () => frame().split('\n')[3];
    mouse.wheel(p.x, p.y, 1);
    mouse.wheel(p.x, p.y, 1);
    await until(() => topRow().includes('Commit number 34'), 'six rows scrolled');
    assert.doesNotMatch(frame(), /❯/, 'the cursor stays on the commit scrolled out of sight');
    mouse.wheel(p.x, p.y, -1);
    await until(() => topRow().includes('Commit number 37'), 'back up a notch');
    // A key moves the cursor from where it was, and the view goes back to it.
    app.stdin.write('j');
    await until(() => /❯.*Commit number 39/.test(topRow()), 'the cursor one down from where it was, in view');

    // The prompt: a click focuses it, and a click on the view gives the keys back, keeping the text.
    p = at(frame(), 'Press / for commands');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('enter run · tab complete'), 'the prompt focused');
    app.stdin.write('x');
    p = at(frame(), 'Commit number 36');
    mouse.click(p.x, p.y);
    await until(() => /❯.*Commit number 36/.test(frame()) && !frame().includes('enter run · tab complete'), 'the view focused again');
    assert.match(frame(), /> x/);

    // Text selected and copied (mouse.js does that): said for a moment in the bottom line.
    mouse.copy('one\ntwo');
    await until(() => frame().includes('Copied 2 lines'), 'the copy noted');
  } finally {
    app.unmount();
  }
});

test('in Changes, a click on a + line steps into the diff to stage its hunk, and a click on the list steps back', async () => {
  writeFileSync(join(dir, 'a.txt'), 'changed\n');
  const mouse = fakeMouse();
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, mouse }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('2 Changes 1'), 'the graph, with a change');
    let p = at(frame(), '2 Changes');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('+changed'), "the file's diff beside the list");
    p = at(frame(), '+changed');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('space stage hunk'), 'the cursor in the diff');
    app.stdin.write(' ');
    await until(() => git('diff', '--cached', '--name-only') === 'a.txt', 'the hunk staged');
    p = at(frame(), 'M a.txt');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('↵ pick hunks'), 'back in the list');
  } finally {
    app.unmount();
    git('reset', '-q', '--hard');
  }
});

test('with the mouse setting off, the terminal is asked not to report it', async () => {
  const mouse = fakeMouse();
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [], mouse: false }, mouse }));
  const app = lastApp;
  try {
    await until(() => (app.lastFrame() ?? '').includes('Commit number 40'), 'the graph');
    assert.deepEqual(mouse.enabled, [false]);
  } finally {
    app.unmount();
  }
});
