import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { settingRows } from '../src/settings.js';
import { DEFAULT_ACCENT, LIGHT_ACCENT, setAccent, theme } from '../src/theme.js';
import { App } from '../src/ui/App.jsx';

test('the settings list: values, plurals, and what ↵ does', () => {
  const rows = settingRows({ recent: [], roots: [], history: [] }, { file: '/home/me/.splice/config.json' });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(rows.map((r) => r.id), ['accent', 'theme', 'mouse', 'checkForUpdates', 'autoUpdate', 'stashUntracked', 'notify', 'sideBySide', 'showSignatures', 'checkBeforePush', 'riskBeforePush', 'familyMoods', 'cleanupKeep', 'roots', 'recent', 'history', 'file']);
  assert.equal(by.accent.value, `${DEFAULT_ACCENT} (default)`);
  // The theme: auto unless set, saying which it is here; ↵ goes round dark, light, auto.
  assert.equal(by.theme.value, 'auto (dark here)');
  assert.equal(by.theme.note, 'dark next');
  assert.equal(settingRows({ theme: 'dark' }).find((r) => r.id === 'theme').note, 'light next');
  assert.equal(settingRows({ theme: 'light' }).find((r) => r.id === 'theme').note, 'auto next: from the terminal, else dark');
  assert.equal(settingRows({ theme: 'light' }).find((r) => r.id === 'theme').value, 'light');
  assert.equal(by.mouse.value, 'on');
  assert.equal(by.checkForUpdates.value, 'on');
  assert.equal(by.autoUpdate.value, 'on');
  assert.equal(by.stashUntracked.value, 'on');
  assert.equal(by.notify.value, 'on');
  assert.equal(by.checkBeforePush.value, 'on');
  assert.equal(settingRows({ checkBeforePush: false }).find((r) => r.id === 'checkBeforePush').value, 'off');
  assert.match(by.notify.note, /after 10 s/);
  assert.match(settingRows({ notifyAfter: 30 }).find((r) => r.id === 'notify').note, /after 30 s/);
  assert.equal(settingRows({ notify: false }).find((r) => r.id === 'notify').value, 'off');
  // Side-by-side diffs: off until turned on.
  assert.equal(by.sideBySide.value, 'off');
  assert.equal(by.sideBySide.off, true);
  assert.equal(settingRows({ sideBySide: true }).find((r) => r.id === 'sideBySide').value, 'on');
  assert.equal(by.showSignatures.value, 'off', 'checking signatures runs gpg, so it waits to be asked for');
  assert.equal(by.showSignatures.off, true);
  assert.equal(by.roots.value, 'none');
  assert.equal(by.cleanupKeep.value, 'none');
  assert.equal(settingRows({ cleanupKeep: ['develop', 'release/*'] }).find((r) => r.id === 'cleanupKeep').value, 'develop, release/*');
  // Nothing to clear: ↵ does nothing.
  assert.equal(by.recent.action, 'none');
  assert.equal(by.file.value, '/home/me/.splice/config.json');

  const set = Object.fromEntries(
    settingRows({ accent: '#ff8800', checkForUpdates: false, autoUpdate: false, roots: ['a'], recent: ['x', 'y'], history: ['/fetch'] }).map((r) => [r.id, r]),
  );
  assert.equal(set.accent.value, '#ff8800');
  assert.equal(set.checkForUpdates.value, 'off');
  assert.match(settingRows({ mouse: false }, { mouse: false }).find((r) => r.id === 'mouse').note, /can't report it/);
  assert.match(set.autoUpdate.note, /only while checking is on/);
  assert.equal(set.roots.value, '1 folder');
  assert.equal(set.recent.value, '2 repositories');
  assert.equal(set.recent.action, 'clear');
  assert.equal(set.history.value, '1 entry');
});

let base;
let lastApp = null;

before(() => {
  // auto is dark here whatever terminal runs the tests.
  delete process.env.COLORFGBG;
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
    // The theme: dark, then light, which repaints at once, then auto again.
    await down('Theme');
    app.stdin.write('\r');
    await until(() => /Theme\s+dark/.test(frame()) && saved().theme === 'dark', 'dark, saved');
    app.stdin.write('\r');
    await until(() => /Theme\s+light/.test(frame()) && saved().theme === 'light', 'light, saved');
    assert.equal(theme.mode, 'light');
    assert.equal(theme.accent, LIGHT_ACCENT, "the default accent's light shade");
    assert.match(frame(), /Accent colour\s+■ #00875f \(default\)/);
    app.stdin.write('\r');
    await until(() => /Theme\s+auto/.test(frame()) && saved().theme === 'auto', 'auto, saved');
    assert.equal(theme.mode, 'dark', "dark where the terminal doesn't say");
    // Accent, checking, then installing: ↵ turns it off, and it's saved at once.
    await down('Mouse');
    await down('Check for new versions');
    await down('Install them by itself');
    app.stdin.write('\r');
    await until(() => /Install them by itself\s+off/.test(frame()) && saved().autoUpdate === false, 'auto-update off, saved');
    assert.match(frame(), /❯ Install them by itself/, 'the cursor stays on the row it changed');

    // Stashing untracked files: on by default, ↵ turns it off.
    await down('Stash untracked files');
    app.stdin.write('\r');
    await until(() => /Stash untracked files\s+off/.test(frame()) && saved().stashUntracked === false, 'untracked stashing off, saved');

    // Notifying when a long command ends: on by default, ↵ turns it off.
    await down('Notify when done');
    app.stdin.write('\r');
    await until(() => /Notify when done\s+off/.test(frame()) && saved().notify === false, 'notifications off, saved');

    // Side-by-side diffs: off by default, ↵ turns it on, and off again.
    await down('Side-by-side diffs');
    app.stdin.write('\r');
    await until(() => /Side-by-side diffs\s+on/.test(frame()) && saved().sideBySide === true, 'side by side on, saved');
    app.stdin.write('\r');
    await until(() => /Side-by-side diffs\s+off/.test(frame()) && saved().sideBySide === false, 'side by side off again, saved');
    // Signatures in the commit pane: off by default, ↵ turns it on.
    await down('Show signatures');
    app.stdin.write('\r');
    await until(() => /Show signatures\s+on/.test(frame()) && saved().showSignatures === true, 'signatures on, saved');
    // Checking the commits before a push: on by default, ↵ turns it off.
    await down('Check before pushing');
    app.stdin.write('\r');
    await until(() => /Check before pushing\s+off/.test(frame()) && saved().checkBeforePush === false, 'the check before pushing off, saved');
    await down('Risk check before push');
    app.stdin.write('\r');
    await until(() => /Risk check before push\s+off/.test(frame()) && saved().riskBeforePush === false, 'the risk check off, saved');
    await down('Family moods');
    app.stdin.write('\r');
    await until(() => /Family moods\s+off/.test(frame()) && saved().familyMoods === false, 'family moods off, saved');

    // The branches /cleanup keeps on the remote: n puts /cleanup-keep in the prompt, x takes one off.
    await down('Keep on the remote');
    app.stdin.write('\r');
    await until(() => frame().includes('Branches /cleanup keeps on the remote') && frame().includes('None: /cleanup deletes'), 'the empty list');
    app.stdin.write('n');
    await until(() => frame().includes('/cleanup-keep '), '/cleanup-keep in the prompt');
    await type(app.stdin, 'release/*');
    app.stdin.write('\r');
    await until(() => /❯ release\/\*/.test(frame()) && saved().cleanupKeep?.[0] === 'release/*', 'the pattern listed, saved');
    app.stdin.write('x');
    await until(() => frame().includes('None: /cleanup deletes') && saved().cleanupKeep.length === 0, 'the pattern removed');
    app.stdin.write('\x1b');
    await until(() => /Keep on the remote\s+none/.test(frame()), 'back in the settings, up to date');

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
