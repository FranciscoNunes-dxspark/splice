// /filter: the graph narrowed to commits by an author, touching a path, in a date range, through the real UI.
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
const git = (args, env = {}) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-filter-'));
  dir = join(base, 'repo');
  mkdirSync(dir);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'docs'));
  process.env.SPLICE_HOME = join(base, 'home');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'commit.gpgsign', 'false']);
  const commit = (file, subject, name, date) => {
    writeFileSync(join(dir, file), `${subject}\n`);
    git(['add', '.']);
    git(['commit', '-q', '-m', subject], {
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@example.com`, GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: `${name.toLowerCase()}@example.com`, GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z`,
    });
  };
  commit('src/a.txt', 'Alpha', 'Ana', '2026-01-10');
  commit('docs/b.md', 'Beta', 'Bo', '2026-02-10');
  commit('docs/c.md', 'Gamma', 'Ana', '2026-03-10');
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

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('/filter narrows the graph by author, then by path and date; esc brings it all back', async () => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const command = async (text) => {
    app.stdin.write('/');
    await type(app.stdin, text);
    await until(() => frame().includes(`/${text}`), `the typed /${text}`);
    app.stdin.write('\r');
  };
  try {
    await until(() => frame().includes('Gamma') && frame().includes('Alpha'), 'the graph');
    await command('filter --author ana');
    await until(() => frame().includes('Commits by ana (2)'), 'the commits by Ana');
    assert.match(frame(), /Gamma/);
    assert.match(frame(), /Alpha/);
    assert.doesNotMatch(frame(), /Beta/);

    await command('filter --path docs --since 2026-03-01');
    await until(() => frame().includes('Commits touching docs, since 2026-03-01 (1)'), 'the filtered commits');
    assert.match(frame(), /Gamma/);
    assert.doesNotMatch(frame(), /Beta|Alpha/);

    app.stdin.write('\x1b');
    await until(() => frame().includes('Beta') && frame().includes('Alpha') && !frame().includes('Commits touching'), 'the full graph again');
  } finally {
    app.unmount();
  }
});
