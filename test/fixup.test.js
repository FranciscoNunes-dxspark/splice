// Fixups and history search, driven through the real UI against throwaway repositories.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.jsx';

const KEYS = { enter: '\r', esc: '\x1b' };

let base;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'tiller-fixup-'));
  process.env.TILLER_HOME = join(base, 'home');
});

after(() => rmSync(base, { recursive: true, force: true, maxRetries: 10 }));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
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

/** A new repository in `name`, with one commit per subject (each adding <subject>.txt). Returns its git runner. */
function makeRepo(name, subjects) {
  const dir = join(base, name);
  mkdirSync(dir);
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@example.com');
  g('config', 'commit.gpgsign', 'false');
  for (const s of subjects) {
    writeFileSync(join(dir, `${s}.txt`), `${s}\n`);
    g('add', '.');
    g('commit', '-q', '-m', s);
  }
  return { dir, g };
}

function start(dir) {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  return lastApp;
}

async function command(app, text) {
  app.stdin.write('/');
  await type(app.stdin, text);
  await until(() => app.lastFrame().includes(`/${text}`), `the typed command /${text}`);
  app.stdin.write(KEYS.enter);
}

test('F picks an older commit, commits the fixup and folds it in, keeping other changes', async () => {
  const { dir, g } = makeRepo('fold-repo', ['Alpha', 'Beta', 'Gamma']);
  writeFileSync(join(dir, 'Alpha.txt'), 'Alpha, fixed\n');
  g('add', 'Alpha.txt');
  // An unstaged change elsewhere: the fold sets it aside and puts it back.
  writeFileSync(join(dir, 'Gamma.txt'), 'Gamma\nwork in progress\n');
  const app = start(dir);
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Gamma'), 'the graph');
    app.stdin.write('2');
    await until(() => frame().includes('Staged (1)') && /❯ M Gamma\.txt/.test(frame()), 'the Changes view');
    app.stdin.write('F');
    await until(() => frame().includes('Fix up which commit on main?') && /now\s+Alpha/.test(frame()), 'the picker with its commits');
    // Newest first: Gamma, Beta, Alpha.
    assert.match(frame(), /❯ [0-9a-f]{7}\s+now\s+Gamma/);
    app.stdin.write('j');
    await until(() => /❯ [0-9a-f]{7}\s+now\s+Beta/.test(frame()), 'the cursor on Beta');
    app.stdin.write('j');
    await until(() => /❯ [0-9a-f]{7}\s+now\s+Alpha/.test(frame()), 'the cursor on Alpha');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Fold it into "Alpha" now?'), 'the question');
    assert.equal(g('log', '-1', '--format=%s'), 'fixup! Alpha');
    assert.match(frame(), /other changes are stashed meanwhile/);
    app.stdin.write('1');
    await until(() => g('log', '--format=%s') === 'Gamma\nBeta\nAlpha', 'the fixup to be folded in');
    // The fix landed in Alpha itself, and nothing else changed there.
    assert.equal(g('show', 'HEAD~2:Alpha.txt'), 'Alpha, fixed');
    assert.equal(g('show', '--name-only', '--format=', 'HEAD~2'), 'Alpha.txt');
    assert.equal(g('status', '--porcelain'), 'M Gamma.txt');
    assert.equal(readFileSync(join(dir, 'Gamma.txt'), 'utf8'), 'Gamma\nwork in progress\n');
    await until(() => !frame().includes('REBASING'), 'no rebase left in progress');
  } finally {
    app.unmount();
  }
});

