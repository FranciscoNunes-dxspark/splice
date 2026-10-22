// What a rebase changed: /range-diff against the branch before its last rewrite, driven through the real UI.
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
import { lastRewrite, parseReflog } from '../src/undo.js';
import { rangeDiffSegments } from '../src/ui/diffstyle.js';
import { theme } from '../src/theme.js';

const KEYS = { enter: '\r', esc: '\x1b' };

let base;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-range-'));
  process.env.SPLICE_HOME = join(base, 'home');
});

after(() => removeTemp(base));

let lastApp = null;

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  let failed = null;
  while (Date.now() < end) {
    // A check that runs git can catch Splice mid-rebase: that's "not yet", not a failure.
    try {
      // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
      if (check()) return new Promise((r) => setTimeout(r, 100));
      failed = null;
    } catch (e) {
      failed = e;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}.${failed ? ` Last check: ${failed.message}` : ''} Last frame:\n${lastApp?.lastFrame()}`);
}

const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function command(app, text) {
  app.stdin.write('/');
  await type(app.stdin, text);
  await until(() => app.lastFrame().includes(`/${text}`), `the typed command /${text}`);
  app.stdin.write(KEYS.enter);
}

const entry = (gs, hash = 'a'.repeat(40)) => `${hash}\x1fHEAD@{1760000000}\x1f${gs}\x1fsubject`;

test('the last rewrite in a branch\'s reflog: a rebase finishing, an amend, a reset', () => {
  const onto = 'b'.repeat(40);
  const log = (...lines) => parseReflog(lines.join('\n'));
  assert.deepEqual(lastRewrite(log(entry('commit: More'), entry(`rebase (finish): refs/heads/feat onto ${onto}`), entry('commit: First'))), {
    index: 1,
    entry: log(entry(`rebase (finish): refs/heads/feat onto ${onto}`))[0],
    onto,
  });
  assert.equal(lastRewrite(log(entry(`rebase -i (finish): refs/heads/feat onto ${onto}`))).onto, onto);
  assert.equal(lastRewrite(log(entry(`pull --rebase (finish): refs/heads/feat onto ${onto}`))).onto, onto);
  assert.equal(lastRewrite(log(entry('commit (amend): Better'), entry('commit: Good'))).entry.kind, 'amend');
  assert.equal(lastRewrite(log(entry('commit: x'), entry('reset: moving to HEAD~1'))).index, 1);
  assert.equal(lastRewrite(log(entry('undo: moving to abc'))).entry.kind, 'undo');
  // A fast-forward pull, a merge, plain commits: nothing was rewritten.
  assert.equal(lastRewrite(log(entry('pull: Fast-forward'), entry('merge side: Merge made'), entry('commit: x'), entry('branch: Created from HEAD'))), null);
});

test('range-diff lines are coloured by what happened to each commit, and the diff of diffs by its outer column', () => {
  const color = (l) => rangeDiffSegments(l)[0].color;
  assert.equal(color('1:  dfedcef = 1:  36a47bd feat1'), theme.dim);
  assert.equal(color('2:  d64780f ! 2:  c5383a9 feat2'), theme.warn);
  assert.equal(color('3:  4444444 < -:  ------- Dropped'), theme.del);
  assert.equal(color('-:  ------- > 3:  c5383a9 Added'), theme.add);
  assert.equal(color(' 9:  4444444 = 10:  5555555 Wide numbers'), theme.dim);
  assert.equal(color('    @@ Metadata'), theme.hunk);
  assert.equal(color('    -    feat2'), theme.del);
  assert.equal(color('    ++new line'), theme.add);
  assert.equal(color('    -+old line'), theme.del);
  assert.equal(color('     -context in both'), undefined);
  assert.equal(color('      ## Commit message ##'), theme.dim);
});

test('/range-diff shows what the last rebase did to each commit; after a rebase the activity line offers it', async () => {
  const dir = join(base, 'repo');
  mkdirSync(dir);
  let minute = 0;
  const g = (...args) => {
    const at = `2026-01-01T10:${String(minute).padStart(2, '0')}:00Z`;
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } }).trim();
  };
  const commit = (file, subject, text = `${subject}\n`) => {
    minute++;
    writeFileSync(join(dir, file), text);
    g('add', '.');
    g('commit', '-q', '-m', subject);
  };
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@example.com');
  g('config', 'commit.gpgsign', 'false');
  commit('base.txt', 'Base');
  g('checkout', '-q', '-b', 'feat');
  commit('one.txt', 'Feature one');
  commit('two.txt', 'Feature two');
  g('checkout', '-q', 'main');
  commit('main.txt', 'Upstream change');
  g('checkout', '-q', 'feat');
  // Rebased onto main, then the last commit reworded.
  g('rebase', '-q', 'main');
  minute++;
  g('commit', '-q', '--amend', '-m', 'Feature two, reworded');

  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Feature two'), 'the graph');
    // The last rewrite was the amend: the commit before it and after.
    await command(app, 'range-diff');
    await until(() => frame().includes('feat before its last amend (feat@{1}) and now'), 'the range-diff of the amend');
    await until(() => /1: +[0-9a-f]{7} ! 1: +[0-9a-f]{7} Feature two/.test(frame()), 'the commit, changed');
    assert.match(frame(), /-\s+Feature two\s/);
    assert.match(frame(), /\+\s+Feature two, reworded/);
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('and now'), 'the viewer closed');

    // Two versions given: compared as they are.
    await command(app, 'range-diff feat@{2} feat');
    await until(() => frame().includes('git range-diff feat@{2}...feat') && /Upstream change/.test(frame()), 'the range-diff of the two versions');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('git range-diff'), 'the viewer closed');

    // A rebase made here: the activity line says what shows its effect. Then only the rebase's own commits
    // are compared, not the ones it rebased over.
    g('checkout', '-q', 'main');
    commit('more.txt', 'More upstream');
    g('checkout', '-q', 'feat');
    await until(() => frame().includes('More upstream'), 'the graph again');
    await command(app, 'rebase main');
    await until(() => frame().includes('Rebase feat onto main?'), 'the question');
    app.stdin.write('1');
    await until(() => frame().includes('feat is rewritten. /range-diff shows what changed in each commit.'), 'the hint');
    await command(app, 'range-diff');
    await until(() => frame().includes('feat before its last rebase (feat@{1}) and now'), 'the range-diff of the rebase');
    await until(() => /1: +[0-9a-f]{7} = 1: +[0-9a-f]{7} Feature one/.test(frame()) && /2: +[0-9a-f]{7} = 2: +[0-9a-f]{7} Feature two, reworded/.test(frame()), 'the commits');
    assert.ok(!frame().includes('More upstream'));
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('and now'), 'the viewer closed');

    await command(app, 'range-diff nowhere');
    await until(() => frame().includes("nowhere isn't a local branch"), 'a branch that is not there');
  } finally {
    app.unmount();
  }
});
