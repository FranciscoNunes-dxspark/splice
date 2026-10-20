import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { settingRows } from '../src/settings.js';
import { DEFAULT_ACCENT, setAccent, theme } from '../src/theme.js';
import { App } from '../src/ui/App.jsx';

test('the settings list: values, plurals, and what ↵ does', () => {
  const rows = settingRows({ recent: [], roots: [], history: [] }, { file: '/home/me/.splice/config.json' });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(rows.map((r) => r.id), ['accent', 'checkForUpdates', 'autoUpdate', 'roots', 'recent', 'history', 'file']);
  assert.equal(by.accent.value, `${DEFAULT_ACCENT} (default)`);
  assert.equal(by.checkForUpdates.value, 'on');
  assert.equal(by.autoUpdate.value, 'on');
  assert.equal(by.roots.value, 'none');
  // Nothing to clear: ↵ does nothing.
  assert.equal(by.recent.action, 'none');
  assert.equal(by.file.value, '/home/me/.splice/config.json');

  const set = Object.fromEntries(
    settingRows({ accent: '#ff8800', checkForUpdates: false, autoUpdate: false, roots: ['a'], recent: ['x', 'y'], history: ['/fetch'] }).map((r) => [r.id, r]),
  );
  assert.equal(set.accent.value, '#ff8800');
  assert.equal(set.checkForUpdates.value, 'off');
  assert.match(set.autoUpdate.note, /only while checking is on/);
  assert.equal(set.roots.value, '1 folder');
  assert.equal(set.recent.value, '2 repositories');
  assert.equal(set.recent.action, 'clear');
  assert.equal(set.history.value, '1 entry');
});

let base;
let lastApp = null;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-settings-'));
  process.env.SPLICE_HOME = join(base, 'home');
  mkdirSync(join(base, 'empty'));
});

after(async () => {
  setAccent(undefined);
  await removeTemp(base);
});

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
      if (check()) return new Promise((r) => setTimeout(r, 100));
    } catch {
      // The config file mid-write: not yet.
    }
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

const saved = () => JSON.parse(readFileSync(join(base, 'home', 'config.json'), 'utf8'));

test('settings change in place, are saved as they change, and the accent repaints', async () => {
  const folder = join(base, 'projects');
  const config = { recent: [join(base, 'a'), join(base, 'b')], roots: [folder], history: ['/fetch'] };
  lastApp = render(React.createElement(App, { initialPath: join(base, 'empty'), config }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Repositories'), 'the first load');
    app.stdin.write(',');
    await until(() => frame().includes('Settings') && /Install them by itself\s+on/.test(frame()), 'the settings');

    // One row down, waiting for the cursor to get there, as a person would.
    const down = async (label) => {
      app.stdin.write('j');
      await until(() => new RegExp(`❯ ${label}`).test(frame()), `the cursor on ${label}`);
    };
    // Accent, checking, then installing: ↵ turns it off, and it's saved at once.
    await down('Check for new versions');
    await down('Install them by itself');
    app.stdin.write('\r');
    await until(() => /Install them by itself\s+off/.test(frame()) && saved().autoUpdate === false, 'auto-update off, saved');
    assert.match(frame(), /❯ Install them by itself/, 'the cursor stays on the row it changed');

    // The folders: x stops scanning one, and the count in the list follows.
    await down('Folders to scan');
    app.stdin.write('\r');
    await until(() => frame().includes('Folders to scan for repositories') && frame().includes('projects'), 'the folders');
    app.stdin.write('x');
    await until(() => frame().includes('No folders yet') && saved().roots.length === 0, 'the folder removed');
    app.stdin.write('\x1b');
    await until(() => /Folders to scan\s+none/.test(frame()), 'back in the settings, up to date');

    // Recent repositories: asks first.
    await down('Recent repositories');
    app.stdin.write('\r');
    await until(() => frame().includes('Forget the 2 repositories?'), 'the question');
    app.stdin.write('1');
    await until(() => /Recent repositories\s+none/.test(frame()) && saved().recent.length === 0, 'recent forgotten');

    // The accent: ↵ on it puts /accent in the prompt to edit. Checked, saved, repainted, and back to the default.
    app.stdin.write('g');
    await until(() => /❯ Accent colour/.test(frame()), 'the cursor on the accent');
    const setAccentTo = async (value) => {
      app.stdin.write('\r');
      await until(() => frame().includes('> /accent #'), 'the accent in the prompt');
      app.stdin.write('\x15'); // ctrl+u clears the line
      await type(app.stdin, `/accent ${value}`);
      app.stdin.write('\r');
    };
    await setAccentTo('pink');
    await until(() => frame().includes("pink isn't a colour"), 'the complaint');
    await setAccentTo('#FF8800');
    await until(() => frame().includes('#ff8800') && saved().accent === '#ff8800', 'the accent saved');
    assert.equal(theme.accent, '#ff8800');
    await setAccentTo('default');
    await until(() => !('accent' in saved()) && frame().includes('(default)'), 'the default back');
    assert.equal(theme.accent, DEFAULT_ACCENT);

    app.stdin.write('\x1b');
    await until(() => !frame().includes('Accent colour'), 'the settings to close');
  } finally {
    app.unmount();
  }
});
