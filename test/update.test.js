import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { assetName, checkForUpdate, compareVersions, installUpdate, parseChecksums, removeOldExecutables } from '../src/update.js';
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

test('the release file for each platform, and the checksums file', () => {
  assert.equal(assetName('win32', 'x64'), 'tiller-windows-x64.exe');
  assert.equal(assetName('darwin', 'arm64'), 'tiller-macos-arm64');
  assert.equal(assetName('linux', 'x64'), 'tiller-linux-x64');
  assert.equal(assetName('win32', 'arm64'), null);
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  const sums = parseChecksums(`${a}  tiller-linux-x64\r\n${b} *tiller-windows-x64.exe\nnot a line\n`);
  assert.deepEqual([...sums], [
    ['tiller-linux-x64', a],
    ['tiller-windows-x64.exe', 'b'.repeat(64)],
  ]);
});

test('installing an update swaps the executable, only with a matching checksum, and tidies up after', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiller-install-'));
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  // Stands in for GitHub: the release's files, written where installUpdate asks.
  const release = (content, sum = sha(content)) => async (version, names, into) => {
    assert.equal(version, '0.3.0');
    writeFileSync(join(into, names[0]), content);
    writeFileSync(join(into, names[1]), `${sum}  ${names[0]}\n`);
  };
  const leftovers = () => readdirSync(dir).filter((f) => f.startsWith('.tiller-update-'));
  try {
    // Windows: the running one is renamed aside, and the new one takes its name.
    const exe = join(dir, 'tiller.exe');
    writeFileSync(exe, 'old build');
    const win = { exe, platform: 'win32', arch: 'x64', installed: async () => '0.2.0' };
    assert.equal(await installUpdate('0.3.0', { ...win, download: release('new build') }), 'installed');
    assert.equal(readFileSync(exe, 'utf8'), 'new build');
    const aside = readdirSync(dir).filter((f) => f.startsWith('tiller.exe.old.'));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(dir, aside[0]), 'utf8'), 'old build');
    assert.deepEqual(leftovers(), []);

    // A download that doesn't match its checksum leaves everything as it was.
    writeFileSync(exe, 'current');
    await assert.rejects(installUpdate('0.3.0', { ...win, download: release('tampered', sha('something else')) }), /doesn't match its checksum/);
    assert.equal(readFileSync(exe, 'utf8'), 'current');
    assert.deepEqual(leftovers(), []);

    // Already that version (another window installed it): nothing is downloaded.
    let downloads = 0;
    const counted = async (...args) => {
      downloads++;
      return release('x')(...args);
    };
    assert.equal(await installUpdate('0.3.0', { ...win, installed: async () => '0.3.0', download: counted }), 'already');
    assert.equal(downloads, 0);

    // macOS and Linux: a rename replaces it in one step, with nothing set aside.
    const unixExe = join(dir, 'tiller');
    writeFileSync(unixExe, 'old build');
    await installUpdate('0.3.0', { exe: unixExe, platform: 'linux', arch: 'x64', installed: async () => '0.2.0', download: release('new build') });
    assert.equal(readFileSync(unixExe, 'utf8'), 'new build');
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('tiller.old.')));

    await assert.rejects(installUpdate('0.3.0', { ...win, arch: 'arm64', download: release('x') }), /no release build/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  }
});

test('old executables and abandoned downloads are removed, but not a download still going', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiller-old-'));
  try {
    const exe = join(dir, 'tiller.exe');
    writeFileSync(exe, 'current');
    writeFileSync(join(dir, 'tiller.exe.old.1700000000000'), 'old');
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    mkdirSync(join(dir, '.tiller-update-stale'));
    mkdirSync(join(dir, '.tiller-update-busy'));
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(join(dir, '.tiller-update-stale'), twoHoursAgo, twoHoursAgo);
    await removeOldExecutables(exe);
    assert.deepEqual(readdirSync(dir).sort(), ['.tiller-update-busy', 'notes.txt', 'tiller.exe']);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  }
});

test('the app installs a newer release in the background, says when it can\'t, and can be told only to tell', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tiller-autoupdate-'));
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
  const checkUpdate = async () => ({ checked: { at: 5, latest: '9.9.9', url: 'https://example.com/latest' }, newer: true });
  const open = async (config, installUpdate, check) => {
    const app = render(React.createElement(App, { initialPath: notRepo, config: { recent: [], roots: [], history: [], ...config }, checkUpdate, installUpdate }));
    try {
      await until(() => check(app.lastFrame() ?? ''), 'the update note');
    } finally {
      app.unmount();
    }
  };
  try {
    const asked = [];
    await open({}, async (v) => asked.push(v), (f) => /Tiller 9\.9\.9 is installed/.test(f));
    assert.deepEqual(asked, ['9.9.9']);

    await open({}, async () => {
      throw new Error("can't write to C:\\Program Files\\Tiller\nmore detail");
    }, (f) => /couldn't be installed: can't write to/.test(f) && /example\.com\/latest/.test(f));

    let called = false;
    await open({ autoUpdate: false }, async () => {
      called = true;
    }, (f) => /Tiller 9\.9\.9 is out/.test(f));
    assert.equal(called, false);
  } finally {
    if (prevHome === undefined) delete process.env.TILLER_HOME;
    else process.env.TILLER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true, maxRetries: 10 });
  }
});
