// Risk before push (/risk, and P when it's high): reading git's output and scoring it (pure), then
// through the real UI against a throwaway repository with a bare one as its remote.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { isSource, isTest, parseRiskLog, riskText, scoreRisk } from '../src/risk.js';
import { App } from '../src/ui/App.jsx';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('the log: each commit with its files, their blobs and line counts', () => {
  const raw = [
    `\x1e${'1'.repeat(40)}\x1fMe@Example.com\x1fTwo`,
    '',
    `:100644 100644 ${A} ${B} M\tsrc/a.js`,
    `:100644 000000 ${A} ${'0'.repeat(40)} D\tlogo.png`,
    '2\t1\tsrc/a.js',
    '-\t-\tlogo.png',
    `\x1e${'2'.repeat(40)}\x1fana@example.com\x1fOne`,
    '',
    '5\t0\tsrc/a.js',
    '',
  ].join('\n');
  const log = parseRiskLog(raw);
  assert.deepEqual(log.map((c) => [c.email, c.subject, c.files.map((f) => [f.path, f.added, f.deleted, f.binary, f.blob?.[0] ?? null])]), [
    ['me@example.com', 'Two', [['src/a.js', 2, 1, false, 'b'], ['logo.png', 0, 0, true, null]]],
    ['ana@example.com', 'One', [['src/a.js', 5, 0, false, null]]],
  ]);
});

test('tests and source, by their paths', () => {
  for (const p of ['test/a.test.js', 'src/__tests__/x.js', 'pkg/a_test.go', 'app/test_views.py', 'Shop.Tests/OrderTests.cs', 'src/a.spec.ts']) assert.equal(isTest(p), true, p);
  for (const p of ['src/a.js', 'main.go', 'Shop/Order.cs', 'contest.py']) assert.equal(isTest(p), false, p);
  assert.equal(isSource('src/a.tsx'), true);
  assert.equal(isSource('README.md'), false);
  assert.equal(isSource('test/a.test.js'), false);
});

test('the score: small and tested is low; big, busy, someone else\'s and untested is high', () => {
  const me = 'me@x';
  const commit = (hash, email, files) => ({ hash, email, subject: '', files: files.map(([path, added, deleted = 0, blob = B]) => ({ path, added, deleted, binary: false, blob })) });
  const low = scoreRisk({ outgoing: [commit('1', me, [['src/a.js', 10], ['test/a.test.js', 5]])], history: [commit('9', me, [['src/a.js', 1]])] });
  assert.deepEqual([low.level, low.score, low.reasons], ['low', 0, []]);
  const history = Array.from({ length: 12 }, (_, i) => commit(`h${i}`, i % 2 ? 'ana@x' : 'bo@x', [['src/hot.js', 3]]));
  const high = scoreRisk({ outgoing: [commit('1', me, [['src/hot.js', 900, 200], ['big.bin', 1, 0, A]])], history: [...history, commit('1', me, [['src/hot.js', 1]])], sizes: new Map([[A, 5 * 1024 * 1024]]) });
  assert.equal(high.level, 'high');
  const text = riskText(high);
  assert.match(text, /\+3 {2}1101 lines changed/);
  assert.match(text, /src\/hot\.js \(12 commits in 90 days\)/, 'the commit being pushed left out');
  assert.match(text, /Only others changed this file recently: src\/hot\.js \(bo@x, ana@x\)/);
  assert.match(text, /Source changed with no test changed alongside: src\/hot\.js/);
  assert.match(text, /big\.bin \(5\.0 MB\)/);
  assert.equal(scoreRisk({ outgoing: [commit('1', me, [['src/a.js', 200]])] }).level, 'medium');
});

let base;
let dir;
let origin;
let lastApp = null;
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
const git = (...args) => run(dir, ...args);

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-risk-'));
  dir = join(base, 'repo');
  origin = join(base, 'origin.git');
  mkdirSync(join(dir, 'src'), { recursive: true });
  process.env.SPLICE_HOME = join(base, 'home');
  run(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  // A file that others change all the time.
  for (let i = 0; i < 11; i++) {
    writeFileSync(join(dir, 'src', 'hot.js'), `// version ${i}\n`);
    git('add', '.');
    git('-c', 'user.email=ana@example.com', '-c', 'user.name=Ana', 'commit', '-q', '-m', `Hot change ${i}`);
  }
  git('remote', 'add', 'origin', origin);
  git('push', '-q', '-u', 'origin', 'main');
  // Yours: 500 lines into it, and no test.
  writeFileSync(join(dir, 'src', 'hot.js'), Array.from({ length: 500 }, (_, i) => `export const x${i} = ${i};`).join('\n'));
  git('commit', '-q', '-am', 'Rewrite the hot file');
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

const flat = (s) => s.replace(/\s+/g, ' ');

test('/risk says why; P stops on a high score until you say yes', async () => {
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Rewrite the hot file'), 'the graph');
    app.stdin.write('/');
    await until(() => frame().includes('> /'), 'the prompt');
    app.stdin.write('risk');
    await until(() => frame().includes('> /risk'), 'typed');
    app.stdin.write('\r');
    await until(() => frame().includes('Risk before push: high'), 'the score');
    assert.match(flat(frame()), /Risk high \(6\): 1 commit, 1 file, 501 lines/);
    assert.match(flat(frame()), /Only others changed this file recently: src\/hot\.js \(ana@example\.com\)/);
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Risk before push'), 'closed');

    app.stdin.write('P');
    await until(() => frame().includes('Push anyway? The risk is high (6)'), 'the question');
    assert.match(frame(), /Before pushing: the risk is high/);
    app.stdin.write('2');
    await until(() => !frame().includes('Push anyway?'), 'answered no');
    await new Promise((r) => setTimeout(r, 300));
    assert.notEqual(run(origin, 'rev-parse', 'main'), git('rev-parse', 'HEAD'), 'not pushed');

    app.stdin.write('P');
    await until(() => frame().includes('Push anyway? The risk is high'), 'asked again');
    app.stdin.write('1');
    await until(() => run(origin, 'rev-parse', 'main') === git('rev-parse', 'HEAD'), 'pushed');
  } finally {
    app.unmount();
  }
});