test('/fixup <ref> with nothing staged stages everything, warns that the commit is pushed, and "No" keeps the fixup! commit', async () => {
  const { dir, g } = makeRepo('later-repo', ['One', 'Two']);
  const remote = join(base, 'later-remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  g('remote', 'add', 'origin', remote);
  g('push', '-q', '-u', 'origin', 'main');
  writeFileSync(join(dir, 'One.txt'), 'One, fixed\n');
  const app = start(dir);
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Two'), 'the graph');
    await command(app, 'fixup HEAD~1');
    await until(() => frame().includes('Nothing is staged. Stage all changes for the fixup?'), 'the offer to stage');
    app.stdin.write('1');
    await until(() => frame().includes('Fold it into "One" now?'), 'the question');
    assert.match(frame(), /already on origin\/main: folding rewrites pushed history/);
    app.stdin.write('2');
    await until(() => frame().includes('Kept "fixup! One"'), 'the note about folding later');
    assert.equal(g('log', '--format=%s'), 'fixup! One\nTwo\nOne');
    assert.equal(g('show', '--name-only', '--format=', 'HEAD'), 'One.txt');
    assert.equal(g('status', '--porcelain'), '');
  } finally {
    app.unmount();
  }
});

test('fixups are refused on a detached HEAD', async () => {
  const { dir, g } = makeRepo('detached-repo', ['First', 'Second']);
  g('switch', '-q', '--detach', 'HEAD~1');
  writeFileSync(join(dir, 'First.txt'), 'changed\n');
  const app = start(dir);
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Second'), 'the graph');
    await command(app, 'fixup');
    await until(() => frame().includes('HEAD is detached'), 'the refusal');
    assert.equal(g('log', '-1', '--format=%s'), 'First');
  } finally {
    app.unmount();
  }
});

test('/find -S and -G search the whole history, past the loaded commits', async () => {
  const dir = join(base, 'search-repo');
  mkdirSync(dir);
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  // 450 commits in one go: the needle goes in with the first and out with the 300th, so the graph's
  // first 400 commits hold only its removal.
  let stream = '';
  const blob = (text) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  for (let i = 1; i <= 450; i++) {
    const subject = i === 1 ? 'Plant the needle' : i === 300 ? 'Pull the needle out' : `Commit ${i}`;
    stream += `commit refs/heads/main\nmark :${i}\ncommitter T <t@example.com> ${1700000000 + i * 60} +0000\n${blob(subject)}`;
    if (i > 1) stream += `from :${i - 1}\n`;
    if (i === 1) stream += `M 100644 inline hay.txt\n${blob('straw\nneedle\nstraw\n')}`;
    else if (i === 300) stream += `M 100644 inline hay.txt\n${blob('straw\nstraw\n')}`;
    else stream += `M 100644 inline counter.txt\n${blob(`${i}\n`)}`;
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input: stream });
  g('reset', '-q', '--hard');

  const app = start(dir);
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Commit 450') && frame().includes('400+'), 'the graph, 400 commits loaded');
    await command(app, 'find -S needle');
    await until(() => frame().includes('Commits adding or removing "needle" (2)'), 'the search results');
    assert.match(frame(), /Pull the needle out/);
    assert.match(frame(), /Plant the needle/);
    assert.doesNotMatch(frame(), /Commit 450/);
    assert.match(frame(), /git log -S "needle" --all/);

    // ↵ opens the patch of the result under the cursor, the newest first.
    app.stdin.write(KEYS.enter);
    await until(() => /│-needle/.test(frame()), 'the patch');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Commits adding or removing "needle" (2)'), 'back to the results');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Commit 450') && !frame().includes('adding or removing'), 'the full graph again');

    await command(app, 'find -G ne+dle');
    await until(() => frame().includes('Commits changing lines that match /ne+dle/ (2)'), 'the regex search');
    await command(app, 'find -S nowhere-to-be-found');
    await until(() => frame().includes('No commit in the history adds or removes it.'), 'an empty search');

    // Plain text still filters the loaded commits by message.
    await command(app, 'find Commit 44');
    // (Commits 440 to 449: Commit 44 itself is older than the loaded 400.)
    await until(() => frame().includes('Commits matching "Commit 44" (10)'), 'the text filter');
  } finally {
    app.unmount();
  }
});
