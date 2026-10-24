// Sparse checkout: reading it from git's files (pure), then /sparse through the UI against a throwaway
// repository: set (asking first, refusing over uncommitted changes), the header, add from a picker, off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { changedOutside, coneFolders, configFlag, inCone, leavingFolders, sparsePatterns, sparseState, sparseText } from '../src/sparse.js';
import { findRepo, readSparse } from '../src/repo.js';
import { App } from '../src/ui/App.jsx';

test('config flags, as git writes them and by hand', () => {
  const text = '[core]\n\trepositoryformatversion = 0\n\tsparseCheckout = true\n[extensions]\n\tworktreeConfig = true\n[core] # again\n\tSPARSECHECKOUTCONE = false ; off\n[remote "origin"]\n\tsparseCheckout = true\n';
  assert.equal(configFlag(text, 'core', 'sparseCheckout'), true);
  assert.equal(configFlag(text, 'core', 'sparseCheckoutCone'), false, 'any case, the last one set');
  assert.equal(configFlag(text, 'core', 'bare'), null);
  assert.equal(configFlag('[core]\n\tsparseCheckout\n', 'core', 'sparseCheckout'), true, 'a bare key is true');
  assert.equal(configFlag('[core] sparseCheckout = yes', 'core', 'sparseCheckout'), true);
});

test('cone folders, the state, and what leaves the working tree', () => {
  const file = '/*\n!/*/\n/src/\n!/src/*/\n/src/ui/\n/docs/\n/a\\ b/\n';
  const patterns = sparsePatterns(file);
  assert.deepEqual(coneFolders(patterns), ['src/ui', 'docs', 'a b'], 'src is only a parent');
  assert.deepEqual(sparseState({ config: '[core]\n\tsparseCheckout = true\n', file }), { on: true, cone: true, folders: ['src/ui', 'docs', 'a b'], patterns });
  // Set in the worktree's own config, as git sparse-checkout does; cone mode from the file's shape when unset.
  assert.equal(sparseState({ worktreeConfig: '[core]\n\tsparseCheckout = true\n', file }).cone, true);
  const plain = sparseState({ config: '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = false\n', file: '*.md\n/lib/\n' });
  assert.deepEqual([plain.on, plain.cone, plain.folders, plain.patterns], [true, false, [], ['*.md', '/lib/']]);
  assert.equal(sparseState({ file }).on, false, 'the file alone is not sparse checkout');
  assert.equal(inCone('README.md', ['src/ui']), true, 'the top stays');
  assert.equal(inCone('src/index.js', ['src/ui']), true, 'files directly in a parent stay');
  assert.equal(inCone('src/ui/deep/x.js', ['src/ui']), true);
  assert.equal(inCone('src/lib/x.js', ['src/ui']), false);
  assert.equal(inCone('docs\\x.md', ['docs/']), true, 'Windows paths and trailing slashes');
  assert.deepEqual(leavingFolders(['src/ui', 'docs', 'lib/a'], ['src', 'lib']), ['docs']);
  assert.deepEqual(changedOutside([{ path: 'a.txt' }, { path: 'b/x' }, { path: 'c/y' }], ['c']).map((f) => f.path), ['b/x']);
  assert.match(sparseText({ on: false }), /off/);
  assert.match(sparseText({ on: true, cone: true, folders: ['src'], patterns: [] }), /cone mode[\s\S]+ {2}src\//);
  assert.match(sparseText({ on: true, cone: false, folders: [], patterns: ['*.md'] }), /not cone mode[\s\S]+ {2}\*\.md/);
});

let base;
let dir;
let lastApp = null;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const git = (...args) => run(dir, ...args);

before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'splice-narrow-')));
  dir = join(base, 'repo');
  mkdirSync(dir);
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  for (const d of ['web', 'api', 'docs']) {
    mkdirSync(join(dir, d));
    writeFileSync(join(dir, d, 'index.txt'), `${d}\n`);
  }
  writeFileSync(join(dir, 'README.md'), 'top\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Three folders');
});

after(() => removeTemp(base));

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let ok = false;
    try {
      ok = check();
    } catch {
      // not yet
    }
    if (ok) return new Promise((r) => setTimeout(r, 100));
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

async function command(app, text) {
  app.stdin.write('/');
  await until(() => app.lastFrame().includes('> /'), 'the prompt');
  await type(app.stdin, text);
  await until(() => app.lastFrame().includes(`> /${text}`), `/${text} typed`);
  app.stdin.write('\r');
}

test('/sparse: off, set (asking first), the header, refusing over changes, add from a picker, off', async () => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const header = () => frame().split('\n')[0];
  try {
    await until(() => frame().includes('Three folders'), 'the graph');
    assert.doesNotMatch(header(), /sparse/);
    await command(app, 'sparse');
    await until(() => frame().includes('Sparse checkout: off'), '/sparse alone');
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Sparse checkout: off'), 'closed');

    await command(app, 'sparse set web');
    await until(() => frame().includes('Check out only web?'), 'the question');
    app.stdin.write('2');
    await until(() => !frame().includes('Check out only web?'), 'no');
    assert.equal(existsSync(join(dir, 'api', 'index.txt')), true, 'nothing changed');
    await command(app, 'sparse set web');
    await until(() => frame().includes('Check out only web?'), 'asked again');
    app.stdin.write('1');
    await until(() => !existsSync(join(dir, 'api', 'index.txt')) && /sparse/.test(header()), 'api gone, and the header says so');
    assert.equal(existsSync(join(dir, 'web', 'index.txt')), true);
    assert.equal(existsSync(join(dir, 'README.md')), true, 'the top stays');
    assert.deepEqual((await readSparse(await findRepo(dir))).folders, ['web']);

    await command(app, 'sparse');
    await until(() => frame().includes('Sparse checkout: on, cone mode'), 'the state');
    assert.match(frame(), / {2}web\//);
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Sparse checkout: on'), 'closed');

    // A change in web, which /sparse set docs would take out of the working tree: refused.
    writeFileSync(join(dir, 'web', 'index.txt'), 'changed\n');
    await until(() => frame().includes('1 change'), 'the change noticed');
    await command(app, 'sparse set docs');
    await until(() => frame().includes('Not now: a file that would leave the working tree has uncommitted changes (web/index.txt)'), 'refused');
    git('checkout', '--', 'web/index.txt');
    await until(() => frame().includes('✓ clean'), 'clean again');

    await command(app, 'sparse add');
    await until(() => frame().includes('Add a folder to the sparse checkout') && frame().includes('docs/'), 'the folder picker');
    assert.doesNotMatch(frame(), /❯ web\//, 'a folder checked out already is left out');
    while (!/❯ docs\//.test(frame())) {
      app.stdin.write('j');
      await new Promise((r) => setTimeout(r, 60));
    }
    app.stdin.write('\r');
    await until(() => existsSync(join(dir, 'docs', 'index.txt')), 'docs back');
    assert.equal(existsSync(join(dir, 'api', 'index.txt')), false);

    // Taking web out again asks first, naming it.
    await command(app, 'sparse set docs');
    await until(() => frame().includes('Take web out of the working tree?'), 'the question naming what leaves');
    app.stdin.write('2');
    await until(() => !frame().includes('Take web out'), 'no');

    await command(app, 'sparse off');
    await until(() => existsSync(join(dir, 'api', 'index.txt')) && !/sparse/.test(header()), 'everything back');
  } finally {
    app.unmount();
  }
});
