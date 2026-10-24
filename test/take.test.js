// /take: what the sibling apps copy for Splice (an exception, a file, a commit), and /blame <path>:<line>.
// The pure parts, then through the real UI against a throwaway repository.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { removeTemp } from './temp.js';
import { contextIn, encodeContext, takeLine } from '../src/family.js';
import { TAKES, exceptionFrames, framesInRepo, pathAndLine } from '../src/take.js';
import { App } from '../src/ui/App.jsx';

test('frames matched to the checkout, top first, each file and line once', () => {
  const files = ['src/orders.js', 'src/pay.js', 'README.md'];
  const frames = exceptionFrames({ stack: 'Error: no\n    at place (/app/src/orders.js:3:9)\n    at /app/node_modules/x/y.js:1:1\n    at pay (/app/src/pay.js:2:1)\n    at place (/app/src/orders.js:3:9)' });
  assert.deepEqual(framesInRepo(frames, files).map((f) => [f.path, f.line]), [['src/orders.js', 3], ['src/pay.js', 2]]);
  assert.deepEqual(exceptionFrames({ frames: [{ file: 'D:\\a\\src\\pay.js', line: 4, method: 'Pay' }] }).length, 1);
  assert.deepEqual(framesInRepo([{ file: '/elsewhere/other.go', line: 1 }], files), []);
});

test('a path and a line, as /blame takes them', () => {
  assert.deepEqual(pathAndLine('src/a.js:42'), { path: 'src/a.js', line: 42 });
  assert.deepEqual(pathAndLine('src/a.js:42:7'), { path: 'src/a.js', line: 42 });
  assert.deepEqual(pathAndLine('src/a.js#L9'), { path: 'src/a.js', line: 9 });
  assert.deepEqual(pathAndLine('src/a.js'), { path: 'src/a.js', line: null });
  assert.deepEqual(pathAndLine('C:12'), { path: 'C:12', line: null });
  assert.deepEqual(pathAndLine('C:\\x\\a.js:3'), { path: 'C:\\x\\a.js', line: 3 });
});

test('the kinds Splice takes, as the family says', () => {
  assert.deepEqual(TAKES, ['exception', 'commit', 'file']);
});

let base;
let dir;
let lastApp = null;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-take-'));
  dir = join(base, 'shop');
  mkdirSync(join(dir, 'src'), { recursive: true });
  process.env.SPLICE_HOME = join(base, 'home');
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'src', 'orders.js'), 'one\ntwo\nthree\nfour\n');
  writeFileSync(join(dir, 'src', 'pay.js'), 'pay one\npay two\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Add the shop');
  writeFileSync(join(dir, 'src', 'orders.js'), 'one\ntwo\nthree, better\nfour\n');
  git('commit', '-q', '-am', 'Better third line');
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

/** Types a command line into the prompt (the text in one go, as a paste into it would come) and runs it. */
async function command(app, text) {
  app.stdin.write('/');
  await until(() => app.lastFrame().includes('> /'), 'the prompt');
  app.stdin.write(text.replace(/^\//, ''));
  await new Promise((r) => setTimeout(r, 60));
  app.stdin.write('\r');
}

const flat = (s) => s.replace(/\s+/g, ' ');

test('/take: an exception opens blame at its frame, a file at its line, a commit its diff; other kinds say whose they are', async () => {
  const copied = [];
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] }, copy: (t) => copied.push(t) }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const esc = async (what) => {
    app.stdin.write('\x1b');
    await until(() => !frame().includes(what), `${what} closed`);
  };
  try {
    await until(() => frame().includes('Better third line'), 'the graph');

    // One frame in the repository (the node_modules one never counts): blame there, the cursor on its line.
    const one = { app: 'shop-api', type: 'TypeError', message: 'x is undefined', frames: [{ file: '/srv/app/node_modules/express/router.js', line: 1 }, { file: '/srv/app/src/orders.js', line: 3, method: 'place' }] };
    await command(app, takeLine('exception', one));
    await until(() => frame().includes('Blame src/orders.js, line 3'), 'blame at the frame');
    assert.match(frame(), /❯.*3 │ three, better/);
    await esc('Blame src/orders.js');

    // Two: a list, top frame first; ↵ blames the picked one.
    const two = { ...one, frames: [{ file: 'C:\\build\\src\\pay.js', line: 2, method: 'charge' }, { file: '/srv/app/src/orders.js', line: 3, method: 'place' }] };
    await command(app, `take ${encodeContext('exception', two)}`);
    // The list itself, not its title: "Taking exception TypeError: x is undefined" is already in the log.
    await until(() => /❯\s+1 src\/pay\.js:2\s+charge/.test(frame()), 'the frames');
    assert.match(frame(), /2 src\/orders\.js:3\s+place/);
    app.stdin.write('\r');
    await until(() => frame().includes('Blame src/pay.js, line 2'), 'blame of the picked frame');
    assert.match(frame(), /❯.*2 │ pay two/);
    await esc('Blame src/pay.js');
    await esc('TypeError');

    // A file with a line, and one without (its history); the bare context typed at the prompt works too.
    await command(app, encodeContext('file', { path: join(dir, 'src', 'orders.js'), line: 2 }));
    await until(() => frame().includes('Blame src/orders.js, line 2'), 'blame of the file');
    await esc('Blame src/orders.js');
    await command(app, takeLine('file', { path: 'src/orders.js' }));
    await until(() => frame().includes('History of src/orders.js'), 'the history');
    await esc('History of');

    // A commit that's here: its diff. One that isn't: offered a fetch (no remotes here, so it says so).
    const hash = git('rev-parse', 'HEAD~1');
    await command(app, takeLine('commit', { hash: hash.slice(0, 10), subject: 'Add the shop' }));
    await until(() => frame().includes(`${hash.slice(0, 7)} Add the shop`) && frame().includes('src/pay.js    | 2 ++'), 'the commit diff');
    await esc('src/pay.js    | 2 ++');
    await command(app, takeLine('commit', { hash: 'f'.repeat(40), repo: 'elsewhere' }));
    await until(() => flat(frame()).includes("fffffff isn't in shop (it came from elsewhere), and it has no remote"), 'missing commit');

    await command(app, takeLine('request', { method: 'GET', url: 'http://x' }));
    await until(() => flat(frame()).includes('for Hail: paste it into its prompt instead'), 'the request is for Hail');

    // /blame with a line.
    await command(app, 'blame src/orders.js:4');
    await until(() => frame().includes('Blame src/orders.js, line 4'), '/blame path:line');
    assert.match(frame(), /❯.*4 │ four/);

    // Y hands the line on, and in the graph the commit (for Sonar).
    app.stdin.write('Y');
    await until(() => copied.length === 1, 'the line copied');
    assert.deepEqual(contextIn(copied[0]), { kind: 'file', data: { path: 'src/orders.js', line: 4 } });
    assert.match(flat(frame()), /Copied for Splice: paste it into Splice's prompt\. src\/orders\.js:4/);
    await esc('Blame src/orders.js');
    app.stdin.write('Y');
    await until(() => copied.length === 2, 'the commit copied');
    assert.deepEqual(contextIn(copied[1]), { kind: 'commit', data: { repo: 'shop', hash: git('rev-parse', 'HEAD'), subject: 'Better third line' } });
    assert.match(flat(frame()), /Copied for Sonar: paste it into Sonar's prompt\. commit [0-9a-f]{10} Better third line/);
  } finally {
    app.unmount();
  }
});
