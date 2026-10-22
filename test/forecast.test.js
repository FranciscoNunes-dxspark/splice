// Conflict forecasts: the pure parts, git merge-tree on a throwaway repository, then the marks in the
// Branches view, /forecast, and the question before a merge or rebase, through the real UI.
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
import { atLeast, fileList, forecast, forecastLine, forecastText, knownForecast, parseForecast, parseGitVersion } from '../src/forecast.js';

const TREE = 'fdbdf009740140731bf2cd51e41d86f333121e26';

test("git's version, however it's spelled", () => {
  assert.deepEqual(parseGitVersion('git version 2.43.0\n'), [2, 43, 0]);
  assert.deepEqual(parseGitVersion('git version 2.39.2.windows.1'), [2, 39, 2]);
  assert.deepEqual(parseGitVersion('git version 2.37.1 (Apple Git-137.1)'), [2, 37, 1]);
  assert.equal(parseGitVersion('nonsense'), null);
  assert.equal(atLeast([2, 38, 0], [2, 38]), true);
  assert.equal(atLeast([3, 0, 0], [2, 38]), true);
  assert.equal(atLeast([2, 37, 9], [2, 38]), false);
  assert.equal(atLeast(null, [2, 38]), false);
});

test('merge-tree output: clean, conflicted (names once each), or an error', () => {
  assert.deepEqual(parseForecast(`${TREE}\0`, 0), { conflicts: false, files: [] });
  assert.deepEqual(parseForecast(`${TREE}\0a.txt\0sp ace.txt\0a.txt\0`, 1), { conflicts: true, files: ['a.txt', 'sp ace.txt'] });
  // A ref that doesn't exist exits 1 too, with nothing on stdout.
  assert.equal(parseForecast('', 1), null);
  assert.equal(parseForecast(`${TREE}\0`, 128), null);
});

test('what the questions and /forecast say', () => {
  assert.equal(fileList(['a', 'b', 'c', 'd', 'e']), 'a, b, c and 2 more');
  const f = { conflicts: true, files: ['a.txt'] };
  assert.equal(forecastLine(f, 'merge'), 'Would conflict in a.txt (git merge-tree).');
  assert.match(forecastLine(f, 'rebase'), /^Expect conflicts in a\.txt \(an estimate/);
  assert.match(forecastLine({ conflicts: false, files: [] }, 'rebase'), /^No conflicts expected/);
  assert.equal(forecastLine(null), '');
  assert.match(forecastText(f, 'x', 'main'), /^x and main would conflict in 1 file, merging either way round:\n {2}a\.txt\nA rebase/);
  assert.match(forecastText({ conflicts: false, files: [] }, 'x', 'main'), /^x and main merge without conflicts/);
});

let base;
let dir;
let origin;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const commit = (file, text, message) => {
  writeFileSync(join(dir, file), text);
  git('add', '.');
  git('commit', '-q', '-m', message);
};

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-forecast-'));
  dir = join(base, 'repo');
  origin = join(base, 'origin.git');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  commit('a.txt', 'one\n', 'First commit');
  git('switch', '-q', '-c', 'clash');
  commit('a.txt', 'clash\n', 'Clashing work');
  git('switch', '-q', '-c', 'calm', 'main');
  commit('b.txt', 'calm\n', 'Calm work');
  git('switch', '-q', 'main');
  commit('a.txt', 'two\n', 'Main moves on');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  git('remote', 'set-head', 'origin', 'main');
});

after(() => removeTemp(base));

test('forecast runs merge-tree without touching the working tree, and keeps the answer per pair of commits', async () => {
  const [main, clash, calm] = ['main', 'clash', 'calm'].map((r) => git('rev-parse', r));
  const before = git('status', '--porcelain');
  assert.deepEqual(await forecast(dir, main, clash, { oids: [main, clash] }), { conflicts: true, files: ['a.txt'] });
  assert.deepEqual(await forecast(dir, 'calm', 'main'), { conflicts: false, files: [] });
  assert.equal(git('status', '--porcelain'), before);
  assert.equal(git('rev-parse', 'HEAD'), main);
  // Kept either way round, and only when the commits are named.
  assert.deepEqual(knownForecast(clash, main), { conflicts: true, files: ['a.txt'] });
  assert.equal(knownForecast(main, calm), undefined);
  await assert.rejects(forecast(dir, 'main', 'no-such-branch'), /no-such-branch/);
});

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
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

const command = async (app, text) => {
  app.stdin.write('/');
  await type(app.stdin, text);
  await until(() => app.lastFrame().includes(`/${text}`), `the typed /${text}`);
  app.stdin.write('\r');
};

test('Branches marks the branch that would conflict with the default branch, and the pane lists the files', async () => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Main moves on'), 'the graph');
    app.stdin.write('3');
    // The cursor starts on calm, the first by name.
    await until(() => /clash\s+⚠/.test(frame()), 'the mark on clash');
    assert.doesNotMatch(frame(), /calm\s+⚠/);
    await until(() => frame().includes('Merges with main without conflicts'), 'calm merging cleanly');
    app.stdin.write('j');
    await until(() => frame().includes('⚠ Would conflict in 1 file'), 'the forecast for clash');
    assert.match(frame(), /│ {2}a\.txt/);
    // Nothing was merged or changed on the way.
    assert.equal(git('status', '--porcelain'), '');

    await command(app, 'forecast clash');
    await until(() => frame().includes('clash and origin/main would conflict in 1 file'), '/forecast against the default branch');
    await command(app, 'forecast calm clash');
    await until(() => frame().includes('calm and clash merge without conflicts'), '/forecast for any two');

    // m on clash: the question says what to expect.
    app.stdin.write('m');
    await until(() => frame().includes('Merge clash into main?'), 'the merge question');
    assert.match(frame(), /Would conflict in a\.txt \(git merge-tree\)/);
    app.stdin.write('2');
    await until(() => !frame().includes('Merge clash into main?'), 'the merge question gone');
    app.stdin.write('e');
    await until(() => frame().includes('Rebase main onto clash?'), 'the rebase question');
    assert.match(frame(), /Expect conflicts in a\.txt \(an estimate/);
    app.stdin.write('2');
    await until(() => !frame().includes('Rebase main onto clash?'), 'the question gone');
    assert.equal(git('log', '-1', '--format=%s'), 'Main moves on');
  } finally {
    app.unmount();
  }
});
