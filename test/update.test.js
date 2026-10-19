import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { checkForUpdate, compareVersions } from '../src/update.js';
import { App } from '../src/ui/App.jsx';

test('versions compare by number, with pre-releases before their release', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('v1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('v0.2.0', '0.2.0'), 0);
  assert.ok(compareVersions('0.3.0-beta.1', '0.3.0') < 0);
  assert.ok(compareVersions('0.3.0-beta.1', '0.2.0') > 0);
  assert.equal(compareVersions('nightly', '0.2.0'), 0);
  assert.equal(compareVersions(undefined, '0.2.0'), 0);
});

test('asks at most once a day, and only says "newer" for a newer release', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  let asked = 0;
  const fetchLatest = async () => {
    asked++;
    return { version: '0.3.0', url: 'https://example.com/v0.3.0' };
  };
  const first = await checkForUpdate(undefined, { current: '0.2.0', now: 1000, fetchLatest });
  assert.deepEqual(first, { checked: { at: 1000, latest: '0.3.0', url: 'https://example.com/v0.3.0' }, newer: true });
  assert.equal(asked, 1);

  const sameDay = await checkForUpdate(first.checked, { current: '0.2.0', now: 1000 + DAY - 1, fetchLatest });
  assert.equal(asked, 1);
  assert.equal(sameDay.newer, true);
  assert.equal((await checkForUpdate(first.checked, { current: '0.3.0', now: 2000, fetchLatest })).newer, false);

  await checkForUpdate(first.checked, { current: '0.2.0', now: 1000 + DAY, fetchLatest });
  assert.equal(asked, 2);
  // A clock that went back doesn't keep an old answer forever.
  await checkForUpdate({ ...first.checked, at: 10 * DAY }, { current: '0.2.0', now: DAY, fetchLatest });
  assert.equal(asked, 3);
});

test('the app shows a newer release, keeps the check in the config, and can be told not to ask', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tiller-update-'));
  const prevHome = process.env.TILLER_HOME;
  process.env.TILLER_HOME = join(home, 'home');
  const notRepo = join(home, 'empty');
  const until = async (check, what) => {
    const end = Date.now() + 8000;
    while (!check()) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  let calls = 0;
  const checkUpdate = async (last) => {
    calls++;
    assert.equal(last, undefined);
    return { checked: { at: 5, latest: '9.9.9', url: 'https://example.com/latest' }, newer: true };
  };
  try {
    const app = render(React.createElement(App, { initialPath: notRepo, config: { recent: [], roots: [], history: [] }, checkUpdate }));
    try {
      await until(() => /Tiller 9\.9\.9 is out/.test(app.lastFrame() ?? ''), 'the update note');
      await until(() => {
        try {
          return JSON.parse(readFileSync(join(home, 'home', 'config.json'), 'utf8')).lastUpdateCheck?.latest === '9.9.9';
        } catch {
          return false;
        }
      }, 'the check to be saved');
    } finally {
      app.unmount();
    }

    const off = render(React.createElement(App, { initialPath: notRepo, config: { recent: [], roots: [], history: [], checkForUpdates: false }, checkUpdate }));
    try {
      // Not a repository, so the first load ends in the Repos view (the note naming the path can be cut off).
      await until(() => /Repositories/.test(off.lastFrame() ?? ''), 'the first load');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(calls, 1);
      assert.doesNotMatch(off.lastFrame(), /is out/);
    } finally {
      off.unmount();
    }
  } finally {
    if (prevHome === undefined) delete process.env.TILLER_HOME;
    else process.env.TILLER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
