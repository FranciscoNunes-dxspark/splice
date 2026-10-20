// /update: looks for a new version at once and installs it, with stand-ins for GitHub and the install.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { App } from '../src/ui/App.jsx';
import { VERSION } from '../src/version.js';

let base;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-update-'));
  process.env.SPLICE_HOME = join(base, 'home');
  mkdirSync(join(base, 'empty'));
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

const run = async (app, command) => {
  app.stdin.write('/');
  await new Promise((r) => setTimeout(r, 50));
  for (const ch of command) app.stdin.write(ch);
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write('\r');
};

test('/update looks at once, whatever the daily check said, installs, and says so', async () => {
  const asked = [];
  const installed = [];
  const checked = { at: Date.now(), latest: '99.0.0', url: 'https://example.com/releases/latest' };
  // The daily check at the start, turned off, never asks; /update does, with no last answer to reuse.
  const config = { recent: [], roots: [], history: [], checkForUpdates: false, lastUpdateCheck: { at: Date.now(), latest: VERSION } };
  const checkUpdate = async (last) => {
    asked.push(last);
    return { checked, newer: true };
  };
  const installUpdate = async (v) => installed.push(v);
  lastApp = render(React.createElement(App, { initialPath: join(base, 'empty'), config, checkUpdate, installUpdate }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Repositories'), 'the first load');
    assert.equal(asked.length, 0);
    await run(app, 'update');
    await until(() => frame().includes('Splice 99.0.0 is installed'), 'the install');
    assert.deepEqual(asked, [null]);
    assert.deepEqual(installed, ['99.0.0']);
    // Once installed, another /update just says so.
    await run(app, 'update');
    await until(() => frame().includes('It starts the next time you open Splice') && installed.length === 1, 'the reminder');
  } finally {
    app.unmount();
  }
});

test('/update from a checkout says git pull updates it', async () => {
  lastApp = render(React.createElement(App, { initialPath: join(base, 'empty'), config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  try {
    await until(() => (app.lastFrame() ?? '').includes('Repositories'), 'the first load');
    await run(app, 'update');
    await until(() => (app.lastFrame() ?? '').includes('git pull updates it'), 'the answer');
  } finally {
    app.unmount();
  }
});
